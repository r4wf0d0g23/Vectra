# Self-Improvement Implementation Brief

**For:** Execution sub-agent  
**Date:** 2026-04-09  
**Spec:** `docs/recursive-self-improvement-spec.md` v0.2.0  
**Status:** Build Phase 1 + Phase 2 skeleton NOW

---

## Context (Read This Cold)

The ESP (Embedding Space Profile) system compares embedding models and issues compatibility verdicts: transparent, caution, high-risk, reject. Currently all parameters are hardcoded. This implementation adds a self-tuning loop that learns optimal parameters from calibration data, with 6 autonomous circuit breakers replacing all human oversight.

**Current state:** 3 calibration pairs exist (2 self-comparisons at archDist=0, 1 cross-family at archDist=0.138). Confidence level: `uncalibrated`. The optimizer cannot auto-apply changes yet — it writes proposals until ≥5 pairs reach `pilot` confidence.

**Key files already existing:**
- `src/embedding/compatibility.ts` — current ESP implementation with hardcoded weights
- `src/embedding/esv.ts` — fingerprint computation, frobeniusNorm export
- `docs/calibration-pairs-results.json` — raw benchmark output (3 pairs)
- `src/benchmark/calibration-pairs-bench.ts` — benchmark runner

**Workspace root:** `/home/agent-raw/.openclaw/workspace/vectra`  
**ATP instance:** `/home/agent-raw/.openclaw/workspace/atp-instance`

---

## Step 1: Type Definitions

**File:** `src/embedding/types.ts`  
**Create new file.**

**What it implements:**
```typescript
// ── Calibration pair stored in calibration-store.json ──
export interface CalibrationPair {
  id: string;                    // SHA-256(modelA + ":" + modelB + ":" + corpusId).slice(0, 16)
  modelA: string;
  modelB: string;
  corpusId: string;
  corpusChunks: number;
  queriesEvaluated: number;
  jaccardAtK3: number;
  kendallTauAtK10: number;
  architectureDistance: number;
  rankingInstabilityRisk: number;
  retrievalOverlapRisk: number;
  perQueryRankings: {
    query: string;
    rankingsA: string[];
    rankingsB: string[];
  }[] | null;
  actuallyDivergent: boolean;
  divergenceMethod: 'judge-model' | 'manual' | 'inferred-from-jaccard';
  judgeModel: string | null;
  divergenceThreshold: number;
  measuredAt: string;
  calibrationVersion: string;
  benchmarkScript: string;
  fingerprintMagnitudes: { modelA: number; modelB: number };
  dimensions: { modelA: number; modelB: number };
}

// ── Calibration store JSON schema ──
export interface CalibrationStore {
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

// ── ESP tunable parameters ──
export interface ESPParams {
  wJaccard: number;       // [0.0, 1.0]
  tTransparent: number;   // [0.01, 0.25]
  tHighRisk: number;      // [0.3, 0.7]
  tReject: number;        // [0.6, 0.95]
}

// ── Safe harbor defaults ──
export const SAFE_HARBOR_PARAMS: Readonly<ESPParams> = {
  wJaccard: 0.6,
  tTransparent: 0.1,
  tHighRisk: 0.5,
  tReject: 0.8,
};

// ── Param bounds ──
export const PARAM_BOUNDS: Record<keyof ESPParams, { min: number; max: number; step: number }> = {
  wJaccard: { min: 0.0, max: 1.0, step: 0.05 },
  tTransparent: { min: 0.01, max: 0.25, step: 0.02 },
  tHighRisk: { min: 0.3, max: 0.7, step: 0.05 },
  tReject: { min: 0.6, max: 0.95, step: 0.05 },
};

// ── Confidence tiers ──
export type ConfidenceTier = 'uncalibrated' | 'pilot' | 'preliminary' | 'validated';

export function computeConfidenceTier(
  pairCount: number,
  bandCounts: CalibrationStore['bandCounts'],
): ConfidenceTier {
  const bandsWithFiveOrMore = Object.values(bandCounts).filter(c => c >= 5).length;
  if (pairCount >= 50 && bandsWithFiveOrMore >= 4) return 'validated';
  if (pairCount >= 20 && bandsWithFiveOrMore >= 3) return 'preliminary';
  if (pairCount >= 5 && bandsWithFiveOrMore >= 2) return 'pilot';
  return 'uncalibrated';
}

// ── Circuit breaker state ──
export interface OscillationState {
  paramId: keyof ESPParams;
  lastDirection: '+' | '-' | '0';
  freezeRemainingCycles: number;
  permanentMinPairsMultiplier: number; // 1.0 default, 1.5 first freeze, 2.0 permanent
}

export interface CircuitBreakerState {
  cb1Rollbacks: number;                    // total post-update validation rollbacks
  cb2Oscillations: OscillationState[];     // per-parameter oscillation tracking
  cb3ConsecutiveLowR: number;              // consecutive optimizer runs with r < 0.3
  cb3WeightBlockedUntilNewPairs: number;   // pairs needed before weight updates unblock (0 = not blocked)
  cb5ProposalLog: ProposalEntry[];         // proposals written while uncalibrated
  cb6SafeHarborActive: boolean;
  cb6PairsAddedSinceSafeHarbor: number;
  cb6RecoveryThreshold: number;            // 10 new pairs
  rollbacksInLast5Cycles: number;
  degradedState: boolean;
  outlierPairIds: string[];
}

export interface ProposalEntry {
  date: string;
  proposedParams: ESPParams;
  trainLoss: number;
  holdoutLoss: number;
  pairCount: number;
  status: 'pending' | 'applied' | 'discarded';
}

// ── Optimizer result ──
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

// ── ATP execution record ──
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

export interface ExecutionRecordStore {
  schemaVersion: string;
  records: ATPExecutionRecord[];
  lastUpdated: string;
  recordCount: number;
  summaries: {
    byProtocolAndModel: Record<string, Record<string, {
      total: number; success: number; partial: number; failure: number; escalated: number;
    }>>;
    varChangeFrequency: Record<string, {
      verifyCount: number; changedCount: number; changeRate: number;
    }>;
  };
}
```

**Dependencies:** None.  
**Completion test:** `npx tsx -e "import './src/embedding/types.js'"` compiles without error.

---

## Step 2: Calibration Store

**File:** `src/embedding/calibration-store.ts`  
**Create new file.**

**What it implements:**
- `loadCalibrationStore(): CalibrationStore` — reads `data/calibration-store.json`, creates if missing
- `saveCalibrationStore(store: CalibrationStore): void` — writes atomically
- `mergePairs(newPairs: CalibrationPair[]): { added: number; updated: number; triggered: boolean }` — dedup by `id`, recompute band counts, check trigger condition
- `computeBandCounts(pairs: CalibrationPair[]): CalibrationStore['bandCounts']` — count pairs per verdict band using current thresholds
- `generatePairId(modelA: string, modelB: string, corpusId: string): string` — SHA-256 hash, first 16 chars

**Storage:** `data/calibration-store.json` (relative to vectra workspace root)

**Seed data:** Convert the 3 pairs from `docs/calibration-pairs-results.json` into `CalibrationPair` format. For the existing pairs:
- `nemotron-self`: `actuallyDivergent: false`, `divergenceMethod: 'inferred-from-jaccard'`, `divergenceThreshold: 0.5`
- `minilm-self`: same
- `nemotron-vs-minilm`: `actuallyDivergent: false` (Jaccard@K3 = 0.7 > 0.5), same method
- `perQueryRankings: null` for all (not stored in current benchmark)
- `calibrationVersion: 'v0-hardcoded'`
- `benchmarkScript: 'calibration-pairs-bench.ts'`

**Trigger condition check (in `mergePairs`):**
```typescript
const triggered = (
  newPairsSinceLastRun >= 5 &&
  activeBandsWithMinPairs >= 2 &&   // ≥2 bands with ≥5 pairs each (adjusted from old spec)
  hoursSinceLastRun >= 24
);
```
Read `lastOptimizerRun` from `tuning-state.md` parsing (or default to `never` → always passes time check).

**Dependencies:** `types.ts`, Node.js `crypto` for SHA-256, `fs` for JSON read/write.  
**Completion test:**
1. Run merge with empty store → creates store with 0 pairs
2. Run merge with the 3 seed pairs → store has 3 pairs, bandCounts = {transparent: 2, caution: 1, high-risk: 0, reject: 0}
3. Run merge with duplicate pair → no change (dedup)
4. `triggered` returns false (only 3 pairs, need 5 new since last run)

---

## Step 3: ESP Parameter Store

**File:** `src/embedding/esp-params.ts`  
**Create new file.**

**What it implements:**
- `loadESPParams(): ESPParams` — reads current params from `atp-instance/vars/esp-params.md` (parse the markdown table)
- `saveESPParams(params: ESPParams, metadata: UpdateMetadata): void` — writes updated params to the var file, appends to update history
- `rollbackESPParams(): ESPParams` — reads the last entry from Update History, writes it as Current Parameters, returns the restored params
- `loadSafeHarborParams(): ESPParams` — returns `SAFE_HARBOR_PARAMS` constant
- `applyToCompatibilityTs(params: ESPParams): void` — rewrites the hardcoded constants in `src/embedding/compatibility.ts` with learned values

**For `applyToCompatibilityTs`:** The function must:
1. Read `src/embedding/compatibility.ts`
2. Find `computeRetrievalOverlapRisk` and replace `0.6` and `0.4` with `params.wJaccard` and `(1 - params.wJaccard)`
3. Find `computeVerdict` and replace threshold constants (`0.1`, `0.5`, `0.8`) with learned values
4. Write back
5. Use regex replacements that are robust to whitespace but specific enough not to match wrong numbers

**Markdown parsing approach:** The `esp-params.md` file has a table with rows like:
```
| `w_jaccard` | 0.6 | hardcoded | uncalibrated |
```
Parse with regex: `/\|\s*`(\w+)`\s*\|\s*([\d.]+)\s*\|/`

**Dependencies:** `types.ts`, `fs`.  
**Completion test:**
1. `loadESPParams()` returns `{ wJaccard: 0.6, tTransparent: 0.1, tHighRisk: 0.5, tReject: 0.8 }`
2. `saveESPParams({wJaccard: 0.55, ...}, metadata)` → var file updated, history entry appended
3. `rollbackESPParams()` → restores previous params
4. `applyToCompatibilityTs({wJaccard: 0.55, ...})` → `compatibility.ts` updated with new constants

---

## Step 4: Threshold Optimizer + Circuit Breakers

**File:** `src/embedding/threshold-optimizer.ts`  
**Create new file. This is the core file (~400 lines).**

**What it implements:**

### 4a. Math utilities
- `pearsonR(xs: number[], ys: number[]): number` — Pearson correlation coefficient
- `asymmetricLoss(pairs: CalibrationPair[], params: ESPParams): number` — weighted classification loss (FP_WEIGHT=2.0, FN_WEIGHT=1.0)
- `splitTrainHoldout(pairs: CalibrationPair[], holdoutFraction: number): { train: CalibrationPair[]; holdout: CalibrationPair[] }` — deterministic split by `pair.id` hash mod 5

### 4b. Grid search
- `gridSearch(trainPairs: CalibrationPair[], currentParams: ESPParams, cbState: CircuitBreakerState): { bestParams: ESPParams; bestLoss: number }` — sweep all param combinations within bounds, respecting:
  - Constraint: `tReject > tHighRisk + 0.1`
  - CB-4 band coverage lock: if a band has <5 pairs, its threshold is fixed at current value
  - CB-2 oscillation freeze: if a param is frozen, fix at current value
  - MAX_PARAM_SHIFT: candidate params must be within 0.15 of current params

### 4c. Circuit breakers (all 6)

**`runCircuitBreaker1(holdoutPairs, preParams, newParams): { passed: boolean; reason: string }`**
- Compute `asymmetricLoss(holdout, newParams)` vs `asymmetricLoss(holdout, preParams)`
- If new loss > old loss → `passed: false`

**`runCircuitBreaker2(newParams, preParams, cbState): { updatedState: OscillationState[]; frozenParams: (keyof ESPParams)[] }`**
- Compare direction of each param change against `cbState.cb2Oscillations[].lastDirection`
- If opposite direction detected → freeze for 3 cycles, increase min-pairs multiplier

**`runCircuitBreaker3(allPairs, newParams): { passed: boolean; pearsonR: number; degraded: boolean }`**
- Compute archDist and retrievalOverlapRisk for all pairs using newParams weights
- Compute Pearson r
- If r < 0.4 → `passed: false`
- If r < 0.3 and `cbState.cb3ConsecutiveLowR >= 1` → `degraded: true`

**`runCircuitBreaker4(bandCounts, cbState): Record<keyof ESPParams, boolean>`**
- Returns which params are frozen due to insufficient band data
- `tTransparent` frozen if transparent band < 5 pairs (adjusted by oscillation multiplier)
- `tHighRisk` frozen if high-risk band < 5 pairs
- `tReject` frozen if reject band < 5 pairs
- `wJaccard` frozen if total cross-family pairs with retrieval < 10

**`runCircuitBreaker5(confidence): { canApply: boolean }`**
- If confidence = `uncalibrated` → `canApply: false` (write to proposal log instead)
- Otherwise → `canApply: true`

**`runCircuitBreaker6(cbState): { triggerSafeHarbor: boolean }`**
- If `cbState.cb3ConsecutiveLowR >= 2` → true
- If `cbState.rollbacksInLast5Cycles > 3` → true

### 4d. Main optimizer entry point

```typescript
export async function runOptimizer(): Promise<OptimizerResult> {
  // 1. Load calibration store
  const store = loadCalibrationStore();
  const pairs = store.pairs;
  
  // 2. Load current params
  const currentParams = loadESPParams();
  
  // 3. Load circuit breaker state from tuning-state.md
  const cbState = loadCircuitBreakerState();
  
  // 4. Check CB-6 (safe harbor) — if active and not enough new pairs, abort
  if (cbState.cb6SafeHarborActive && cbState.cb6PairsAddedSinceSafeHarbor < 10) {
    return { action: 'no-update', reason: 'safe harbor active, need more pairs', ... };
  }
  
  // 5. Compute confidence tier
  const confidence = computeConfidenceTier(store.pairCount, store.bandCounts);
  
  // 6. Check CB-5 (confidence floor)
  const cb5 = runCircuitBreaker5(confidence);
  
  // 7. Check CB-4 (band coverage lock) — determines which params can move
  const frozenParams = runCircuitBreaker4(store.bandCounts, cbState);
  
  // 8. Split train/holdout
  const { train, holdout } = splitTrainHoldout(pairs, 0.20);
  
  // 9. Grid search (respecting frozen params from CB-2 and CB-4)
  const { bestParams, bestLoss } = gridSearch(train, currentParams, cbState);
  
  // 10. Check CB-1 (holdout validation)
  const cb1 = runCircuitBreaker1(holdout, currentParams, bestParams);
  if (!cb1.passed) {
    // Auto-rollback — don't apply, flag recent pairs as outliers
    saveCBState({ ...cbState, cb1Rollbacks: cbState.cb1Rollbacks + 1 });
    return { action: 'rollback', reason: cb1.reason, ... };
  }
  
  // 11. Check CB-3 (Pearson r guard) — only if weights changed
  if (bestParams.wJaccard !== currentParams.wJaccard) {
    const cb3 = runCircuitBreaker3(pairs, bestParams);
    if (!cb3.passed) {
      saveCBState({ ...cbState, cb3ConsecutiveLowR: cbState.cb3ConsecutiveLowR + 1 });
      if (cb3.degraded) {
        // CB-6 trigger
        activateSafeHarbor(cbState);
        return { action: 'safe-harbor', reason: 'geometric approach degraded', ... };
      }
      return { action: 'rollback', reason: `Pearson r=${cb3.pearsonR} < 0.4`, ... };
    }
  }
  
  // 12. Check CB-6 (degraded state from rollback rate)
  const cb6 = runCircuitBreaker6(cbState);
  if (cb6.triggerSafeHarbor) {
    activateSafeHarbor(cbState);
    return { action: 'safe-harbor', reason: '>3 rollbacks in 5 cycles', ... };
  }
  
  // 13. CB-2 (oscillation detection) — update state
  const cb2 = runCircuitBreaker2(bestParams, currentParams, cbState);
  
  // 14. Apply or propose
  if (!cb5.canApply) {
    // Write to proposal log (CB-5: uncalibrated)
    appendProposal(cbState, bestParams, bestLoss, holdoutLoss, store.pairCount);
    return { action: 'proposed', reason: 'uncalibrated — proposal logged', ... };
  }
  
  // 15. APPLY — update params
  saveESPParams(bestParams, { pairCount: store.pairCount, trainLoss: bestLoss, ... });
  applyToCompatibilityTs(bestParams);
  
  // 16. Update CB state
  saveCBState({
    ...cbState,
    cb2Oscillations: cb2.updatedState,
    rollbacksInLast5Cycles: Math.max(0, cbState.rollbacksInLast5Cycles - 1), // decay
  });
  
  // 17. Run meta-loop checks
  runMetaLoopChecks(cbState);
  
  return { action: 'updated', ... };
}
```

### 4e. Meta-loop (integrated into optimizer)

```typescript
function runMetaLoopChecks(cbState: CircuitBreakerState): void {
  // Signal 1: Guards too strict — 5+ consecutive no-update runs
  // Signal 2: Trigger too aggressive — >40% rollback rate
  // Signal 3: Overfitting — holdout > train by >15%
  // See spec §J1 for autonomous responses
  // Each response modifies meta-parameters in tuning-state.md directly
}
```

### 4f. Safe harbor activation

```typescript
function activateSafeHarbor(cbState: CircuitBreakerState): void {
  // 1. Load safe harbor params
  const safeParams = loadSafeHarborParams();
  // 2. Save to esp-params.md (overwrite current)
  saveESPParams(safeParams, { reason: 'safe-harbor-recovery' });
  // 3. Apply to compatibility.ts
  applyToCompatibilityTs(safeParams);
  // 4. Reset all CB state
  saveCBState({
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
    outlierPairIds: [],
  });
  // 5. Log to daily memory
  // 6. Git commit
}
```

**Dependencies:** `types.ts`, `calibration-store.ts`, `esp-params.ts`.  
**Completion test:**
1. With 3 pairs (uncalibrated): optimizer runs grid search, writes proposal to log, returns `action: 'proposed'`
2. With mocked 10 pairs (pilot): optimizer applies params if CB-1 passes
3. With mocked holdout regression: CB-1 triggers, returns `action: 'rollback'`
4. With mocked r < 0.3 twice: CB-6 triggers safe harbor, returns `action: 'safe-harbor'`
5. Unit test each circuit breaker independently

---

## Step 5: ATP Execution Recorder

**File:** `src/atp/execution-recorder.ts`  
**Create new file.**

**What it implements:**
- `loadExecutionRecords(): ExecutionRecordStore` — reads `atp-instance/data/execution-records.json`
- `saveExecutionRecords(store: ExecutionRecordStore): void` — writes atomically
- `recordExecution(record: ATPExecutionRecord): void` — appends record, updates summaries
- `getProtocolStats(protocolId: string): { total, success, failure, ... }` — aggregate stats

**Default complexity mapping (hardcoded):**
```typescript
const PROTOCOL_COMPLEXITY: Record<string, ATPExecutionRecord['taskComplexity']> = {
  'openclaw-config-change': 'mechanical',
  'dgx-inference-ops': 'analytical',
  'crew-ops': 'mechanical',
  'crew-peering': 'mechanical',
  'cradleos-deploy': 'analytical',
  'vectra-build': 'analytical',
  'memory-maintenance': 'mechanical',
  'atp-protocol-review': 'judgment',
};
```

**Dependencies:** `types.ts`, `fs`.  
**Completion test:**
1. Load empty store → returns default structure
2. Record one execution → store has 1 record, summaries updated
3. `getProtocolStats('vectra-build')` returns correct aggregation

---

## Step 6: Tuning State Var

**File:** `atp-instance/vars/tuning-state.md`  
**Create new file (or overwrite if exists).**

Use the template from spec §I verbatim, with these additions for CB state tracking:

Add after `## Meta-Loop State`:
```markdown
## Circuit Breaker State (machine-readable)

<!-- CB_STATE_JSON
{
  "cb1Rollbacks": 0,
  "cb2Oscillations": [],
  "cb3ConsecutiveLowR": 0,
  "cb3WeightBlockedUntilNewPairs": 0,
  "cb5ProposalLog": [],
  "cb6SafeHarborActive": false,
  "cb6PairsAddedSinceSafeHarbor": 0,
  "cb6RecoveryThreshold": 10,
  "rollbacksInLast5Cycles": 0,
  "degradedState": false,
  "outlierPairIds": []
}
CB_STATE_JSON -->

## Proposal Log

_No proposals yet. CB-5 will write here while confidence is uncalibrated._

## Safe Harbor Recovery Log

_No safe harbor activations yet._

## Meta-Loop Adaptation Log

_No meta-parameter adaptations yet._
```

The CB state JSON is embedded in an HTML comment for machine parsing while keeping the markdown human-readable.

**Dependencies:** None (markdown file).  
**Completion test:** File exists, JSON block parses correctly.

---

## Step 7: ESP Params Var

**File:** `atp-instance/vars/esp-params.md`  
**Create new file (or overwrite if exists).**

Use the template from spec §D verbatim. Ensure the Safe Harbor Parameters table is present.

**Dependencies:** None.  
**Completion test:** File exists, param table parseable.

---

## Step 8: Seed Calibration Store

**File:** `data/calibration-store.json`  
**Create new file.**

Seed with the 3 existing pairs from `docs/calibration-pairs-results.json`. Transform each:

```json
{
  "schemaVersion": "1.0.0",
  "pairs": [
    {
      "id": "<computed SHA-256 hash>",
      "modelA": "nemotron-embed@dgx",
      "modelB": "nemotron-embed@dgx",
      "corpusId": "benchmark-v1",
      "corpusChunks": 28,
      "queriesEvaluated": 15,
      "jaccardAtK3": 1,
      "kendallTauAtK10": 1,
      "architectureDistance": 0,
      "rankingInstabilityRisk": 0,
      "retrievalOverlapRisk": 0,
      "perQueryRankings": null,
      "actuallyDivergent": false,
      "divergenceMethod": "inferred-from-jaccard",
      "judgeModel": null,
      "divergenceThreshold": 0.5,
      "measuredAt": "2026-04-09T23:41:10.302Z",
      "calibrationVersion": "v0-hardcoded",
      "benchmarkScript": "calibration-pairs-bench.ts",
      "fingerprintMagnitudes": { "modelA": 21.72, "modelB": 21.72 },
      "dimensions": { "modelA": 2048, "modelB": 2048 }
    }
  ],
  "lastUpdated": "2026-04-09T23:41:11Z",
  "pairCount": 3,
  "bandCounts": {
    "transparent": 2,
    "caution": 1,
    "high-risk": 0,
    "reject": 0
  }
}
```

Do this for all 3 pairs, using their actual values from the benchmark results.

**Dependencies:** None.  
**Completion test:** JSON is valid, 3 pairs, bandCounts correct.

---

## Step 9: Execution Records Store (Empty)

**File:** `atp-instance/data/execution-records.json`  
**Create new file.**

```json
{
  "schemaVersion": "1.0.0",
  "records": [],
  "lastUpdated": "2026-04-09T00:00:00Z",
  "recordCount": 0,
  "summaries": {
    "byProtocolAndModel": {},
    "varChangeFrequency": {}
  }
}
```

Create `atp-instance/data/` directory if it doesn't exist.

**Dependencies:** None.  
**Completion test:** JSON valid, 0 records.

---

## Step 10: Wire Into Benchmark Runner

**File:** `src/benchmark/calibration-pairs-bench.ts`  
**Modify existing file.**

Add `--store` flag handling:
1. After computing all pairs, if `--store` flag is present:
   - Import `mergePairs` from `../embedding/calibration-store.js`
   - Transform benchmark output pairs into `CalibrationPair` format
   - Call `mergePairs(transformedPairs)`
   - If `triggered` is true, print `OPTIMIZER_TRIGGERED` to stdout
2. Continue with existing stdout output behavior

**Dependencies:** Steps 1, 2.  
**Completion test:** Running with `--store` writes to `data/calibration-store.json`. Running without `--store` behaves exactly as before.

---

## Build Order Summary

| Order | File | Type | Est. Lines |
|-------|------|------|-----------|
| 1 | `src/embedding/types.ts` | new | ~150 |
| 2 | `src/embedding/calibration-store.ts` | new | ~120 |
| 3 | `src/embedding/esp-params.ts` | new | ~150 |
| 4 | `src/embedding/threshold-optimizer.ts` | new | ~400 |
| 5 | `src/atp/execution-recorder.ts` | new | ~80 |
| 6 | `atp-instance/vars/tuning-state.md` | new | ~100 |
| 7 | `atp-instance/vars/esp-params.md` | new | ~80 |
| 8 | `data/calibration-store.json` | new | ~80 |
| 9 | `atp-instance/data/execution-records.json` | new | ~15 |
| 10 | `src/benchmark/calibration-pairs-bench.ts` | modify | ~40 Δ |

**Total new code:** ~1,000 lines TypeScript + ~275 lines markdown/JSON

---

## What NOT to Build Yet

- **K-value sweep** — no per-query rankings stored yet
- **Anchor weight ablation** — need 15+ pairs
- **ATP optimizer** (`atp-optimizer.ts`) — need 20+ execution records
- **Runtime verdict logging** — ESP not in live pipeline
- **Passive collection hooks** — low priority

---

## Testing Strategy

**Unit tests (if test framework exists):**
- Each circuit breaker in isolation with mocked data
- Grid search with known-answer test cases
- Merge store dedup logic
- Param store round-trip (save → load → compare)

**Integration test (manual):**
1. Seed store with 3 pairs → optimizer runs → writes proposal (CB-5: uncalibrated)
2. Add 2 more pairs to reach 5 → optimizer auto-applies most recent proposal
3. Inject a bad param set → CB-1 detects holdout regression → auto-rollback
4. Inject oscillating params → CB-2 freezes → unfreezes after 3 cycles

**Smoke test (run after build):**
```bash
cd /home/agent-raw/.openclaw/workspace/vectra
npx tsx -e "
  import { loadCalibrationStore, mergePairs } from './src/embedding/calibration-store.js';
  import { loadESPParams } from './src/embedding/esp-params.js';
  import { runOptimizer } from './src/embedding/threshold-optimizer.js';
  
  const store = loadCalibrationStore();
  console.log('Store pairs:', store.pairCount);
  
  const params = loadESPParams();
  console.log('Current params:', params);
  
  const result = await runOptimizer();
  console.log('Optimizer result:', result.action, result.reason);
"
```

Expected output: `action: 'proposed'` (uncalibrated, 3 pairs < 5 minimum).
