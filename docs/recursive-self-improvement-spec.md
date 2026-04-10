# Recursive Self-Improvement Spec — ESP + ATP Adaptive Tuning Loops

**Version:** 0.2.0  
**Date:** 2026-04-09  
**Status:** Forward spec (not yet implemented)  
**Author:** Reality Anchor (systems architect pass), amended by Opus review (autonomous circuit breakers)  
**Depends on:** `src/embedding/compatibility.ts`, `atp-instance/protocols/orchestration-main.md`, `atp-instance/ATP_HOOK.md`

---

## Overview

This spec defines three feedback loops that replace hardcoded constants in ESP and ATP with learned parameters derived from real execution data:

1. **Loop 1 — ESP Parameter Tuning:** Adapts verdict thresholds, composite weights, and K values based on labeled calibration pairs.
2. **Loop 2 — ATP Execution Tuning:** Adapts model class routing, staleness TTLs, and retry counts based on execution outcome records.
3. **Loop 3 — Meta-Loop:** Monitors the improvement system itself for oscillation, over-conservatism, and bad updates.

All algorithms are implementable in TypeScript with no external numeric libraries.

**v0.2.0 change:** All human checkpoints have been replaced with autonomous circuit breakers. The system protects itself mathematically — it validates, rollbacks, freezes, and recovers without human intervention.

---

## Current State (as of spec date)

| Parameter | Current Value | Source | Calibration Data |
|-----------|---------------|--------|------------------|
| `w_jaccard` | 0.6 | arbitrary | 3 pairs (2 transparent, 1 caution) |
| `w_tau` | 0.4 | arbitrary | same |
| `t_transparent` (archDist) | 0.1 | arbitrary | 2 pairs at 0.0 (self-comparisons) |
| `t_high_risk` (retrievalOverlap) | 0.5 | arbitrary | 0 pairs in this band |
| `t_reject` (retrievalOverlap) | 0.8 | arbitrary | 0 pairs in this band |
| Frobenius normalization | mean of magnitudes | arbitrary | n/a |
| Anchor weights | equal (27 anchors) | unvalidated | n/a |
| K for Jaccard | 3 | benchmark heuristic | 1 cross-family pair |
| K for Kendall τ | 10 | benchmark heuristic | 1 cross-family pair |
| Model class per protocol | see orchestration-main.md | heuristic | 0 execution records |
| Staleness TTLs | session-cache / ttl:7d / always-verify | heuristic | 0 change-frequency records |
| Escalation retry count | 1 | arbitrary | 0 retry outcome records |

---

## LOOP 1: ESP Parameter Tuning

### A. Tunable Parameters

#### A1. Composite Weights — `w_jaccard` (0.6), `w_tau` (0.4)

**Current:** `retrievalOverlapRisk = 1 - (0.6 * jaccardAtK3 + 0.4 * kendallTauAtK10)` in `computeRetrievalOverlapRisk()`.

**Why it's wrong:** The 60/40 split was chosen without evidence. Jaccard@K3 measures exact set overlap in top results (precision-oriented). Kendall τ@K10 measures rank correlation over a deeper window (ordering-oriented). The right weighting depends on which metric better predicts actual retrieval divergence — which we don't know yet.

**What would change it:** A dataset of ≥10 cross-family pairs where we know `actuallyDivergent` (ground truth from a judge model evaluating answer quality). A pair is "actually divergent" when the same query returns materially different answers depending on which model's embeddings retrieved the context. The weight that minimizes classification error on this dataset is the correct weight.

**Update rule:** Fit `w_jaccard` by minimizing the asymmetric loss function (§C2) over all pairs with retrieval data. `w_tau = 1 - w_jaccard`. Sweep `w_jaccard` from 0.0 to 1.0 in steps of 0.05 (21 grid points).

**Bounds:** `w_jaccard ∈ [0.0, 1.0]`, `w_tau = 1 - w_jaccard`. Both must be non-negative.

**Minimum data:** 10 pairs with retrieval metrics AND divergence labels, spanning at least 2 verdict bands.

#### A2. Verdict Thresholds

**`t_transparent`** (architectureDistance < 0.1 for transparent verdict)

- **Current:** 0.1 (in `computeVerdict()`, rule 3)
- **Why it's wrong:** The transparent threshold gates whether cross-model exchange is considered safe. Too low = excessive caution (marks safe pairs as caution). Too high = false transparency (marks divergent pairs as safe). With only self-comparison data at archDist=0.0 and one cross-family at 0.138, we can't tell if 0.1 is right.
- **Update rule:** Set to the maximum `architectureDistance` observed among all pairs labeled as non-divergent, plus a 10% margin. Formula: `t_transparent = max(archDist where actuallyDivergent=false) * 1.1`. Never allow it to exceed 0.25.
- **Bounds:** `[0.01, 0.25]`
- **Minimum data:** 5 non-divergent pairs with `architectureDistance > 0` (self-comparisons at 0.0 don't help calibrate this threshold).

**`t_high_risk`** (retrievalOverlapRisk > 0.5 for high-risk verdict)

- **Current:** 0.5 (in `computeVerdict()`, rule 2)
- **Why it's wrong:** Zero pairs exist in this band. The threshold is pure guess.
- **Update rule:** Set to the minimum `retrievalOverlapRisk` observed among pairs labeled as divergent, minus a 10% margin. Formula: `t_high_risk = min(retrievalOverlapRisk where actuallyDivergent=true) * 0.9`. Clamp to bounds.
- **Bounds:** `[0.3, 0.7]`
- **Minimum data:** 3 pairs labeled as divergent with `retrievalOverlapRisk > 0.3`.
- **⚠️ CANNOT MOVE YET:** Zero high-risk/reject band data exists. This threshold is frozen until data arrives.

**`t_reject`** (retrievalOverlapRisk > 0.8 for reject verdict)

- **Current:** 0.8 (in `computeVerdict()`, rule 1)
- **Why it's wrong:** Same as `t_high_risk` — zero data in this band.
- **Update rule:** Set to the 95th percentile of `retrievalOverlapRisk` among divergent pairs. Must be strictly greater than `t_high_risk + 0.1`.
- **Bounds:** `[0.6, 0.95]`
- **Minimum data:** 5 pairs labeled as divergent, at least 2 with `retrievalOverlapRisk > 0.7`.
- **⚠️ CANNOT MOVE YET.**

#### A3. Frobenius Normalization Method

**Current:** `meanMag = (magA + magB) / 2` in `computeArchitectureDistance()`.

**Why it's wrong:** Mean normalization is one of four options. For asymmetric model pairs (e.g., 384d vs 2048d), the fingerprint magnitudes can differ substantially (21.72 vs 23.86 in our cross-family pair). Mean may over-normalize or under-normalize depending on the distribution.

**Options:**
| Method | Formula | Behavior with asymmetric magnitudes |
|--------|---------|-------------------------------------|
| mean | `(magA + magB) / 2` | Balanced, current default |
| min | `Math.min(magA, magB)` | Conservative — inflates distance for asymmetric pairs |
| max | `Math.max(magA, magB)` | Liberal — deflates distance for asymmetric pairs |
| geometric | `Math.sqrt(magA * magB)` | Scale-invariant, handles multiplicative asymmetry |

**Update rule:** NOT a continuous parameter. This is a discrete choice. Evaluate all 4 methods on the calibration set. Choose the one that produces the highest Pearson r between `architectureDistance` and `retrievalOverlapRisk`. If tied within 0.01, prefer `mean` (current, avoids churn).

**Minimum data:** 8 pairs with retrieval data, including at least 3 with asymmetric dimensions.

**⚠️ LOW PRIORITY.** Current mean works fine at pilot scale. Only revisit after high-risk band data exists.

#### A4. Per-Anchor Importance Weights

**Current:** All 27 anchors weighted equally in fingerprint computation. The distance matrix treats `anchor[0]` and `anchor[26]` as equally informative.

**Why it's wrong:** Some anchors may be near-synonyms (contribute redundant signal) while others may be maximally discriminative. Ablation data would reveal which anchors drive the most variance in `architectureDistance`.

**Update rule:** Compute leave-one-out ablation: for each anchor k, compute `architectureDistance` on the remaining 26 anchors for all pairs. The anchor whose removal causes the largest mean change in `architectureDistance` correlation with `retrievalOverlapRisk` is the most important. Weight anchors proportional to their ablation impact, normalized to sum to 1.0.

**Bounds:** `weight[i] ∈ [0.01, 0.15]` (no single anchor dominates, no anchor is zeroed).

**Minimum data:** 15 pairs with retrieval data. Ablation with fewer pairs would overfit.

**⚠️ FURTHEST FROM IMPLEMENTABLE.** Requires both substantial data and a weighted fingerprint distance function (not yet written).

#### A5. K Values — K=3 (Jaccard), K=10 (Kendall τ)

**Current:** Hardcoded in `calibration-pairs-bench.ts`. Jaccard computes set overlap at top-3 results. Kendall τ computes rank correlation at top-10.

**Why it's wrong:** K=3 was chosen because top-3 matters for RAG (the first retrieved chunk drives the answer). K=10 was chosen because rank correlation needs a longer list to be meaningful. Both are reasonable heuristics but unvalidated.

**Update rule:** Sweep K ∈ {1, 3, 5, 7, 10, 15, 20} for both metrics. For each K, compute the Pearson r between the composite risk score and the `actuallyDivergent` label (treated as 0/1). Select the K that maximizes this correlation.

**Bounds:** `K_jaccard ∈ [1, 20]`, `K_tau ∈ [3, 30]`. K_tau must be ≥ 3 (Kendall τ is degenerate below 3).

**Minimum data:** 10 pairs with per-query retrieval data stored (not just aggregate metrics — need the raw ranked lists to recompute at different K values).

**Implementation note:** The current benchmark only stores aggregate Jaccard@K3 and τ@K10. To tune K, the benchmark must be modified to store per-query ranked lists. See §E for collection pipeline changes.

---

### B. Calibration Store

#### B1. Schema

```typescript
interface CalibrationPair {
  /** Deterministic: SHA-256(modelA + ":" + modelB + ":" + corpusId).slice(0, 16) */
  id: string;

  modelA: string;
  modelB: string;
  corpusId: string;             // SHA-256 of sorted corpus chunk hashes
  corpusChunks: number;
  queriesEvaluated: number;

  // ── Measured metrics (ground truth) ──
  jaccardAtK3: number;
  kendallTauAtK10: number;
  architectureDistance: number;
  rankingInstabilityRisk: number;
  retrievalOverlapRisk: number; // computed from jaccard + tau with CURRENT weights

  // ── Per-query raw data (for K-value tuning) ──
  /** Per-query ranked list of chunk IDs from each model. null if not stored. */
  perQueryRankings: {
    query: string;
    rankingsA: string[];  // chunk IDs in rank order from model A
    rankingsB: string[];  // chunk IDs in rank order from model B
  }[] | null;

  // ── Divergence label ──
  actuallyDivergent: boolean;
  divergenceMethod: 'judge-model' | 'manual' | 'inferred-from-jaccard';
  /** For judge-model: which model evaluated answer quality divergence */
  judgeModel: string | null;
  /** What Jaccard threshold was used if divergenceMethod = 'inferred-from-jaccard' */
  divergenceThreshold: number;

  // ── Metadata ──
  measuredAt: string;           // ISO 8601
  calibrationVersion: string;   // parameter version active at measurement time (e.g., "v0-hardcoded")
  benchmarkScript: string;      // which script produced this pair (e.g., "calibration-pairs-bench.ts")

  // ── Fingerprint magnitudes (for Frobenius normalization tuning) ──
  fingerprintMagnitudes: { modelA: number; modelB: number };
  dimensions: { modelA: number; modelB: number };
}
```

#### B2. Storage Location

**File:** `vectra/data/calibration-store.json`

```json
{
  "schemaVersion": "1.0.0",
  "pairs": [ /* CalibrationPair[] */ ],
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

**Why JSON not a database:** The calibration store will grow to ~100-500 pairs over the lifetime of this project. JSON is sufficient, human-readable, git-trackable, and requires no runtime dependencies.

#### B3. Dedup and Versioning Policy

- **Dedup key:** `id` field (deterministic hash of modelA + modelB + corpusId).
- **Same pair, re-measured:** Replace the existing entry. The newer measurement supersedes. The old entry is preserved in git history (the file is committed after every update).
- **Same models, different corpus:** Different `corpusId` → different `id` → both entries kept. This is valuable — same models may behave differently on different corpora.
- **Reversed model order:** `SHA-256("A:B:corpus")` ≠ `SHA-256("B:A:corpus")`. Both are kept. `architectureDistance` is symmetric but retrieval metrics are not (model A retrieves for model B's embeddings and vice versa).

#### B4. Update Pipeline

After any benchmark run that produces calibration data:

```bash
# 1. Benchmark script outputs to stdout or a temp file
npx tsx src/benchmark/calibration-pairs-bench.ts > /tmp/new-pairs.json

# 2. Merge script (to be written: src/calibration/merge-store.ts)
npx tsx src/calibration/merge-store.ts /tmp/new-pairs.json

# 3. Commit
cd /home/agent-raw/.openclaw/workspace/vectra
git add data/calibration-store.json
git commit -m "data: add N calibration pairs (total: M)"
git push origin main
```

The merge script:
1. Reads existing `data/calibration-store.json`
2. For each new pair: if `id` exists, replace; if new, append
3. Recomputes `bandCounts` from current verdicts
4. Writes updated store
5. Returns count of added/updated pairs (the optimizer trigger check uses this)

---

### C. Threshold Optimizer Algorithm

#### C1. Trigger Condition

The optimizer runs when **all** of the following are true:

1. At least **5 new pairs** have been added since the last optimizer run (tracked in `tuning-state.md`)
2. At least **3 pairs per active band** exist (a band is "active" if ≥1 pair exists in it)
3. At least **24 hours** have elapsed since the last optimizer run (prevents rapid cycling from batch benchmark runs)

**Trigger check location:** The merge script (§B4 step 2) checks the trigger condition after merging. If triggered, it prints `OPTIMIZER_TRIGGERED` to stdout. The calling agent or script then invokes the optimizer.

#### C2. Optimization Target — Asymmetric Classification Loss

We minimize a **weighted classification error** where false positives (calling compatible models "incompatible") are penalized more than false negatives.

**Rationale:** A false positive blocks a viable model migration, which wastes operator time investigating and overriding. A false negative allows a risky migration, which might cause retrieval quality degradation — bad, but caught by monitoring. False positives are 2× worse than false negatives because they create friction in a system designed to enable flexibility.

**Loss function:**

```typescript
function asymmetricLoss(
  pairs: CalibrationPair[],
  params: ESPParams,
): number {
  const FP_WEIGHT = 2.0;  // false positive penalty
  const FN_WEIGHT = 1.0;  // false negative penalty

  let totalLoss = 0;

  for (const pair of pairs) {
    // Recompute verdict with candidate params
    const riskScore = 1 - (params.wJaccard * pair.jaccardAtK3 + (1 - params.wJaccard) * pair.kendallTauAtK10);
    const predictedDivergent = riskScore > params.tHighRisk || pair.architectureDistance > params.tTransparentUpper;
    const actual = pair.actuallyDivergent;

    if (predictedDivergent && !actual) {
      totalLoss += FP_WEIGHT;  // false positive
    } else if (!predictedDivergent && actual) {
      totalLoss += FN_WEIGHT;  // false negative
    }
    // correct predictions: +0
  }

  return totalLoss / pairs.length;  // normalize by pair count
}
```

Where `tTransparentUpper` is the architectureDistance above which we stop calling things "transparent", and `tHighRisk` is the retrievalOverlapRisk above which we call things "high-risk".

The loss function treats the problem as: "given these thresholds, how often do we misclassify compatibility?"

#### C3. Fitting Algorithm — Grid Search (Recommended)

**Recommendation: Option A (Grid Search).** Rationale:
- Interpretable: every candidate parameter set can be inspected
- No numeric library dependencies (pure TypeScript loops)
- The parameter space is small (5 continuous params, each bounded)
- The dataset will be small (10-100 pairs) — grid search is fast
- Logistic regression would be more principled but requires implementing gradient descent or a solver in TypeScript, adding complexity for marginal gain at this data scale

**Grid definition:**

```typescript
interface ESPParams {
  wJaccard: number;         // [0.0, 1.0] step 0.05 → 21 values
  tTransparent: number;     // [0.01, 0.25] step 0.02 → 13 values
  tHighRisk: number;        // [0.3, 0.7] step 0.05 → 9 values
  tReject: number;          // [0.6, 0.95] step 0.05 → 8 values
}

// Constraint: tReject > tHighRisk + 0.1
// Total grid points (with constraint): ~21 × 13 × 9 × 8 × ~0.5 (constraint filter) ≈ 9,828
// At ~1μs per evaluation, full grid search takes <10ms. Trivial.
```

**Algorithm:**

```
1. Load calibration store
2. Split into train (80%) and holdout (20%), stratified by verdict band
   - If total pairs < 15, use leave-one-out cross-validation instead of holdout
3. For each point in the grid:
   a. Check constraint: tReject > tHighRisk + 0.1
   b. Compute asymmetricLoss on train set
   c. Record loss
4. Select the parameter set with lowest train loss
5. Evaluate on holdout set
6. Apply Circuit Breaker 1 (§K) — if holdout loss is WORSE, auto-rollback
7. Return best params
```

#### C4. Guard Conditions — When NOT to Update

| Guard | Threshold | Rationale |
|-------|-----------|-----------|
| Minimum total pairs | ≥ 5 (pilot confidence) | Below 5, any grid search result is noise. Circuit Breaker 5 enforces this. |
| Minimum pairs per active band | ≥ 5 | Circuit Breaker 4 — a band with <5 pairs cannot have its threshold moved. Zero exceptions. |
| Maximum parameter shift per cycle | `\|Δw_jaccard\| ≤ 0.15`, `\|Δt_*\| ≤ 0.15` | Prevents oscillation. If the optimizer wants more, it applies 0.15 max and re-evaluates next cycle. |
| Pearson r threshold for weight refit | r ≥ 0.4 | Circuit Breaker 3 — if correlation breaks, auto-rollback weights |
| Holdout overfitting check | holdout loss ≤ 1.5 × train loss | Circuit Breaker 1 — auto-rollback on holdout regression |
| Band-specific freeze | A threshold can only move if its band has ≥ 5 pairs | Circuit Breaker 4 — hard lock, no exceptions |

**Frozen thresholds (as of spec date):**
- `t_high_risk`: FROZEN (0 pairs in band, need ≥5)
- `t_reject`: FROZEN (0 pairs in band, need ≥5)
- `w_jaccard`: FROZEN (only 1 cross-family pair with retrieval data; need ≥ 10)
- `t_transparent`: FROZEN (only 2 self-comparison pairs at archDist=0; need 5 non-trivial pairs)

**First threshold that can move:** `t_transparent`, once 5 non-self cross-family pairs with `actuallyDivergent=false` are collected. At current pace, this requires ~2 more benchmark runs with new model pairs.

#### C5. The Update Transaction

When the optimizer produces a valid update (all guards pass AND all circuit breakers clear):

1. **Snapshot** current params as `preUpdateParams` (for rollback)
2. **Read** current `atp-instance/vars/esp-params.md`
3. **Append** current params to the `## Update History` section (rollback trail)
4. **Write** new params to the `## Current Parameters` section
5. **Run Circuit Breaker 1** — evaluate holdout loss with new params
   - If holdout loss WORSE than `preUpdateParams` holdout loss: **auto-rollback** immediately, restore `preUpdateParams`, log reason, flag triggering pairs as potential outliers, DONE
   - If holdout loss BETTER or equal: proceed
6. **Run Circuit Breaker 3** — recompute Pearson r on full calibration set
   - If r < 0.4: **auto-rollback**, flag triggering pairs, block weight updates until 3 more non-outlier pairs added
   - If r < 0.3 for 2 consecutive runs: trigger **safe harbor** (Circuit Breaker 6)
7. **Update** `lastOptimizerRun` timestamp and `calibrationPairCount` in the var
8. **Update** `src/embedding/compatibility.ts` constants automatically — the learned values are applied to the source code immediately. No human gate.
9. **Commit** all files:
   ```bash
   git -C /home/agent-raw/.openclaw/workspace/atp-instance add vars/esp-params.md
   git -C /home/agent-raw/.openclaw/workspace/vectra add data/calibration-store.json src/embedding/compatibility.ts
   git commit -m "tune(esp): update params — N pairs, loss X.XXX → Y.YYY [optimizer-v1, CB-clear]"
   git push
   ```

**Rollback:** Handled automatically by circuit breakers. No manual intervention needed. See §K for all rollback scenarios.

---

### D. ESP Parameter Var — `atp-instance/vars/esp-params.md`

```markdown
---
id: esp-params
name: ESP Learned Parameters
version: 0.2.0
status: active
created: 2026-04-09
last_verified: 2026-04-09
verified_by: recursive-self-improvement-spec
classification: private
validator: calibration-count
staleness_policy: on-change-only
verify_cmd: |
  cd /home/agent-raw/.openclaw/workspace/vectra
  PAIR_COUNT=$(node -e "const d=require('./data/calibration-store.json'); console.log(d.pairCount)")
  echo "calibration_pairs=$PAIR_COUNT"
  BANDS=$(node -e "const d=require('./data/calibration-store.json'); console.log(JSON.stringify(d.bandCounts))")
  echo "band_counts=$BANDS"
  echo "params_version=v0-hardcoded"
source: optimizer
---

# ESP Learned Parameters

## Current Parameters

| Parameter | Value | Source | Confidence |
|-----------|-------|--------|------------|
| `w_jaccard` | 0.6 | hardcoded | uncalibrated |
| `w_tau` | 0.4 | hardcoded | uncalibrated |
| `t_transparent` | 0.1 | hardcoded | uncalibrated |
| `t_high_risk` | 0.5 | hardcoded | frozen (0 band pairs) |
| `t_reject` | 0.8 | hardcoded | frozen (0 band pairs) |
| `frob_norm_method` | mean | hardcoded | uncalibrated |
| `K_jaccard` | 3 | hardcoded | uncalibrated |
| `K_tau` | 10 | hardcoded | uncalibrated |

**Optimizer version:** n/a (not yet run)
**Calibration pairs at last update:** 3
**Last optimizer run:** never

## Confidence Tiers

| Tier | Required Pairs | Required Bands | Meaning |
|------|----------------|----------------|---------|
| uncalibrated | 0-4 | any | Hardcoded defaults; optimizer cannot run |
| pilot | 5-19 | ≥2 with ≥5 each | First optimizer pass possible; circuit breakers active |
| preliminary | 20-49 | ≥3 with ≥5 each | Multiple optimizer cycles; convergence visible |
| validated | 50+ | all 4 with ≥10 each | Full coverage; parameters stable across cycles |

## Safe Harbor Parameters

These are the initial hardcoded values. Circuit Breaker 6 reverts to these on degraded state detection.

| Parameter | Safe Harbor Value |
|-----------|-------------------|
| `w_jaccard` | 0.6 |
| `w_tau` | 0.4 |
| `t_transparent` | 0.1 |
| `t_high_risk` | 0.5 |
| `t_reject` | 0.8 |
| `frob_norm_method` | mean |
| `K_jaccard` | 3 |
| `K_tau` | 10 |

## Update History

_No updates yet. History entries will be appended here by the optimizer._

<!-- Format for history entries:
### Update <N> — <ISO date>
- **Pairs:** <count>
- **Band counts:** transparent=N, caution=N, high-risk=N, reject=N
- **Train loss:** <value>
- **Holdout loss:** <value>
- **Changed params:** <param>: <old> → <new>, ...
- **Optimizer version:** <version>
- **Circuit breakers:** all clear / CB-1 triggered (rollback) / CB-3 triggered / etc.
-->
```

---

### E. Feedback Collection Paths

#### E1. Automatic Collection (Benchmark Pipeline)

**Source:** `src/benchmark/calibration-pairs-bench.ts` and `src/benchmark/cross-model-esv-bench.ts`

**Current gap:** These scripts output results to `docs/calibration-pairs-results.json` but do NOT write to the calibration store.

**Required changes:**

1. **Modify `calibration-pairs-bench.ts`** to:
   - Accept a `--store` flag that writes directly to `data/calibration-store.json`
   - Compute the deterministic `id` for each pair
   - Include `perQueryRankings` in output (currently discarded after aggregation)
   - Set `divergenceMethod: 'inferred-from-jaccard'` with `divergenceThreshold: 0.5` (default; a pair with Jaccard@K3 < 0.5 is labeled divergent)
   - Call the merge logic inline (no separate merge script needed for automated path)

2. **Create `src/calibration/merge-store.ts`** (~80 lines):
   - Reads existing store, merges new pairs, recomputes band counts
   - Checks optimizer trigger condition
   - Prints `OPTIMIZER_TRIGGERED` if threshold met
   - Exports `mergeCalibrationStore(newPairs: CalibrationPair[]): { added: number; updated: number; triggered: boolean }`

3. **Create `src/calibration/optimizer.ts`** (~300 lines):
   - Implements the grid search from §C3
   - Reads `data/calibration-store.json` and `atp-instance/vars/esp-params.md`
   - Outputs candidate params + loss to stdout
   - Writes updated var file if all guards pass
   - Runs all 6 circuit breakers autonomously
   - Never prints `HUMAN_REVIEW_REQUIRED` — handles everything autonomously

**Pipeline (fully autonomous):**
```
benchmark run
  → calibration-pairs-bench.ts --store
    → merge-store.ts (inline)
      → if OPTIMIZER_TRIGGERED:
        → optimizer.ts
          → if guards pass:
            → run circuit breakers 1-6
            → if all clear: update esp-params.md + compatibility.ts + commit
            → if any CB triggers: auto-rollback/freeze/safe-harbor as appropriate + commit + log
          → if guards fail:
            → log reason, increment no-update counter, check meta-loop signals
```

#### E2. Manual Collection

When Raw runs a new model and evaluates quality manually:

1. Raw runs the benchmark and sees results
2. Raw can manually label a pair by editing `data/calibration-store.json` directly:
   - Set `actuallyDivergent` to true/false based on judgment
   - Set `divergenceMethod: 'manual'`
   - Set `judgeModel: null`
3. Commit and push

Alternatively, a CLI helper (future):
```bash
npx tsx src/calibration/label-pair.ts --pair-id <id> --divergent true|false
```

#### E3. Passive Collection (Runtime ESP Integration)

If ESP is ever integrated into the Vectra context pipeline (issuing verdicts on real embedding model swaps):

**Required hooks:**

1. **Verdict logging hook:** When `computeCompatibilityProfile()` is called in a real pipeline execution (not a benchmark), log the profile to `data/runtime-verdicts.json`:
   ```typescript
   interface RuntimeVerdict {
     profile: CompatibilityProfile;
     pipelineRunId: string;
     queryCount: number;
     // Filled in post-hoc after monitoring retrieval quality:
     actualOutcome: 'no-issue' | 'quality-degradation' | 'unknown';
     outcomeObservedAt: string | null;
   }
   ```

2. **Quality monitoring hook:** After a model swap governed by an ESP verdict, track retrieval quality metrics for the next N queries. If quality drops below baseline → label the swap as divergent → write a new calibration pair to the store.

3. **Feedback delay:** Runtime verdicts need a delay (hours to days) before the `actualOutcome` can be assessed. The passive collection path writes the verdict immediately with `actualOutcome: 'unknown'`, then a periodic job (heartbeat or cron) checks for quality signals and backfills the label.

**Implementation priority:** LOW. This path requires ESP to be wired into a live pipeline, which is not the current focus.

---

## LOOP 2: ATP Execution Tuning

### F. ATP Outcome Signal

#### F1. Schema

```typescript
interface ATPExecutionRecord {
  /** Same as handoff artifact bundle_id */
  bundleId: string;
  protocolId: string;
  modelClass: string;              // 'fast' | 'balanced' | 'agent' | 'capable'
  /** Actual model used (e.g., 'xai/grok-4-1-fast') */
  actualModel: string;
  taskDescription: string;
  startedAt: string;               // ISO 8601
  completedAt: string;             // ISO 8601
  durationSeconds: number;

  // ── Outcome quality signals ──
  outcome: 'success' | 'partial' | 'failure' | 'escalated';
  receiptVerified: boolean;
  retriesUsed: number;
  /** Tokens used if available from model response metadata; -1 if unknown */
  tokensUsed: number;
  /** Estimated cost in USD; -1 if unknown */
  estimatedCostUsd: number;

  // ── For tuning ──
  taskComplexity: 'mechanical' | 'analytical' | 'judgment';
  /** Post-hoc label: what's the cheapest model class that would have succeeded? null if unknown */
  minSufficientModelClass: string | null;

  // ── Var staleness signals ──
  varsVerified: {
    varId: string;
    stalenessPolicyUsed: string;
    verifyRan: boolean;
    stateChanged: boolean;          // did verify_cmd reveal state different from cached?
  }[];
}
```

#### F2. Storage

**File:** `atp-instance/data/execution-records.json`

```json
{
  "schemaVersion": "1.0.0",
  "records": [ /* ATPExecutionRecord[] */ ],
  "lastUpdated": "2026-04-09T00:00:00Z",
  "recordCount": 0,
  "summaries": {
    "byProtocolAndModel": {
      "vectra-build": {
        "agent": { "total": 0, "success": 0, "partial": 0, "failure": 0, "escalated": 0 }
      }
    },
    "varChangeFrequency": {
      "dgx-serve": { "verifyCount": 0, "changedCount": 0, "changeRate": 0.0 }
    }
  }
}
```

#### F3. Population

**Source:** The handoff artifact (`atp-instance/artifacts/<bundle_id>.json`) already contains most fields. The gap:

| Field | Available in handoff artifact? | Gap |
|-------|-------------------------------|-----|
| bundleId | ✅ | — |
| protocolId | ✅ | — |
| modelClass | ✅ (from bundle) | — |
| actualModel | ❌ | Need to extract from sub-agent session metadata |
| taskDescription | ✅ | — |
| startedAt / completedAt | ✅ | — |
| durationSeconds | ✅ (computed) | — |
| outcome | ✅ (in receipt) | — |
| receiptVerified | ✅ (manifest check) | — |
| retriesUsed | ❌ | Need orchestrator to track retry count per bundle |
| tokensUsed | ❌ | Need model provider to report; may be unavailable |
| estimatedCostUsd | ❌ | Derive from model + tokens; approximate |
| taskComplexity | ❌ | Infer from protocol: vectra-build=analytical, memory-maintenance=mechanical, atp-review=judgment |
| minSufficientModelClass | ❌ | Inferred post-hoc; null by default |
| varsVerified | ❌ | Need sub-agent to report verify_cmd outcomes in receipt |

**Required changes:**

1. **Modify handoff artifact schema** to include `varsVerified` array (sub-agent reports which vars were verified and whether state changed)
2. **Modify orchestration-main.md** to record `retriesUsed` when retry-before-escalation occurs
3. **Create `src/atp/record-collector.ts`** (~60 lines) that reads a handoff artifact and writes an execution record to the store
4. **Add to post-execution flow:** After orchestrator reads outcome report (orchestration-main.md §Outcome Report Handling step 2), call the record collector

**Default complexity mapping (until human labels available):**

| Protocol | Default Complexity |
|----------|-------------------|
| `openclaw-config-change` | mechanical |
| `dgx-inference-ops` | analytical |
| `crew-ops` | mechanical |
| `crew-peering` | mechanical |
| `cradleos-deploy` | analytical |
| `vectra-build` | analytical |
| `memory-maintenance` | mechanical |
| `atp-protocol-review` | judgment |

---

### G. Tunable ATP Parameters

#### G1. Model Class Per Protocol

**Current:** Hardcoded in `orchestration-main.md` routing table:

| Protocol | Current Model Class |
|----------|-------------------|
| openclaw-config-change | fast |
| dgx-inference-ops | balanced |
| crew-ops | fast |
| crew-peering | fast |
| cradleos-deploy | balanced |
| vectra-build | agent |
| memory-maintenance | fast |
| atp-protocol-review | capable |

**Outcome signal:** Success rate at current model class vs. cheaper alternative.

**Update rule:** For a given protocol, if the last **10 consecutive executions** at model class M all succeeded (`outcome = 'success'`), downgrade to the next cheaper class autonomously. The hierarchy is: `capable > agent > balanced > fast`.

**Guards:**
- Never downgrade below `fast` (floor)
- Never downgrade `atp-protocol-review` below `agent` (judgment tasks require reasoning)
- Require 10 consecutive successes, not 10 total (one failure resets the counter)
- A single failure after downgrade triggers immediate auto-rollback to previous class (Circuit Breaker pattern — no human needed)
- Maximum one downgrade per protocol per 30-day window

**Upgrade rule:** If 2 of the last 5 executions at class M failed (`outcome = 'failure'` or `'escalated'`), upgrade to next tier immediately. No guard — upgrades are always safe (more capability, more cost).

#### G2. Staleness TTL Per Var

**Current:**

| Var | Staleness Policy |
|-----|-----------------|
| openclaw-config-state | session-cache |
| dgx-serve | always-verify |
| model-registry | ttl:7d |
| crew-state | session-cache |
| cradleos-pkg | ttl:7d |
| vectra-state | always-verify |

**Outcome signal:** The `varsVerified.stateChanged` field from execution records.

**Update rule:** Track the **change rate** for each var: `changedCount / verifyCount`. Adapt policy autonomously:

| Change Rate | Recommended Policy | Rationale |
|-------------|-------------------|-----------|
| > 0.5 | always-verify | State changes more often than not → must always check |
| 0.1 – 0.5 | ttl:1d | Changes regularly but not every time |
| 0.01 – 0.1 | ttl:7d | Rarely changes |
| < 0.01 | ttl:30d | Almost never changes |

**Guards:**
- Minimum 20 verification observations before changing policy
- Never weaken `dgx-serve` below `ttl:1d` (infrastructure state is critical — hard floor)
- Conservative bias: if change rate is within 0.05 of a boundary, keep the more aggressive (fresher) policy
- Post-weakening monitoring: if a stale-state-caused failure occurs within 7 days of a TTL weakening, auto-rollback to previous policy and increase minimum observation count to 40 for next weakening attempt

#### G3. Escalation Retry Count

**Current:** 1 retry before surfacing to Raw.

**Outcome signal:** `retriesUsed` and `outcome` from execution records.

**Metrics to track:**
- `firstRetrySuccessRate`: of executions that failed first attempt and retried, what fraction succeeded on retry?
- `secondRetrySuccessRate`: (if retry count > 1) what fraction succeeded on second retry?

**Update rule:**
- If `firstRetrySuccessRate < 0.2` over last 20 retried executions → reduce to 0 retries (retrying is wasteful)
- If `firstRetrySuccessRate > 0.6` → consider increasing to 2 retries (retrying works, a second might too)
- Increase to 2 retries only if `secondRetrySuccessRate > 0.3` (based on 10+ observations at retry=2)

**Guards:**
- Retry count ∈ [0, 3] (hard bounds)
- Minimum 20 observations of retry outcomes before changing
- Conservative bias: default to 1 (current) unless strong evidence

---

### H. ATP Tuning Algorithm

ATP tuning uses **simple threshold rules** rather than grid search. Rationale: the feedback signal is noisy, the parameter space is discrete (model class tiers, TTL buckets), and the conservative bias means we should only move with overwhelming evidence.

#### H1. Model Class Downgrade Decision

```typescript
function shouldDowngradeModelClass(
  protocolId: string,
  records: ATPExecutionRecord[],
  currentClass: string,
): { shouldDowngrade: boolean; evidence: string } {
  // Filter to this protocol at current model class
  const relevant = records.filter(r =>
    r.protocolId === protocolId && r.modelClass === currentClass
  );

  if (relevant.length < 10) {
    return { shouldDowngrade: false, evidence: `insufficient data (${relevant.length}/10)` };
  }

  // Check last 10 consecutive
  const lastTen = relevant.slice(-10);
  const allSuccess = lastTen.every(r => r.outcome === 'success');

  if (!allSuccess) {
    return { shouldDowngrade: false, evidence: 'not all last 10 succeeded' };
  }

  // Check floor
  if (currentClass === 'fast') {
    return { shouldDowngrade: false, evidence: 'already at floor' };
  }

  // Check protocol floor
  const protocolFloors: Record<string, string> = {
    'atp-protocol-review': 'agent',
  };
  const floor = protocolFloors[protocolId];
  if (floor && modelClassRank(currentClass) <= modelClassRank(floor)) {
    return { shouldDowngrade: false, evidence: `at protocol floor (${floor})` };
  }

  return { shouldDowngrade: true, evidence: '10 consecutive successes at current tier' };
}

function modelClassRank(cls: string): number {
  return { fast: 0, balanced: 1, agent: 2, capable: 3 }[cls] ?? -1;
}
```

#### H2. Staleness TTL Drift Signal

```typescript
function computeRecommendedStaleness(
  varId: string,
  records: ATPExecutionRecord[],
): { policy: string; changeRate: number; observations: number } {
  let verifyCount = 0;
  let changedCount = 0;

  for (const r of records) {
    for (const v of r.varsVerified) {
      if (v.varId === varId && v.verifyRan) {
        verifyCount++;
        if (v.stateChanged) changedCount++;
      }
    }
  }

  if (verifyCount < 20) {
    return { policy: 'current', changeRate: -1, observations: verifyCount };
  }

  const rate = changedCount / verifyCount;

  let policy: string;
  if (rate > 0.5) policy = 'always-verify';
  else if (rate > 0.1) policy = 'ttl:1d';
  else if (rate > 0.01) policy = 'ttl:7d';
  else policy = 'ttl:30d';

  // Conservative bias: if within 0.05 of a boundary, keep fresher
  if (rate > 0.45 && rate <= 0.5) policy = 'always-verify';
  if (rate > 0.05 && rate <= 0.1) policy = 'ttl:1d';

  return { policy, changeRate: rate, observations: verifyCount };
}
```

#### H3. Conservative Bias Rule

**Principle:** In ATP tuning, the cost of under-capability (task failure) vastly exceeds the cost of over-capability (wasted tokens). Therefore:

1. **Model class:** Default to current or higher. Downgrade only with 10 consecutive successes. Upgrade immediately on 2/5 failures. Post-downgrade failure → immediate auto-rollback (no human needed).
2. **Staleness:** Default to fresher. Weaken only with 20+ observations showing low change rate. Post-weakening stale-state failure → immediate auto-rollback.
3. **Retries:** Default to 1. Only remove if retry success rate is very low (<0.2). Only add if retry success rate is high (>0.6).

---

### I. Unified Feedback Store — `atp-instance/vars/tuning-state.md`

```markdown
---
id: tuning-state
name: Unified Tuning State
version: 0.2.0
status: active
created: 2026-04-09
last_verified: 2026-04-09
verified_by: recursive-self-improvement-spec
classification: private
validator: json-config
staleness_policy: on-change-only
verify_cmd: |
  echo "=== ESP calibration ==="
  cd /home/agent-raw/.openclaw/workspace/vectra
  node -e "const d=require('./data/calibration-store.json'); console.log(JSON.stringify(d.bandCounts))"
  echo "=== ATP records ==="
  cd /home/agent-raw/.openclaw/workspace/atp-instance
  node -e "const d=require('./data/execution-records.json'); console.log('records:', d.recordCount)"
source: optimizer
---

# Unified Tuning State

## ESP State

### Calibration Band Counts
| Band | Pairs | Minimum for Threshold Tuning |
|------|-------|------------------------------|
| transparent | 2 | 5 |
| caution | 1 | 5 |
| high-risk | 0 | 5 |
| reject | 0 | 5 |

### Current Learned Parameters
See `vars/esp-params.md` for full table.
**Summary:** All parameters at v0-hardcoded defaults. No optimizer runs yet.

### Last ESP Optimizer Run
- **Timestamp:** never
- **Pairs at run:** n/a
- **Result:** n/a

### Circuit Breaker State
- **CB-1 (post-update validation) rollbacks:** 0
- **CB-2 (oscillation freeze) active freezes:** none
- **CB-3 (Pearson r guard) consecutive low-r runs:** 0
- **CB-4 (band coverage lock) frozen bands:** transparent, caution, high-risk, reject (all <5 pairs)
- **CB-5 (confidence floor) status:** uncalibrated — proposals only, no auto-apply
- **CB-6 (degraded state) status:** nominal
- **Outlier-flagged pairs:** none
- **Proposal log entries:** 0

## ATP State

### Execution Record Summary

_No execution records yet._

<!-- Format when populated:
| Protocol | Model Class | Total | Success | Partial | Failure | Escalated | Success Rate |
|----------|-------------|-------|---------|---------|---------|-----------|-------------|
| vectra-build | agent | 5 | 4 | 1 | 0 | 0 | 0.80 |
-->

### Var Change Frequency

_No verification observations yet._

<!-- Format when populated:
| Var ID | Verify Count | Changed Count | Change Rate | Current Policy | Recommended |
|--------|-------------|---------------|-------------|----------------|-------------|
| dgx-serve | 20 | 12 | 0.60 | always-verify | always-verify |
-->

### Last ATP Optimizer Run
- **Timestamp:** never
- **Records at run:** n/a
- **Result:** n/a

## Optimizer Trigger Status

### ESP Trigger
- **Pairs since last run:** 0 (need 5)
- **Bands with ≥5 pairs:** 0 (need ≥2 active bands with ≥5 each)
- **Hours since last run:** n/a
- **Triggered:** NO

### ATP Trigger
- **Records since last run:** 0 (need 20)
- **Hours since last run:** n/a
- **Triggered:** NO

## Meta-Loop State

- **ESP optimizer rollbacks (total):** 0
- **ESP optimizer rollbacks (last 5 cycles):** 0
- **ATP optimizer rollbacks:** 0
- **Consecutive no-update runs (ESP):** 0
- **Consecutive no-update runs (ATP):** 0
- **Rollback rate (last 10 ESP optimizer runs):** n/a
- **Safe harbor activations:** 0
- **Last safe harbor recovery:** never
```

---

## LOOP 3: The Meta-Loop

### J. What the Improvement System Optimizes About Itself — Fully Autonomous

The optimizer has its own parameters:

| Meta-Parameter | Current Value | What It Controls |
|----------------|---------------|------------------|
| `N_esp_trigger` | 5 new pairs | How many new pairs trigger an ESP optimizer run |
| `N_atp_trigger` | 20 new records | How many new records trigger an ATP optimizer run |
| `FP_WEIGHT` | 2.0 | False positive penalty in ESP loss function |
| `FN_WEIGHT` | 1.0 | False negative penalty in ESP loss function |
| `MIN_PAIRS_PER_BAND` | 5 | Minimum pairs in a band before its threshold can move |
| `MAX_PARAM_SHIFT` | 0.15 | Maximum single-cycle parameter change |
| `CONSECUTIVE_SUCCESS_FOR_DOWNGRADE` | 10 | ATP model class downgrade threshold |
| `MIN_VERIFY_OBS` | 20 | Minimum observations before staleness policy changes |
| `HOLDOUT_FRACTION` | 0.20 | Fraction of calibration set reserved for validation |

#### J1. Autonomous Meta-Parameter Adaptation

The meta-loop monitors 5 signals and acts without human intervention:

| Signal | Detection | Autonomous Response |
|--------|-----------|---------------------|
| Guards too strict | 5+ consecutive no-update optimizer runs | Decrease `MIN_PAIRS_PER_BAND` by 1 (floor: 3). Max 3 consecutive relaxations. |
| Trigger too aggressive | >40% rollback rate over last 10 optimizer runs | Increase `N_esp_trigger` by 50% (e.g., 5→8). Increase `N_atp_trigger` by 50%. |
| Oscillation | Parameter flips direction 2× in a row | Circuit Breaker 2: freeze parameter for 3 cycles, widen min-pairs by 50%. |
| Overfitting | Holdout loss > train loss by >15% | Increase `HOLDOUT_FRACTION` from 0.20 to 0.35. If already 0.35, increase `MIN_PAIRS_PER_BAND` by 1. |
| Geometric approach degraded | r < 0.3 on 2 consecutive runs | Circuit Breaker 3 + Circuit Breaker 6 (safe harbor). |

**All responses are autonomous.** No human approval, no review artifacts for meta-parameter changes.

#### J2. Detection and Action Flow

The meta-loop runs as a **post-optimizer check** — not a separate scheduled job. After every optimizer run (whether it updated params or not), the optimizer script:

1. Reads `tuning-state.md` meta-loop counters
2. Checks for any of the signals in §J1
3. If a signal is detected:
   - Applies the autonomous response immediately
   - Logs the meta-parameter change to `tuning-state.md → ## Meta-Loop Adaptation Log`
   - Commits: `meta(tune): <signal> detected — <response applied>`
4. If no signal detected: updates counters and continues

**No review artifacts. No pending reviews. No human gates.**

#### J3. Rollback Mechanism

When the optimizer produces a bad update (detected by circuit breakers):

**ESP rollback:**
1. Circuit breaker (1, 3, or 6) detects the problem automatically
2. Read `esp-params.md → ## Update History` last entry before the bad update
3. Write those params back as `## Current Parameters`
4. Update `compatibility.ts` to match rolled-back values
5. Increment `tuning-state.md → ESP optimizer rollbacks`
6. Commit: `revert(esp): auto-rollback to <date> — CB-<N> triggered: <reason>`

**ATP rollback:**
1. Post-downgrade failure detected (1 failure after downgrade)
2. Read previous model class from execution records
3. Rewrite `orchestration-main.md` routing table entry
4. Increment `tuning-state.md → ATP optimizer rollbacks`
5. Commit: `revert(atp): auto-rollback <protocol> model class to <class> — post-downgrade failure`

**Meta-parameter rollback:** If a meta-parameter adaptation causes 3 consecutive circuit breaker triggers, revert the meta-parameter to its default value and freeze it for 10 optimizer cycles.

---

### K. Autonomous Circuit Breakers

**v0.2.0: This section replaces the former "Human Checkpoints" section entirely.**

There are no human gates in this system. Every scenario previously requiring human approval is handled by one of 6 autonomous circuit breakers that validate mathematically, rollback automatically, and recover without intervention.

#### K1. Circuit Breaker 1 — Post-Update Validation

**Replaces:** First-ever optimizer run approval gate, large threshold shift review.

**Trigger:** After every parameter update attempt.

**Mechanism:**
1. Before applying new params, snapshot current params as `preUpdate`
2. Split calibration set: 80% train, 20% holdout (deterministic split by pair ID hash)
3. Compute `asymmetricLoss(holdout, newParams)` and `asymmetricLoss(holdout, preUpdate)`
4. **If holdout loss with new params > holdout loss with old params:** AUTO-ROLLBACK
   - Restore `preUpdate` params immediately
   - Log: `CB-1 triggered: holdout loss regression (old={X}, new={Y})`
   - Flag the calibration pairs added since last successful update as potential outliers
   - Increment rollback counter in `tuning-state.md`
5. **If holdout loss with new params ≤ holdout loss with old params:** APPLY
   - No gate, no review, no approval needed
   - The math says it's better → it's better

**Concrete thresholds:**
- Holdout fraction: 0.20 (configurable by meta-loop, range [0.20, 0.35])
- Split method: deterministic hash of pair ID mod 5, bucket 0 = holdout
- Loss comparison: strict inequality (new must be ≤ old, not just close)

#### K2. Circuit Breaker 2 — Oscillation Freeze

**Replaces:** Meta-parameter human approval gate for oscillating params.

**Trigger:** Any parameter moves in opposite directions across 2 consecutive optimizer runs.

**Mechanism:**
1. After each optimizer run, record the direction of change for each parameter: `+`, `-`, or `0`
2. Compare against the previous run's direction record
3. **If param P moved `+` then `-` (or vice versa) across 2 consecutive runs:** FREEZE P
   - P cannot be updated for the next 3 optimizer cycles
   - Increase `MIN_PAIRS_PER_BAND` requirement for P's band by 50% (rounded up)
   - Log: `CB-2 triggered: oscillation freeze on {P} for 3 cycles`
4. **After 3 frozen cycles, retry.** If oscillation recurs:
   - Permanently set P's minimum-pairs requirement to 2× original
   - Log: `CB-2 escalation: permanent minimum-pairs increase for {P}`

**Concrete thresholds:**
- Detection window: 2 consecutive runs
- Initial freeze duration: 3 optimizer cycles
- Min-pairs increase on first freeze: 50% (e.g., 5 → 8)
- Min-pairs increase on repeat freeze: 100% of original (e.g., 5 → 10, permanently)

**Tracking:**
```typescript
interface OscillationState {
  paramId: string;
  lastDirection: '+' | '-' | '0';
  freezeRemainingCycles: number;    // 0 = not frozen
  permanentMinPairsMultiplier: number;  // 1.0 = default, 1.5 = first freeze, 2.0 = permanent
}
```

#### K3. Circuit Breaker 3 — Pearson r Guard

**Replaces:** "Accumulating unreviewed checkpoints" signal, human review for correlation breakdown.

**Trigger:** After every optimizer run that updates composite weights (`w_jaccard`).

**Mechanism:**
1. Recompute Pearson r between `architectureDistance` and `retrievalOverlapRisk` on the FULL calibration set (train + holdout)
2. **If r < 0.4:** AUTO-ROLLBACK weights to previous version
   - Flag the pairs added since last successful weight update as potential outliers
   - Block weight updates until 3 more non-outlier pairs are added
   - Log: `CB-3 triggered: Pearson r={X} < 0.4 — weight rollback, 3 new pairs required`
3. **If r < 0.3 for 2 consecutive optimizer runs:** DEGRADED STATE
   - Mark geometric approach as `degraded` in `tuning-state.md`
   - Route ALL ESP verdicts to `caution` (override verdict computation)
   - Do NOT update any weights until 5 new pairs restore r > 0.5
   - If degraded persists, Circuit Breaker 6 activates
   - Log: `CB-3 escalation: geometric approach degraded — all verdicts forced to caution`

**Concrete thresholds:**
- Rollback threshold: r < 0.4
- Degraded threshold: r < 0.3 for 2 consecutive runs
- Recovery from rollback: 3 new non-outlier pairs
- Recovery from degraded: 5 new pairs with r > 0.5

#### K4. Circuit Breaker 4 — Band Coverage Lock

**Replaces:** "Human confirms band coverage is sufficient" gate.

**Trigger:** Before any threshold update attempt.

**Mechanism:**
- Verdict thresholds for a band CANNOT move unless that band has **≥5 labeled pairs** in it
- Zero exceptions. Not 4. Not "4 plus a manual override." Five.
- This is checked before the grid search even considers candidate values for that threshold
- If a grid search winner would move a frozen threshold, the movement is silently dropped and the next-best candidate that respects the freeze is selected

**Concrete thresholds:**
- Minimum pairs per band: 5 (adjustable by meta-loop, floor: 3)
- Applies to: `t_transparent`, `t_high_risk`, `t_reject` independently
- `w_jaccard` has its own minimum (10 cross-family pairs with retrieval data)

**Current freeze status (3 calibration pairs):**
- `t_transparent`: FROZEN (2 pairs in transparent band, need 5)
- `t_high_risk`: FROZEN (0 pairs in high-risk band, need 5)
- `t_reject`: FROZEN (0 pairs in reject band, need 5)

#### K5. Circuit Breaker 5 — Confidence Floor

**Replaces:** First-ever optimizer run requiring human approval.

**Trigger:** Before any parameter update is applied.

**Mechanism:**
1. Check `calibration_confidence` tier from pair count and band coverage
2. **If confidence is `uncalibrated` (< 5 pairs):**
   - The optimizer runs normally (grid search, loss computation, everything)
   - But results are written to a **proposal log** in `tuning-state.md → ## Proposal Log`, NOT applied
   - Format: `{date, proposedParams, trainLoss, holdoutLoss, pairCount, status: 'pending'}`
3. **The moment confidence reaches `pilot` (≥ 5 pairs, ≥2 bands with ≥5 each):**
   - Read the most recent proposal from the proposal log
   - Re-validate it against current data (run circuit breakers 1, 3, 4)
   - If it passes: apply automatically. Mark proposal as `applied`.
   - If it fails: discard. Mark proposal as `discarded`. Run a fresh optimizer with current data.
4. **No human needed at any stage.** The confidence floor is a mathematical gate, not a human gate.

**Concrete thresholds:**
- `uncalibrated`: 0–4 pairs → proposals only
- `pilot`: 5–19 pairs, ≥2 bands with ≥5 each → first auto-apply eligible
- `preliminary`: 20–49 pairs → normal operation
- `validated`: 50+ pairs → full confidence

#### K6. Circuit Breaker 6 — Degraded State Auto-Recovery (Safe Harbor)

**Replaces:** All remaining human escalation paths.

**Trigger:** System detects degraded state:
- Pearson r < 0.3 for 2 consecutive optimizer runs, OR
- More than 3 rollbacks in 5 optimizer cycles

**Mechanism:**
1. **FREEZE** all parameter updates immediately
2. **REVERT** all parameters to their Safe Harbor values (initial hardcoded defaults from `esp-params.md → ## Safe Harbor Parameters`):
   - `w_jaccard` = 0.6, `w_tau` = 0.4
   - `t_transparent` = 0.1, `t_high_risk` = 0.5, `t_reject` = 0.8
   - `frob_norm_method` = mean
   - `K_jaccard` = 3, `K_tau` = 10
3. **CLEAR** all oscillation freeze counters (Circuit Breaker 2 state reset)
4. **CLEAR** all outlier flags on calibration pairs
5. **RESUME** optimizer only after **10 new calibration pairs** are added post-safe-harbor
6. **LOG** the full degraded state, all parameter values at degradation, and recovery action to:
   - `tuning-state.md → ## Safe Harbor Recovery Log`
   - `memory/YYYY-MM-DD.md` (daily memory file)
7. **COMMIT:** `safe-harbor(esp): degraded state detected — reverted to defaults, awaiting 10 new pairs`
8. **NEVER ask for help.** The system handles its own recovery.

**Concrete thresholds:**
- Trigger: r < 0.3 for 2 runs, OR >3 rollbacks in 5 cycles
- Recovery requirement: 10 new pairs post-safe-harbor
- All counters (rollback count, no-update count, oscillation state) reset to zero on safe harbor activation

---

### K7. Circuit Breaker Interaction Matrix

| Scenario | CB-1 | CB-2 | CB-3 | CB-4 | CB-5 | CB-6 |
|----------|------|------|------|------|------|------|
| First optimizer run, <5 pairs | — | — | — | — | **BLOCKS** (proposals only) | — |
| First optimizer run, ≥5 pairs | Validates | — | Validates | Validates | Clears | — |
| Weight update, holdout regresses | **ROLLBACK** | — | — | — | — | — |
| Weight update, r drops below 0.4 | — | — | **ROLLBACK** | — | — | — |
| Param oscillates 2× | — | **FREEZE 3 cycles** | — | — | — | — |
| r < 0.3 for 2 consecutive | — | — | **DEGRADED** | — | — | **SAFE HARBOR** |
| >3 rollbacks in 5 cycles | — | — | — | — | — | **SAFE HARBOR** |
| Band has <5 pairs | — | — | — | **THRESHOLD FROZEN** | — | — |

**Priority:** CB-6 (safe harbor) overrides all other circuit breakers. If CB-6 triggers, all other CB states are reset.

---

## Implementation Priority

### Phase 1 — Build Now (0 additional pairs needed)

These components provide the infrastructure for all future tuning, even before the optimizer has enough data to run.

| Step | File to Create/Modify | Depends On | Est. Lines |
|------|----------------------|------------|-----------|
| 1.1 | `vectra/data/calibration-store.json` — seed with 3 existing pairs | Nothing | ~80 (JSON) |
| 1.2 | `vectra/src/embedding/calibration-store.ts` — append-only persistence, dedup, merge | 1.1 | ~120 |
| 1.3 | `vectra/src/embedding/esp-params.ts` — param store with history, load/save, rollback | Nothing | ~150 |
| 1.4 | `atp-instance/vars/esp-params.md` — create with hardcoded defaults + safe harbor | Nothing | ~80 |
| 1.5 | `atp-instance/vars/tuning-state.md` — create with zero counters + CB state | Nothing | ~100 |
| 1.6 | Modify `calibration-pairs-bench.ts` — add `--store` flag + per-query rankings | 1.1, 1.2 | ~40 Δ |
| 1.7 | `atp-instance/data/execution-records.json` — create empty store | Nothing | ~20 (JSON) |

### Phase 2 — Build After 5+ Pairs (ESP optimizer + circuit breakers)

| Step | File | Depends On | Est. Lines |
|------|------|------------|-----------|
| 2.1 | `vectra/src/embedding/threshold-optimizer.ts` — grid search + guards + all 6 circuit breakers | 1.1–1.5 | ~400 |
| 2.2 | `vectra/src/embedding/types.ts` — CalibrationPair, ESPParams, CircuitBreakerState interfaces | Nothing | ~100 |
| 2.3 | Modify `compatibility.ts` — read params from var file OR accept as argument | 2.1 | ~30 Δ |

### Phase 3 — Build After 20+ Execution Records (ATP optimizer)

| Step | File | Depends On | Est. Lines |
|------|------|------------|-----------|
| 3.1 | `vectra/src/atp/execution-recorder.ts` — reads handoff artifact, writes execution record | 1.7 | ~80 |
| 3.2 | Modify handoff artifact schema — add `varsVerified` field | Nothing | Schema change |
| 3.3 | `vectra/src/atp/atp-optimizer.ts` — model class / staleness / retry tuning | 1.5, 1.7 | ~150 |
| 3.4 | Modify `orchestration-main.md` — add "learned model class" override section | 3.3 | ~20 Δ |

### Phase 4 — Build After First Optimizer Run (Meta-loop)

| Step | File | Depends On | Est. Lines |
|------|------|------------|-----------|
| 4.1 | Add meta-loop checks to `threshold-optimizer.ts` and `atp-optimizer.ts` | 2.1, 3.3 | ~100 Δ |

### Phase 5 — Future (passive collection, anchor weights)

| Step | File | Depends On | Notes |
|------|------|------------|-------|
| 5.1 | Runtime verdict logging hook | ESP in live pipeline | Low priority |
| 5.2 | Per-anchor ablation analysis | 15+ pairs | Requires weighted distance function |
| 5.3 | K-value sweep | 10+ pairs with per-query rankings | Requires modified benchmark |

---

## What Can't Be Done Yet

| Capability | Blocker | When It Unblocks |
|------------|---------|------------------|
| Move `t_high_risk` threshold | 0 pairs in high-risk band (need 5) | After benchmarking model pairs with high retrieval divergence |
| Move `t_reject` threshold | 0 pairs in reject band (need 5) | After finding genuinely incompatible model pairs |
| Tune `w_jaccard` / `w_tau` | Only 1 cross-family pair (need 10) | After 10+ cross-family pairs |
| Tune anchor weights | Only 3 total pairs (need 15) | After 15+ pairs |
| Tune K values | No per-query ranking data stored | After modifying benchmark to store raw rankings |
| Tune ATP model class | 0 execution records (need 10) | After 10+ recorded executions per protocol |
| Tune staleness TTLs | 0 verification observations (need 20) | After 20+ verify_cmd runs per var |
| Run meta-loop | 0 optimizer runs | After first optimizer run completes |
| Apply learned params (vs. propose) | Confidence = uncalibrated (<5 pairs) | CB-5 auto-applies when pilot reached |

---

## Safety Assessment

**Is this system safe to deploy without human oversight?**

**YES**, with the following reasoning:

1. **Bounded parameter space:** All parameters have hard min/max bounds. The system cannot produce values outside these ranges regardless of input data quality.

2. **Safe harbor guarantee:** If the system detects it is performing badly (r < 0.3, excessive rollbacks), it reverts to known-good defaults. The worst-case behavior is identical to the current hardcoded system.

3. **Conservative by default:** The confidence floor (CB-5) prevents any changes until sufficient data exists. The band coverage lock (CB-4) prevents threshold changes in data-sparse regions. The system does nothing harmful while data is thin.

4. **Self-limiting degradation:** The degraded state auto-recovery (CB-6) means the system cannot spiral into increasingly bad states. It always has an escape hatch back to safe harbor.

5. **No external actions:** This system only modifies internal parameter files and source code constants. It does not send emails, make API calls, modify infrastructure, or take any action that affects systems outside the vectra workspace.

6. **The genuine risk:** A false-negative update (labeling an incompatible model pair as compatible) could cause retrieval quality degradation in a live pipeline. This risk is mitigated by: (a) the 2× false-positive penalty in the loss function, (b) the holdout validation in CB-1, and (c) the fact that ESP is not yet wired into a live pipeline — it's a research tool producing advisory verdicts. By the time it's wired into production, the calibration data will be substantial.

**Bottom line:** The system can only make itself better or revert to defaults. It cannot make itself worse than the starting point in any sustained way.

---

## Appendix: Mathematical Notes

### Kendall τ in TypeScript

For K-value tuning, Kendall τ must be recomputable at different K values from stored rankings:

```typescript
function kendallTau(rankA: string[], rankB: string[]): number {
  // Only consider items present in both lists
  const common = rankA.filter(id => rankB.includes(id));
  const n = common.length;
  if (n < 2) return 0;

  let concordant = 0;
  let discordant = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const posAi = rankA.indexOf(common[i]);
      const posAj = rankA.indexOf(common[j]);
      const posBi = rankB.indexOf(common[i]);
      const posBj = rankB.indexOf(common[j]);

      if ((posAi - posAj) * (posBi - posBj) > 0) concordant++;
      else discordant++;
    }
  }

  const total = concordant + discordant;
  return total > 0 ? (concordant - discordant) / total : 0;
  // Normalize to [0, 1]: (tau + 1) / 2
}
```

Note: O(n²) but n ≤ 30 for our K values, so performance is irrelevant.

### Grid Search Constraint Enforcement

```typescript
function isValidParamSet(p: ESPParams): boolean {
  return (
    p.wJaccard >= 0 && p.wJaccard <= 1 &&
    p.tTransparent >= 0.01 && p.tTransparent <= 0.25 &&
    p.tHighRisk >= 0.3 && p.tHighRisk <= 0.7 &&
    p.tReject >= 0.6 && p.tReject <= 0.95 &&
    p.tReject > p.tHighRisk + 0.1
  );
}
```

### Pearson r in TypeScript

```typescript
function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}
```
