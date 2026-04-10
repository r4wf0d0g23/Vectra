/**
 * Threshold Optimizer — self-tuning loop for ESP parameters.
 *
 * Implements a grid search over tunable parameters with 6 autonomous circuit
 * breakers replacing all human oversight gates. Runs after every N new
 * calibration pairs are added to the store.
 *
 * Circuit breakers:
 *   CB-1: Post-update holdout validation (auto-rollback on regression)
 *   CB-2: Oscillation freeze (freeze params that oscillate direction)
 *   CB-3: Pearson r guard (block weight updates if r < 0.4)
 *   CB-4: Band coverage lock (freeze thresholds for bands with <5 pairs)
 *   CB-5: Confidence floor (write proposal log until ≥pilot confidence)
 *   CB-6: Safe harbor activation (trigger if >3 rollbacks in 5 cycles)
 *
 * @see docs/recursive-self-improvement-spec.md §E–J
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CalibrationPair,
  ESPParams,
  CircuitBreakerState,
  OscillationState,
  ProposalEntry,
  OptimizerResult,
  OptimizerRunRecord,
  CalibrationStoreData,
} from './types.js';
import {
  SAFE_HARBOR_PARAMS,
  PARAM_BOUNDS,
  computeConfidenceTier,
} from './types.js';
import {
  loadCalibrationStore,
  computeBandCounts,
} from './calibration-store.js';
import {
  loadESPParams,
  saveESPParams,
  rollbackESPParams,
  loadSafeHarborParams,
  applyToCompatibilityTs,
} from './esp-params.js';

// ─── Paths ───────────────────────────────────────────────────────────

const DEFAULT_CB_STATE_PATH = 'data/circuit-breaker-state.json';
const DEFAULT_RUN_HISTORY_PATH = 'data/optimizer-run-history.json';

// ─── Math utilities ──────────────────────────────────────────────────

/**
 * Pearson correlation coefficient between two arrays of equal length.
 */
export function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
  const den = Math.sqrt(
    xs.reduce((s, x) => s + (x - mx) ** 2, 0) *
    ys.reduce((s, y) => s + (y - my) ** 2, 0),
  );
  return den === 0 ? NaN : num / den;
}

/**
 * Asymmetric loss function: FP penalty 2×, FN penalty 1×.
 * FP = predicted divergent when actually compatible
 * FN = predicted compatible when actually divergent
 */
export function asymmetricLoss(pairs: CalibrationPair[], params: ESPParams): number {
  if (pairs.length === 0) return 0;
  let loss = 0;
  for (const pair of pairs) {
    const risk = 1 - (params.wJaccard * pair.jaccardAtK3 + (1 - params.wJaccard) * pair.kendallTauAtK10);
    const predictedDivergent = risk > params.tHighRisk;
    if (predictedDivergent && !pair.actuallyDivergent) loss += 2; // FP
    if (!predictedDivergent && pair.actuallyDivergent) loss += 1;  // FN
  }
  return loss / pairs.length;
}

/**
 * Deterministic 80/20 train/holdout split by pair.id hash.
 * Uses first 4 hex chars of id → mod 5 → holdout if 0.
 */
export function splitTrainHoldout(
  pairs: CalibrationPair[],
  holdoutFraction: number = 0.2,
): { train: CalibrationPair[]; holdout: CalibrationPair[] } {
  const buckets = Math.round(1 / holdoutFraction);
  const train: CalibrationPair[] = [];
  const holdout: CalibrationPair[] = [];
  for (const pair of pairs) {
    const bucket = parseInt(pair.id.slice(0, 4), 16) % buckets;
    if (bucket === 0) holdout.push(pair);
    else train.push(pair);
  }
  // Ensure holdout has at least 1 sample if possible
  if (holdout.length === 0 && pairs.length > 1) {
    holdout.push(train.pop()!);
  }
  return { train, holdout };
}

// ─── Circuit breaker state I/O ────────────────────────────────────────

function defaultCBState(): CircuitBreakerState {
  return {
    cb1Rollbacks: 0,
    cb2Oscillations: [],
    cb3ConsecutiveLowR: 0,
    cb3WeightBlockedUntilNewPairs: 0,
    cb5ProposalLog: [],
    cb6SafeHarborActive: false,
    cb6PairsAddedSinceSafeHarbor: 0,
    cb6RecoveryThreshold: 10,
    rollbacksInLast5Cycles: 0,
    degradedState: false,
    outlierPairIds: [],
  };
}

export function loadCBState(statePath: string = DEFAULT_CB_STATE_PATH): CircuitBreakerState {
  if (!existsSync(statePath)) {
    const def = defaultCBState();
    saveCBState(def, statePath);
    return def;
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as CircuitBreakerState;
  } catch {
    return defaultCBState();
  }
}

export function saveCBState(state: CircuitBreakerState, statePath: string = DEFAULT_CB_STATE_PATH): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = statePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, statePath);
}

// ─── Optimizer run history I/O ────────────────────────────────────────

function loadRunHistory(historyPath: string = DEFAULT_RUN_HISTORY_PATH): OptimizerRunRecord[] {
  if (!existsSync(historyPath)) return [];
  try {
    return JSON.parse(readFileSync(historyPath, 'utf-8')) as OptimizerRunRecord[];
  } catch {
    return [];
  }
}

function appendRunHistory(record: OptimizerRunRecord, historyPath: string = DEFAULT_RUN_HISTORY_PATH): void {
  const dir = dirname(historyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const history = loadRunHistory(historyPath);
  history.push(record);
  // Keep last 100 records
  if (history.length > 100) history.splice(0, history.length - 100);
  const tmpPath = historyPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(history, null, 2), 'utf-8');
  renameSync(tmpPath, historyPath);
}

// ─── Grid Search ─────────────────────────────────────────────────────

/**
 * Grid search over all parameter combinations within bounds.
 * Respects CB-2 frozen params and CB-4 band coverage locks.
 * MAX_PARAM_SHIFT: no candidate param more than 0.15 from current.
 */
export function gridSearch(
  trainPairs: CalibrationPair[],
  currentParams: ESPParams,
  frozenFromCB2: Set<keyof ESPParams>,
  frozenFromCB4: Set<keyof ESPParams>,
): { bestParams: ESPParams; bestLoss: number } {
  const MAX_SHIFT = 0.15;

  let bestParams = { ...currentParams };
  let bestLoss = asymmetricLoss(trainPairs, currentParams);

  // Build ranges for each param
  function range(key: keyof ESPParams): number[] {
    if (frozenFromCB2.has(key) || frozenFromCB4.has(key)) {
      return [currentParams[key]];
    }
    const b = PARAM_BOUNDS[key];
    const vals: number[] = [];
    for (let v = b.min; v <= b.max + 1e-9; v = Math.round((v + b.step) * 1000) / 1000) {
      if (Math.abs(v - currentParams[key]) <= MAX_SHIFT + 1e-9) {
        vals.push(v);
      }
    }
    // Always include current value
    if (!vals.includes(currentParams[key])) vals.push(currentParams[key]);
    return vals;
  }

  if (trainPairs.length === 0) {
    return { bestParams, bestLoss };
  }

  const wJaccardVals = range('wJaccard');
  const tTransparentVals = range('tTransparent');
  const tHighRiskVals = range('tHighRisk');
  const tRejectVals = range('tReject');

  for (const wJ of wJaccardVals) {
    for (const tT of tTransparentVals) {
      for (const tH of tHighRiskVals) {
        for (const tR of tRejectVals) {
          // Constraint: tReject > tHighRisk + 0.1
          if (tR <= tH + 0.1) continue;
          // Constraint: tTransparent < tHighRisk
          if (tT >= tH) continue;

          const candidate: ESPParams = {
            wJaccard: wJ,
            tTransparent: tT,
            tHighRisk: tH,
            tReject: tR,
          };

          const loss = asymmetricLoss(trainPairs, candidate);
          if (loss < bestLoss - 1e-9) {
            bestLoss = loss;
            bestParams = candidate;
          }
        }
      }
    }
  }

  return { bestParams, bestLoss };
}

// ─── Circuit Breakers ─────────────────────────────────────────────────

/**
 * CB-1: Post-update holdout validation.
 * New params must not increase holdout loss.
 */
function runCircuitBreaker1(
  holdout: CalibrationPair[],
  currentParams: ESPParams,
  newParams: ESPParams,
): { passed: boolean; reason: string; oldLoss: number; newLoss: number } {
  const oldLoss = asymmetricLoss(holdout, currentParams);
  const newLoss = asymmetricLoss(holdout, newParams);
  if (newLoss > oldLoss + 1e-9) {
    return {
      passed: false,
      reason: `CB-1: holdout loss regression (${newLoss.toFixed(4)} > ${oldLoss.toFixed(4)})`,
      oldLoss,
      newLoss,
    };
  }
  return { passed: true, reason: 'CB-1: holdout loss ok', oldLoss, newLoss };
}

/**
 * CB-2: Oscillation freeze.
 * If a param changes direction twice in a row → freeze for 3 cycles.
 */
function runCircuitBreaker2(
  newParams: ESPParams,
  currentParams: ESPParams,
  cbState: CircuitBreakerState,
): { updatedOscillations: OscillationState[]; frozenParams: Set<keyof ESPParams> } {
  const keys: (keyof ESPParams)[] = ['wJaccard', 'tTransparent', 'tHighRisk', 'tReject'];
  const frozenParams = new Set<keyof ESPParams>();
  const updatedOscillations: OscillationState[] = [];

  for (const key of keys) {
    const delta = newParams[key] - currentParams[key];
    const direction: '+' | '-' | '0' = delta > 1e-9 ? '+' : delta < -1e-9 ? '-' : '0';

    const existing = cbState.cb2Oscillations.find(o => o.paramId === key);

    if (!existing) {
      updatedOscillations.push({
        paramId: key,
        lastDirection: direction,
        freezeRemainingCycles: 0,
        permanentMinPairsMultiplier: 1.0,
      });
      continue;
    }

    // If still frozen, keep frozen and decrement
    if (existing.freezeRemainingCycles > 0) {
      frozenParams.add(key);
      updatedOscillations.push({
        ...existing,
        freezeRemainingCycles: existing.freezeRemainingCycles - 1,
      });
      continue;
    }

    // Check for oscillation: direction changed and neither is '0'
    const oscillating =
      direction !== '0' &&
      existing.lastDirection !== '0' &&
      direction !== existing.lastDirection;

    if (oscillating) {
      const newMultiplier = Math.min(
        existing.permanentMinPairsMultiplier < 1.1 ? 1.5 : 2.0,
        2.0,
      );
      frozenParams.add(key);
      updatedOscillations.push({
        paramId: key,
        lastDirection: direction,
        freezeRemainingCycles: 3,
        permanentMinPairsMultiplier: newMultiplier,
      });
    } else {
      updatedOscillations.push({
        ...existing,
        lastDirection: direction,
      });
    }
  }

  return { updatedOscillations, frozenParams };
}

/**
 * CB-3: Pearson r guard.
 * Blocks weight (wJaccard) updates if correlation between architectureDistance
 * and retrievalOverlapRisk is too low, indicating geometry doesn't predict retrieval.
 */
function runCircuitBreaker3(
  allPairs: CalibrationPair[],
  cbState: CircuitBreakerState,
  storePairCount: number,
): { passed: boolean; r: number; degraded: boolean; reason: string } {
  if (allPairs.length < 3) {
    return { passed: true, r: NaN, degraded: false, reason: 'CB-3: insufficient pairs for r check' };
  }

  const xs = allPairs.map(p => p.architectureDistance);
  const ys = allPairs.map(p => p.retrievalOverlapRisk);
  const r = pearsonR(xs, ys);

  if (isNaN(r)) {
    return { passed: true, r: NaN, degraded: false, reason: 'CB-3: r is NaN — skip check' };
  }

  if (r < 0.3 && cbState.cb3ConsecutiveLowR >= 1) {
    return {
      passed: false,
      r,
      degraded: true,
      reason: `CB-3: r=${r.toFixed(4)} < 0.3, consecutive low r >= 1 — geometric approach degraded`,
    };
  }

  if (r < 0.4) {
    return {
      passed: false,
      r,
      degraded: false,
      reason: `CB-3: r=${r.toFixed(4)} < 0.4 — weight update blocked`,
    };
  }

  return { passed: true, r, degraded: false, reason: `CB-3: r=${r.toFixed(4)} ok` };
}

/**
 * CB-4: Band coverage lock.
 * Freezes threshold params for bands that don't have enough pairs.
 */
function runCircuitBreaker4(
  bandCounts: CalibrationStoreData['bandCounts'],
  cbState: CircuitBreakerState,
  totalCrossFamily: number,
): Set<keyof ESPParams> {
  const frozen = new Set<keyof ESPParams>();
  const minBandPairs = 5;

  // tTransparent frozen if transparent band < 5 pairs
  if (bandCounts.transparent < minBandPairs) frozen.add('tTransparent');

  // tHighRisk frozen if high-risk band < 5 pairs
  if (bandCounts['high-risk'] < minBandPairs) frozen.add('tHighRisk');

  // tReject frozen if reject band < 5 pairs
  if (bandCounts.reject < minBandPairs) frozen.add('tReject');

  // wJaccard frozen if fewer than 10 cross-family pairs
  if (totalCrossFamily < 10) frozen.add('wJaccard');

  return frozen;
}

/**
 * CB-5: Confidence floor.
 * Blocks application if confidence is uncalibrated; writes to proposal log instead.
 */
function runCircuitBreaker5(
  confidence: ReturnType<typeof computeConfidenceTier>,
): { canApply: boolean; reason: string } {
  if (confidence === 'uncalibrated') {
    return { canApply: false, reason: 'CB-5: uncalibrated — writing to proposal log' };
  }
  return { canApply: true, reason: `CB-5: confidence=${confidence} — can apply` };
}

/**
 * CB-6: Safe harbor activation check.
 * Triggers safe harbor if Pearson r is degraded or too many rollbacks.
 */
function runCircuitBreaker6(
  cbState: CircuitBreakerState,
  degraded: boolean,
): { triggerSafeHarbor: boolean; reason: string } {
  if (degraded) {
    return { triggerSafeHarbor: true, reason: 'CB-6: geometric approach degraded (CB-3)' };
  }
  if (cbState.rollbacksInLast5Cycles > 3) {
    return { triggerSafeHarbor: true, reason: `CB-6: ${cbState.rollbacksInLast5Cycles} rollbacks in last 5 cycles` };
  }
  return { triggerSafeHarbor: false, reason: 'CB-6: ok' };
}

// ─── Safe Harbor Activation ───────────────────────────────────────────

/**
 * Activate safe harbor: revert params, reset CB state, mark degraded.
 */
function activateSafeHarbor(
  cbState: CircuitBreakerState,
  storePairCount: number,
  paramsPath?: string,
  cbStatePath?: string,
): void {
  const safe = loadSafeHarborParams();
  saveESPParams(safe, { calibrationPairs: storePairCount, confidence: 'uncalibrated', reason: 'safe-harbor-activation' }, paramsPath);
  applyToCompatibilityTs(safe);

  const reset: CircuitBreakerState = {
    cb1Rollbacks: 0,
    cb2Oscillations: [],
    cb3ConsecutiveLowR: 0,
    cb3WeightBlockedUntilNewPairs: 0,
    cb5ProposalLog: [],
    cb6SafeHarborActive: true,
    cb6PairsAddedSinceSafeHarbor: 0,
    cb6RecoveryThreshold: 10,
    rollbacksInLast5Cycles: 0,
    degradedState: true,
    outlierPairIds: cbState.outlierPairIds,
  };
  saveCBState(reset, cbStatePath);
}

// ─── Meta-Loop Checks ────────────────────────────────────────────────

/**
 * After each optimizer cycle, update meta-parameters based on signals.
 */
function runMetaLoopChecks(
  record: OptimizerRunRecord,
  recentHistory: OptimizerRunRecord[],
  cbState: CircuitBreakerState,
): Partial<CircuitBreakerState> {
  const updates: Partial<CircuitBreakerState> = {};

  if (recentHistory.length < 2) return updates;

  // Signal 2: >40% rollback rate → nothing to update in cbState directly
  // (trigger count adjustment would be in tuning-state.md meta-params)

  // Signal 3: oscillation → CB-2 (handled in cb2 already)

  // Decay rollbacks in last 5 cycles counter
  const last5 = recentHistory.slice(-5);
  const rollbackCount = last5.filter(r => !r.applied).length;
  updates.rollbacksInLast5Cycles = rollbackCount;

  return updates;
}

// ─── Main Optimizer Entry Point ───────────────────────────────────────

/**
 * Run one optimizer cycle.
 * Loads calibration store and params, runs grid search, applies circuit breakers,
 * and either applies new params or writes a proposal.
 */
export async function runOptimizer(
  storePath?: string,
  paramsPath?: string,
  cbStatePath?: string,
  historyPath?: string,
): Promise<OptimizerResult> {
  const triggeredCBs: string[] = [];

  // 1. Load calibration store
  const store = loadCalibrationStore(storePath);
  const activePairs = store.pairs.filter(p => !p.isOutlier);

  // 2. Load current params
  const currentParams = loadESPParams(paramsPath);

  // 3. Load circuit breaker state
  const cbState = loadCBState(cbStatePath);

  // CB-6: Check safe harbor — abort if active and not enough new pairs
  if (cbState.cb6SafeHarborActive) {
    if (cbState.cb6PairsAddedSinceSafeHarbor < cbState.cb6RecoveryThreshold) {
      triggeredCBs.push('CB-6-active');
      return {
        action: 'no-update',
        reason: `CB-6: safe harbor active, need ${cbState.cb6RecoveryThreshold - cbState.cb6PairsAddedSinceSafeHarbor} more pairs`,
        previousParams: currentParams,
        newParams: null,
        trainLoss: 0,
        holdoutLoss: 0,
        pairCount: activePairs.length,
        pearsonR: NaN,
        circuitBreakersTriggered: triggeredCBs,
      };
    }
    // Recovery threshold reached — deactivate safe harbor
    cbState.cb6SafeHarborActive = false;
    cbState.cb6PairsAddedSinceSafeHarbor = 0;
    cbState.degradedState = false;
  }

  if (activePairs.length === 0) {
    return {
      action: 'no-update',
      reason: 'no active calibration pairs',
      previousParams: currentParams,
      newParams: null,
      trainLoss: 0,
      holdoutLoss: 0,
      pairCount: 0,
      pearsonR: NaN,
      circuitBreakersTriggered: triggeredCBs,
    };
  }

  // 4. Compute confidence tier
  const confidence = computeConfidenceTier(activePairs.length, store.bandCounts);

  // 5. CB-5: confidence floor check
  const cb5 = runCircuitBreaker5(confidence);

  // 6. CB-4: band coverage lock — which params are frozen?
  const crossFamilyCount = activePairs.filter(p => p.modelA !== p.modelB).length;
  const frozenCB4 = runCircuitBreaker4(store.bandCounts, cbState, crossFamilyCount);
  if (frozenCB4.size > 0) {
    triggeredCBs.push(`CB-4(frozen:${Array.from(frozenCB4).join(',')})`);
  }

  // 7. CB-2: get currently frozen params from oscillation state
  const frozenCB2 = new Set<keyof ESPParams>(
    cbState.cb2Oscillations
      .filter(o => o.freezeRemainingCycles > 0)
      .map(o => o.paramId),
  );
  if (frozenCB2.size > 0) {
    triggeredCBs.push(`CB-2(frozen:${Array.from(frozenCB2).join(',')})`);
  }

  // 8. Split 80/20 train/holdout
  const { train, holdout } = splitTrainHoldout(activePairs, 0.2);

  // 9. Grid search (respecting frozen params from CB-2 and CB-4)
  const allFrozen = new Set<keyof ESPParams>([...frozenCB2, ...frozenCB4]);
  const { bestParams, bestLoss: trainLoss } = gridSearch(train, currentParams, frozenCB2, frozenCB4);

  // 10. CB-3: Pearson r check (only if wJaccard changed)
  let pearsonRValue = NaN;
  let cb3Degraded = false;
  if (bestParams.wJaccard !== currentParams.wJaccard && !allFrozen.has('wJaccard')) {
    const cb3 = runCircuitBreaker3(activePairs, cbState, activePairs.length);
    pearsonRValue = cb3.r;
    if (!cb3.passed) {
      triggeredCBs.push('CB-3');
      const newCBState: CircuitBreakerState = {
        ...cbState,
        cb3ConsecutiveLowR: cbState.cb3ConsecutiveLowR + 1,
        cb3WeightBlockedUntilNewPairs: activePairs.length + 5,
      };

      if (cb3.degraded) {
        cb3Degraded = true;
        triggeredCBs.push('CB-3-degraded');
        // CB-6 trigger
        activateSafeHarbor(newCBState, activePairs.length, paramsPath, cbStatePath);
        return {
          action: 'safe-harbor',
          reason: cb3.reason,
          previousParams: currentParams,
          newParams: loadSafeHarborParams(),
          trainLoss,
          holdoutLoss: asymmetricLoss(holdout, bestParams),
          pairCount: activePairs.length,
          pearsonR: pearsonRValue,
          circuitBreakersTriggered: triggeredCBs,
        };
      }

      saveCBState(newCBState, cbStatePath);
      return {
        action: 'rollback',
        reason: cb3.reason,
        previousParams: currentParams,
        newParams: null,
        trainLoss,
        holdoutLoss: asymmetricLoss(holdout, bestParams),
        pairCount: activePairs.length,
        pearsonR: pearsonRValue,
        circuitBreakersTriggered: triggeredCBs,
      };
    } else {
      // r is good — reset consecutive counter
      cbState.cb3ConsecutiveLowR = 0;
    }
  }

  // 11. Compute holdout loss
  const holdoutLoss = asymmetricLoss(holdout, bestParams);

  // 12. CB-1: holdout validation
  const cb1 = runCircuitBreaker1(holdout, currentParams, bestParams);
  if (!cb1.passed) {
    triggeredCBs.push('CB-1');
    const updatedCBState: CircuitBreakerState = {
      ...cbState,
      cb1Rollbacks: cbState.cb1Rollbacks + 1,
      rollbacksInLast5Cycles: cbState.rollbacksInLast5Cycles + 1,
    };
    saveCBState(updatedCBState, cbStatePath);

    const histRecord: OptimizerRunRecord = {
      runAt: new Date().toISOString(),
      cycleNumber: loadRunHistory(historyPath).length + 1,
      pairsUsed: activePairs.length,
      trainLoss,
      holdoutLoss,
      proposedParams: bestParams,
      applied: false,
      rollbackReason: cb1.reason,
      circuitBreakersTriggered: triggeredCBs,
    };
    appendRunHistory(histRecord, historyPath);

    return {
      action: 'rollback',
      reason: cb1.reason,
      previousParams: currentParams,
      newParams: null,
      trainLoss,
      holdoutLoss,
      pairCount: activePairs.length,
      pearsonR: pearsonRValue,
      circuitBreakersTriggered: triggeredCBs,
    };
  }

  // 13. CB-6: rollback rate check
  const cb6 = runCircuitBreaker6(cbState, cb3Degraded);
  if (cb6.triggerSafeHarbor) {
    triggeredCBs.push('CB-6');
    activateSafeHarbor(cbState, activePairs.length, paramsPath, cbStatePath);
    return {
      action: 'safe-harbor',
      reason: cb6.reason,
      previousParams: currentParams,
      newParams: loadSafeHarborParams(),
      trainLoss,
      holdoutLoss,
      pairCount: activePairs.length,
      pearsonR: pearsonRValue,
      circuitBreakersTriggered: triggeredCBs,
    };
  }

  // 14. CB-2: oscillation detection — update state
  const cb2 = runCircuitBreaker2(bestParams, currentParams, cbState);

  // 15. CB-5: confidence floor — apply or propose?
  if (!cb5.canApply) {
    triggeredCBs.push('CB-5');

    // Write proposal to log
    const proposal: ProposalEntry = {
      date: new Date().toISOString(),
      proposedParams: bestParams,
      trainLoss,
      holdoutLoss,
      pairCount: activePairs.length,
      status: 'pending',
    };
    const updatedCBState: CircuitBreakerState = {
      ...cbState,
      cb2Oscillations: cb2.updatedOscillations,
      cb5ProposalLog: [...cbState.cb5ProposalLog, proposal],
    };
    saveCBState(updatedCBState, cbStatePath);

    const histRecord: OptimizerRunRecord = {
      runAt: new Date().toISOString(),
      cycleNumber: loadRunHistory(historyPath).length + 1,
      pairsUsed: activePairs.length,
      trainLoss,
      holdoutLoss,
      proposedParams: bestParams,
      applied: false,
      rollbackReason: null,
      circuitBreakersTriggered: triggeredCBs,
    };
    appendRunHistory(histRecord, historyPath);

    return {
      action: 'proposed',
      reason: cb5.reason,
      previousParams: currentParams,
      newParams: bestParams,
      trainLoss,
      holdoutLoss,
      pairCount: activePairs.length,
      pearsonR: pearsonRValue,
      circuitBreakersTriggered: triggeredCBs,
    };
  }

  // 16. APPLY — all circuit breakers passed
  saveESPParams(bestParams, { calibrationPairs: activePairs.length, confidence });
  applyToCompatibilityTs(bestParams);

  // Update CB state
  const finalCBState: CircuitBreakerState = {
    ...cbState,
    cb2Oscillations: cb2.updatedOscillations,
    rollbacksInLast5Cycles: Math.max(0, cbState.rollbacksInLast5Cycles - 1), // decay
    cb3ConsecutiveLowR: 0, // reset on successful update
  };

  // 17. Meta-loop
  const historyRecords = loadRunHistory(historyPath);
  const metaUpdates = runMetaLoopChecks(
    { runAt: new Date().toISOString(), cycleNumber: historyRecords.length + 1, pairsUsed: activePairs.length, trainLoss, holdoutLoss, proposedParams: bestParams, applied: true, rollbackReason: null, circuitBreakersTriggered: triggeredCBs },
    historyRecords,
    finalCBState,
  );
  saveCBState({ ...finalCBState, ...metaUpdates }, cbStatePath);

  const histRecord: OptimizerRunRecord = {
    runAt: new Date().toISOString(),
    cycleNumber: historyRecords.length + 1,
    pairsUsed: activePairs.length,
    trainLoss,
    holdoutLoss,
    proposedParams: bestParams,
    applied: true,
    rollbackReason: null,
    circuitBreakersTriggered: triggeredCBs,
  };
  appendRunHistory(histRecord, historyPath);

  return {
    action: 'updated',
    reason: `All CBs passed — params updated (train loss: ${trainLoss.toFixed(4)})`,
    previousParams: currentParams,
    newParams: bestParams,
    trainLoss,
    holdoutLoss,
    pairCount: activePairs.length,
    pearsonR: pearsonRValue,
    circuitBreakersTriggered: triggeredCBs,
  };
}

// ─── Class API ───────────────────────────────────────────────────────

/** Object-oriented wrapper for the threshold optimizer */
export class ThresholdOptimizer {
  private cbStatePath: string;

  constructor(cbStatePath: string = DEFAULT_CB_STATE_PATH) {
    this.cbStatePath = cbStatePath;
    loadCBState(cbStatePath); // initialize if missing
  }

  async runCycle(
    storePath?: string,
    paramsPath?: string,
    historyPath?: string,
  ): Promise<OptimizerResult> {
    return runOptimizer(storePath, paramsPath, this.cbStatePath, historyPath);
  }

  isParamFrozen(paramName: keyof ESPParams): boolean {
    const state = loadCBState(this.cbStatePath);
    return state.cb2Oscillations.some(
      o => o.paramId === paramName && o.freezeRemainingCycles > 0,
    );
  }

  activateSafeHarbor(reason: string, storePairCount: number = 0, paramsPath?: string): void {
    const state = loadCBState(this.cbStatePath);
    activateSafeHarbor(state, storePairCount, paramsPath, this.cbStatePath);
    console.error(`[optimizer] Safe harbor activated: ${reason}`);
  }
}
