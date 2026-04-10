/**
 * Shared type definitions for the ESP self-improvement system.
 *
 * No logic — just interfaces, constants, and pure type-level utilities.
 *
 * @see docs/recursive-self-improvement-spec.md
 */

// ─── Calibration Pair ────────────────────────────────────────────────

/**
 * One labeled model comparison stored in calibration-store.json.
 * Represents a measured pairing of two embedding models with ground-truth divergence label.
 */
export interface CalibrationPair {
  /** SHA-256(modelA + "|" + modelB + "|" + corpusId).slice(0, 16) */
  id: string;
  modelA: string;
  modelB: string;
  /** SHA-256 of sorted chunk texts, first 16 hex chars */
  corpusId: string;
  corpusChunks: number;
  queriesEvaluated: number;
  jaccardAtK3: number;
  kendallTauAtK10: number;
  architectureDistance: number;
  rankingInstabilityRisk: number;
  /** Composite retrieval overlap risk: 1 - (wJaccard * jaccard + (1-wJaccard) * tau) */
  retrievalOverlapRisk: number;
  /** Per-query rankings — null if not stored */
  perQueryRankings: {
    query: string;
    rankingsA: string[];
    rankingsB: string[];
  }[] | null;
  /** Ground-truth: is this pair actually divergent? */
  actuallyDivergent: boolean;
  /** How the ground truth was established */
  divergenceMethod: 'judge-model' | 'manual' | 'inferred-from-jaccard';
  judgeModel: string | null;
  /** Threshold used to infer divergence (default 0.5) */
  divergenceThreshold: number;
  measuredAt: string;
  calibrationVersion: string;
  benchmarkScript: string;
  fingerprintMagnitudes: { modelA: number; modelB: number };
  dimensions: { modelA: number; modelB: number };
  /** Flagged as outlier by CB-3 */
  isOutlier: boolean;
}

// ─── Calibration Store (JSON schema) ────────────────────────────────

/** JSON file schema for data/calibration-store.json */
export interface CalibrationStoreData {
  schemaVersion: string;
  pairs: CalibrationPair[];
  lastUpdated: string;
  pairCount: number;
  bandCounts: {
    transparent: number;
    caution: number;
    'high-risk': number;
    reject: number;
  };
}

// ─── ESP Parameters ──────────────────────────────────────────────────

/** Tunable parameters for the ESP scoring function */
export interface ESPParams {
  /** Jaccard weight in retrieval overlap risk: [0.0, 1.0] */
  wJaccard: number;
  /** Threshold below which verdict is transparent: [0.01, 0.25] */
  tTransparent: number;
  /** Threshold above which verdict is high-risk: [0.3, 0.7] */
  tHighRisk: number;
  /** Threshold above which verdict is reject: [0.6, 0.95] */
  tReject: number;
}

/** Safe harbor (initial hardcoded values — never change these) */
export const SAFE_HARBOR_PARAMS: Readonly<ESPParams> = {
  wJaccard: 0.6,
  tTransparent: 0.1,
  tHighRisk: 0.5,
  tReject: 0.8,
} as const;

/** Bounds and step size for each tunable parameter */
export const PARAM_BOUNDS: Record<keyof ESPParams, { min: number; max: number; step: number }> = {
  wJaccard:     { min: 0.0,  max: 1.0,  step: 0.05 },
  tTransparent: { min: 0.01, max: 0.25, step: 0.02 },
  tHighRisk:    { min: 0.3,  max: 0.7,  step: 0.05 },
  tReject:      { min: 0.6,  max: 0.95, step: 0.05 },
} as const;

// ─── Confidence Tiers ────────────────────────────────────────────────

export type ConfidenceTier = 'uncalibrated' | 'pilot' | 'preliminary' | 'validated';

/**
 * Compute calibration confidence tier from pair count and band distribution.
 *
 * - validated:   ≥50 pairs AND ≥4 bands with ≥5 pairs each
 * - preliminary: ≥20 pairs AND ≥3 bands with ≥5 pairs each
 * - pilot:       ≥5 pairs AND ≥2 bands with ≥5 pairs each
 * - uncalibrated: everything else
 */
export function computeConfidenceTier(
  pairCount: number,
  bandCounts: CalibrationStoreData['bandCounts'],
): ConfidenceTier {
  const bandsWithFiveOrMore = Object.values(bandCounts).filter(c => c >= 5).length;
  if (pairCount >= 50 && bandsWithFiveOrMore >= 4) return 'validated';
  if (pairCount >= 20 && bandsWithFiveOrMore >= 3) return 'preliminary';
  if (pairCount >= 5  && bandsWithFiveOrMore >= 2) return 'pilot';
  return 'uncalibrated';
}

// ─── Circuit Breaker State ───────────────────────────────────────────

/** Per-parameter oscillation tracking for CB-2 */
export interface OscillationState {
  paramId: keyof ESPParams;
  /** Direction of last param change */
  lastDirection: '+' | '-' | '0';
  /** Cycles remaining in freeze */
  freezeRemainingCycles: number;
  /** Min-pairs multiplier (1.0 default, 1.5 first freeze, 2.0 permanent) */
  permanentMinPairsMultiplier: number;
}

/** Persistent state for all 6 circuit breakers */
export interface CircuitBreakerState {
  // CB-1: post-update validation
  cb1Rollbacks: number;

  // CB-2: oscillation freeze (per-parameter)
  cb2Oscillations: OscillationState[];

  // CB-3: Pearson r guard
  cb3ConsecutiveLowR: number;
  /** If > 0, weight updates blocked until store has this many pairs */
  cb3WeightBlockedUntilNewPairs: number;

  // CB-4: band coverage (derived from store; no persistent state needed beyond the store itself)

  // CB-5: confidence floor
  cb5ProposalLog: ProposalEntry[];

  // CB-6: safe harbor
  cb6SafeHarborActive: boolean;
  cb6PairsAddedSinceSafeHarbor: number;
  cb6RecoveryThreshold: number;   // default 10

  // Meta-loop signals
  rollbacksInLast5Cycles: number;
  degradedState: boolean;
  outlierPairIds: string[];
}

/** A proposal written while CB-5 (confidence floor) blocks application */
export interface ProposalEntry {
  date: string;
  proposedParams: ESPParams;
  trainLoss: number;
  holdoutLoss: number;
  pairCount: number;
  status: 'pending' | 'applied' | 'discarded';
}

// ─── Optimizer Types ─────────────────────────────────────────────────

/** Result from one optimizer run */
export interface OptimizerResult {
  action: 'updated' | 'proposed' | 'no-update' | 'rollback' | 'safe-harbor';
  reason: string;
  previousParams: ESPParams;
  newParams: ESPParams | null;
  trainLoss: number;
  holdoutLoss: number;
  pairCount: number;
  pearsonR: number;
  circuitBreakersTriggered: string[];
}

/** One optimizer cycle result stored in optimizer-run-history.json */
export interface OptimizerRunRecord {
  runAt: string;
  cycleNumber: number;
  pairsUsed: number;
  trainLoss: number;
  holdoutLoss: number;
  proposedParams: ESPParams;
  applied: boolean;
  rollbackReason: string | null;
  circuitBreakersTriggered: string[];
}

// ─── ATP Execution Record ────────────────────────────────────────────

/** One ATP protocol execution outcome */
export interface ATPExecutionRecord {
  bundleId: string;
  protocolId: string;
  modelClass: string;
  actualModel: string;
  taskDescription: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  outcome: 'success' | 'partial' | 'failure' | 'escalated';
  receiptVerified: boolean;
  retriesUsed: number;
  tokensUsed: number;
  estimatedCostUsd: number;
  taskComplexity: 'mechanical' | 'analytical' | 'judgment';
  minSufficientModelClass: string | null;
  varsVerified: {
    varId: string;
    stalenessPolicyUsed: string;
    verifyRan: boolean;
    stateChanged: boolean;
  }[];
}

/** JSON schema for atp-instance/data/execution-records.json */
export interface ExecutionRecordStore {
  schemaVersion: string;
  records: ATPExecutionRecord[];
  lastUpdated: string;
  recordCount: number;
  summaries: {
    byProtocolAndModel: Record<string, Record<string, {
      total: number;
      success: number;
      partial: number;
      failure: number;
      escalated: number;
    }>>;
    varChangeFrequency: Record<string, {
      verifyCount: number;
      changedCount: number;
      changeRate: number;
    }>;
  };
}
