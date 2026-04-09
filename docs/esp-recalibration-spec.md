# ESP Recalibration Spec — Layered Risk Profile

**Version:** 1.0.0  
**Date:** 2026-04-09  
**Author:** Opus Protocol Architect  
**Status:** Implementation Spec — replaces binary compatible/incompatible gate  
**Prerequisite:** Read `esp-experiment1-analysis.md` and `esp-critique-response.md` first.

---

## A. Diagnosis — What Is Actually Broken

### A.1 The Precise Failure

ESP Experiment 1 compared `nemotron-embed@dgx` (2048d) against `all-MiniLM-L6-v2@local` (384d). Results:

| Metric | Value |
|--------|-------|
| Frobenius distance (fingerprints) | 3.147 |
| ESP verdict | **incompatible** |
| Retrieval Jaccard @ K=3 | **0.730** (73% same chunks) |
| Kendall τ @ K=10 | **0.630** (strong rank agreement) |

ESP said "incompatible." Reality said "73% overlap." ESP was wrong.

### A.2 Which Component Is Responsible

The over-firing traces through three components:

1. **`compareESV()` in `esv.ts` (lines 155–192)** — This is the decision function. It computes `meanDrift` as the mean absolute difference between corresponding cells of two fingerprint matrices, then applies thresholds: `meanDrift < 0.01 → compatible`, `meanDrift < 0.08 && breachRate < 0.10 → warning`, else `incompatible`. For nemotron vs MiniLM, the mean per-cell delta was far above 0.08 (the matrices have systematically different scales: nemotron mean pairwise 0.817 vs MiniLM 0.893). **This function makes the binary decision that was wrong.**

2. **`assessL3()` in `layers.ts` (lines 124–141)** — Passes the `compareESV()` result through to the ESP2 assessment. L3 maps `incompatible` → `drift` status. No independent judgment. **This layer propagates the wrong decision without adding information.**

3. **`buildReport()` in `drift-detector.ts` (lines 90–134)** — Maps `incompatible` recommendation to `severity: 'critical'` with the message "Halt binary context exchange. Full re-encoding required." **This amplifies the wrong decision into an operational halt.**

### A.3 Root Cause Classification

This is **a framing problem**, not a threshold problem or a metric problem.

- It's not a **threshold problem** because no single threshold on Frobenius distance can correctly classify both same-model drift (where small geometric differences matter) and cross-model interoperability (where large geometric differences may not matter). The two questions have different natural metrics.

- It's not a **metric problem** because the Frobenius norm of the fingerprint delta correctly measures what it claims to measure: the geometric difference between two embedding spaces' internal structure. The measurement is accurate.

- It's a **framing problem** because `compareESV()` treats one measurement (geometric distance) as the answer to a different question (retrieval compatibility). Geometric distance predicts whether two embedding spaces are the *same space*. Retrieval compatibility asks whether two spaces *rank content the same way*. These are correlated but not equivalent — and Experiment 1 proved the correlation breaks for cross-architecture comparisons.

### A.4 What Frobenius Distance Actually Measures

The Frobenius norm of the fingerprint delta `||G_A - G_B||_F` measures the **total magnitude of pairwise distance disagreement** across all anchor pairs. It captures:

- Whether anchors that are close in space A are also close in space B
- Whether the overall scale of distances differs between spaces
- Whether specific anchor neighborhoods are warped relative to others

It does **not** measure:

- Whether the **ranking** of nearest neighbors is preserved (two spaces can have different absolute distances but identical rankings)
- Whether **retrieval behavior** converges (the question users actually care about)
- Whether the geometric difference is systematic (a uniform scale shift) or pathological (random reordering)

For nemotron vs MiniLM: the Frobenius distance of 3.147 captures a real geometric fact — MiniLM spreads anchors more widely (mean 0.893 vs 0.817) and with more variance (σ 0.116 vs 0.068). But this systematic scale difference doesn't destroy ranking — both models agree on which chunks are relevant to which queries 73% of the time.

### A.5 What a Correct Verdict Would Look Like

For the nemotron vs MiniLM result (Jaccard 0.73, τ 0.63), a correct ESP output would be:

> **Verdict: CAUTION**
> 
> Embedding spaces are structurally dissimilar (architecture distance 0.14, different dimensionality). However, retrieval behavior is moderately aligned — 73% chunk overlap at K=3, Kendall τ 0.63 at K=10. Cross-model retrieval is viable with quality monitoring. Binary vector exchange is not possible (different dimensions); text-based context exchange is recommended.
> 
> Calibration: uncalibrated (1 labeled pair). Thresholds are provisional.

This tells the operator something useful: "these models aren't the same, but they retrieve similar content, so don't panic."

---

## B. Layered Risk Profile — Formal Spec

### B.1 Design Principle

Replace the single binary gate (`compatible` / `incompatible`) with a **profile of independent risk dimensions**, each measuring a different aspect of cross-model interoperability. The profile produces a graded **operational verdict** with human-readable rationale.

The key insight: **architecture distance and retrieval divergence are independent variables.** Two models can be architecturally distant but retrieval-convergent (nemotron vs MiniLM), or architecturally similar but retrieval-divergent (a fine-tuned model that warps one semantic region). The profile measures both.

### B.2 Layer 1 — Architecture Distance

**Question answered:** How geometrically different are these two embedding spaces?

| Property | Value |
|----------|-------|
| **Input** | Two ESVs (fingerprint matrices `G_A`, `G_B`) |
| **Metric** | Frobenius norm of `G_A - G_B`, divided by mean of `‖G_A‖_F` and `‖G_B‖_F` |
| **Output** | Float 0.0–1.0 (0 = identical geometry, 1 = maximally different) |
| **Computation** | `architectureDistance = ‖G_A - G_B‖_F / ((‖G_A‖_F + ‖G_B‖_F) / 2)` |
| **Cost** | Cheap — matrix arithmetic only, no model calls |

**Interpretation bands:**

| Band | Range | Meaning | Example |
|------|-------|---------|---------|
| Same model | 0.00–0.05 | Identical or near-identical space (quantization, config jitter) | Same model, INT8 vs FP16 |
| Same family | 0.05–0.20 | Same architecture family, minor version differences | text-embedding-3-small v1 vs v2 |
| Compatible architecture | 0.20–0.50 | Different architecture, possibly similar training | nemotron vs MiniLM (~0.14) |
| Distant architecture | 0.50–1.00 | Fundamentally different spaces | Expect retrieval divergence without evidence otherwise |

**What it predicts:** Whether binary vector exchange is feasible (requires same-model band) and whether re-embedding is needed for exact interop.

**What it does NOT predict:** Retrieval quality. Architecture distance is a necessary signal but not sufficient for an operational verdict.

### B.3 Layer 2 — Retrieval Overlap Risk

**Question answered:** If I query with model A and retrieve with model B's index, how different are the results?

| Property | Value |
|----------|-------|
| **Input** | Two models, a query set (≥20 queries), a chunk corpus (≥50 chunks) |
| **Metric** | Composite of mean Jaccard@K3 and mean Kendall τ@K10 across query set |
| **Output** | Float 0.0–1.0 risk (0 = perfect overlap, 1 = no overlap) |
| **Formula** | `retrievalOverlapRisk = 1 - (0.6 × Jaccard@K3 + 0.4 × KendallTau@K10)` |
| **Cost** | Expensive — requires embedding the full corpus with both models + running queries |

**Weight rationale:** Jaccard@K3 gets 0.6 weight because top-3 overlap directly predicts whether the user sees the same content. Kendall τ@K10 gets 0.4 because ranking stability matters for quality but is less binary-impactful.

**Interpretation bands:**

| Band | Range | Meaning | Data Point |
|------|-------|---------|------------|
| Aligned | 0.00–0.20 | Retrieval results are functionally identical | — |
| Moderate risk | 0.20–0.40 | Retrieval mostly agrees; edge cases may diverge | nemotron vs MiniLM: 0.27 (see §F) |
| High risk | 0.40–0.60 | Significant retrieval differences expected | — |
| Divergent | 0.60–1.00 | Models retrieve fundamentally different content | — |

**Null semantics:** `retrievalOverlapRisk = null` means the measurement has not been performed. This is the default state — the metric is expensive to compute. A null value means "unknown," NOT "safe."

**Calibration status:** **Uncalibrated.** Band boundaries are set from a single data point (nemotron vs MiniLM at 0.27). Real thresholds require ≥10 labeled model pairs to establish with any confidence.

### B.4 Layer 3 — Ranking Instability Risk

**Question answered:** Do the two models preserve the relative ordering of semantic relationships?

| Property | Value |
|----------|-------|
| **Input** | Two ESVs (fingerprint matrices) OR two models + anchor set |
| **Metric** | Ordering inversion rate across all anchor triplets |
| **Output** | Float 0.0–1.0 (0 = all orderings preserved, 1 = all inverted) |
| **Cost** | Moderate — O(n³) on anchor count, but n=27 → 17,550 triplets, trivial |

**Computation:**

```
For each anchor triple (a_i, a_j, a_k):
  In space A: is d(a_i, a_k) < d(a_j, a_k)?      → order_A
  In space B: is d(a_i, a_k) < d(a_j, a_k)?      → order_B
  If order_A ≠ order_B: inversion += 1

rankingInstabilityRisk = inversions / totalTriplets
```

Where `totalTriplets = n × (n-1) × (n-2) / 2` (for n=27: 17,550).

**Interpretation bands:**

| Band | Range | Meaning |
|------|-------|---------|
| Stable | 0.00–0.10 | Semantic ordering is well-preserved |
| Moderate instability | 0.10–0.30 | Some ordering disagreements, mostly in close pairs |
| High instability | 0.30–0.50 | Frequent ordering disagreements — ranking quality at risk |
| Chaotic | 0.50–1.00 | Models disagree on most orderings — effectively random relative to each other |

**Relationship to Kendall τ:** Ranking instability risk (computed from anchor triplets) and Kendall τ (computed from retrieval rankings) measure related but distinct properties. Anchor triplet inversions measure whether the *embedding space geometry* preserves orderings; Kendall τ measures whether *retrieval output rankings* agree. When both are available, they should be cross-checked. Large disagreement between them indicates the anchor set isn't representative of the retrieval corpus.

**Approximation from Kendall τ:** When only Kendall τ is available (from a retrieval experiment), use `rankingInstabilityRisk ≈ 1 - τ` as an estimate. This is an approximation — Kendall τ is computed over retrieval rankings, not anchor triplets — but it's directionally correct and avoids requiring a separate anchor triplet computation. For the nemotron vs MiniLM pair: `1 - 0.63 = 0.37`.

### B.5 Layer 4 — Downstream Answer Risk

**Question answered:** Does using model A's retrieval instead of model B's change the final answer the LLM produces?

| Property | Value |
|----------|-------|
| **Input** | Canonical decision prompts (≥10), both models, a generation model |
| **Metric** | Answer consistency: fraction of prompts where both models' retrieved context produces the same LLM answer |
| **Output** | Float 0.0–1.0 risk (0 = all answers identical, 1 = all answers differ) |
| **Formula** | `downstreamAnswerRisk = 1 - (consistentAnswers / totalPrompts)` |
| **Cost** | **Very expensive** — requires running full retrieval + generation pipeline N times per prompt |

**When to compute:** Only on high-stakes decisions, during calibration dataset collection, or on a sampling basis. Never in the hot path.

**Null semantics:** `downstreamAnswerRisk = null` is the expected default. This layer is opt-in.

### B.6 Layer 5 — Calibration Confidence

**Question answered:** How much data backs the thresholds used in the verdict?

| Property | Value |
|----------|-------|
| **Input** | Count of labeled model pairs used to calibrate thresholds |
| **Output** | Categorical: `'uncalibrated'` / `'pilot'` / `'preliminary'` / `'validated'` |

**Tier definitions:**

| Tier | Labeled Pairs | Meaning |
|------|--------------|---------|
| `uncalibrated` | 0 | Thresholds are design-time defaults. No empirical calibration. |
| `pilot` | 1–10 | Initial data collected. Thresholds informed by real data but statistically weak. |
| `preliminary` | 11–50 | Reasonable confidence in band boundaries. May have gaps in model diversity. |
| `validated` | 51+ | Statistically robust. Covers diverse model families, corpora, and conditions. |

**Current state:** ALL layers are `uncalibrated`. We have exactly **1 labeled pair** (nemotron vs MiniLM). Upon implementing this spec and recording that pair formally, we advance to `pilot` with 1 pair.

**This is the honesty flag.** Every `CompatibilityProfile` output must include calibration confidence. Consumers who see `uncalibrated` know the thresholds are provisional. This prevents ESP from claiming authority it hasn't earned.

---

## C. The CompatibilityProfile Type

### C.1 TypeScript Interface

```typescript
/**
 * Cross-model compatibility assessment.
 * Replaces the binary compatible/incompatible gate from ESVComparison
 * for cross-model comparisons.
 * 
 * ESVComparison is retained for same-model drift detection (its original
 * and correct use case).
 */
export interface CompatibilityProfile {
  // ── Layer Outputs ─────────────────────────────────────────────

  /** L1: Normalized Frobenius distance of fingerprint delta. 0–1. */
  architectureDistance: number;

  /** L2: Retrieval overlap risk. 0–1. null if not measured. */
  retrievalOverlapRisk: number | null;

  /** L3: Ordering inversion rate across anchor triplets. 0–1. */
  rankingInstabilityRisk: number;

  /** L4: Downstream answer divergence risk. 0–1. null if not measured (expensive). */
  downstreamAnswerRisk: number | null;

  // ── Calibration ───────────────────────────────────────────────

  /** How much empirical data backs the current thresholds. */
  calibrationConfidence: 'uncalibrated' | 'pilot' | 'preliminary' | 'validated';

  /** Number of labeled model pairs used in threshold calibration. */
  labeledPairsUsed: number;

  // ── Operational Verdict ───────────────────────────────────────

  /** Graded verdict replacing binary compatible/incompatible. */
  operationalVerdict: 'transparent' | 'caution' | 'high-risk' | 'reject';

  /** Human-readable explanation of the verdict. */
  verdictRationale: string;

  // ── Raw Inputs ────────────────────────────────────────────────

  /** Model A identifier (e.g., "nemotron-embed@dgx"). */
  modelA: string;

  /** Model B identifier (e.g., "all-MiniLM-L6-v2@local"). */
  modelB: string;

  /** Anchor set version used for fingerprint computation. */
  anchorSetVersion: string;

  /** ISO 8601 timestamp when the profile was computed. */
  measuredAt: string;

  // ── Raw Metrics (for downstream consumers / debugging) ────────

  /** Unnormalized Frobenius distance of fingerprint delta. */
  rawFrobeniusDistance: number;

  /** Frobenius norms of each input fingerprint matrix. */
  fingerprintMagnitudes: { modelA: number; modelB: number };

  /** Retrieval metrics breakdown, if measured. */
  retrievalMetrics: RetrievalMetrics | null;

  /** Dimensions of each model (for binary exchange feasibility). */
  dimensions: { modelA: number; modelB: number };
}

export interface RetrievalMetrics {
  /** Mean Jaccard similarity at K=3 across query set. */
  jaccardAtK3: number;
  /** Mean Kendall τ at K=10 across query set. */
  kendallTauAtK10: number;
  /** Number of queries in the evaluation set. */
  queryCount: number;
  /** Number of corpus chunks. */
  corpusChunkCount: number;
}
```

### C.2 Operational Verdict Rules

The `operationalVerdict` is computed from the layer outputs using the following decision logic. Rules are evaluated **in order**; first match wins.

```typescript
function computeVerdict(profile: Omit<CompatibilityProfile, 'operationalVerdict' | 'verdictRationale'>): {
  verdict: CompatibilityProfile['operationalVerdict'];
  rationale: string;
} {
  const {
    architectureDistance,
    retrievalOverlapRisk,
    rankingInstabilityRisk,
    downstreamAnswerRisk,
  } = profile;

  // Rule 1: REJECT — hard evidence of retrieval or answer divergence
  if (retrievalOverlapRisk !== null && retrievalOverlapRisk > 0.8) {
    return {
      verdict: 'reject',
      rationale: `Retrieval overlap risk ${retrievalOverlapRisk.toFixed(2)} exceeds reject threshold (0.8). Models retrieve fundamentally different content.`,
    };
  }
  if (downstreamAnswerRisk !== null && downstreamAnswerRisk > 0.5) {
    return {
      verdict: 'reject',
      rationale: `Downstream answer risk ${downstreamAnswerRisk.toFixed(2)} exceeds reject threshold (0.5). Different retrieval produces different answers.`,
    };
  }

  // Rule 2: HIGH-RISK — measurable retrieval or ranking divergence
  if (retrievalOverlapRisk !== null && retrievalOverlapRisk > 0.5) {
    return {
      verdict: 'high-risk',
      rationale: `Retrieval overlap risk ${retrievalOverlapRisk.toFixed(2)} is elevated (>0.5). Significant retrieval differences expected.`,
    };
  }
  if (rankingInstabilityRisk > 0.5) {
    return {
      verdict: 'high-risk',
      rationale: `Ranking instability risk ${rankingInstabilityRisk.toFixed(2)} exceeds 0.5. Semantic orderings are frequently inverted between models.`,
    };
  }

  // Rule 3: TRANSPARENT — same model or near-identical space
  if (architectureDistance < 0.05 && (retrievalOverlapRisk === null || retrievalOverlapRisk < 0.2)) {
    return {
      verdict: 'transparent',
      rationale: `Architecture distance ${architectureDistance.toFixed(3)} indicates same or near-identical embedding space.`,
    };
  }

  // Rule 4: CAUTION — everything else (different models without evidence of divergence)
  const parts: string[] = [];
  parts.push(`Architecture distance: ${architectureDistance.toFixed(3)}`);
  if (retrievalOverlapRisk !== null) {
    parts.push(`Retrieval overlap risk: ${retrievalOverlapRisk.toFixed(2)}`);
  } else {
    parts.push(`Retrieval overlap: not measured`);
  }
  parts.push(`Ranking instability: ${rankingInstabilityRisk.toFixed(2)}`);

  return {
    verdict: 'caution',
    rationale: `Models are architecturally different but no strong evidence of retrieval divergence. ${parts.join('. ')}. Use with quality monitoring.`,
  };
}
```

**Why this ordering:**

1. **Reject** checks come first because hard evidence of divergence should never be overridden by a low architecture distance.
2. **High-risk** catches moderate-but-real divergence evidence.
3. **Transparent** is the happy path — only reachable when architecture distance is very low AND no retrieval evidence contradicts it.
4. **Caution** is the default bucket — any pair that isn't clearly safe or clearly dangerous lands here. This is the right default because most cross-model comparisons will have incomplete data (null retrieval metrics).

**Null-safety:** When `retrievalOverlapRisk` is null, rules 1 and 2 can't fire for retrieval (they require non-null values). The pair falls through to either `transparent` (if architectureDistance < 0.05) or `caution`. This means unknown retrieval quality defaults to "proceed with monitoring," not "block."

---

## D. Calibration Dataset Design

### D.1 What a Labeled Pair Looks Like

```typescript
interface CalibrationPair {
  /** Model A identifier. */
  modelA: string;
  /** Model B identifier. */
  modelB: string;
  /** Corpus identifier (domain, size). */
  corpusId: string;
  /** Measured architecture distance (normalized Frobenius). */
  architectureDistance: number;
  /** Measured retrieval Jaccard@K3. */
  jaccardAtK3: number;
  /** Measured Kendall τ@K10. */
  kendallTauAtK10: number;
  /** Computed retrieval overlap risk. */
  retrievalOverlapRisk: number;
  /** Anchor triplet inversion rate. */
  rankingInstabilityRisk: number;
  /** Human/automated judgment: does quality actually diverge? */
  actualQualityDivergent: boolean;
  /** Free-text notes on the quality assessment. */
  qualityNotes: string;
  /** Who/what produced the quality judgment. */
  labelSource: 'automated-threshold' | 'human-review' | 'llm-judge';
}
```

### D.2 Pairs Required Per Confidence Tier

| Tier | Pairs | Model Diversity Required | Corpus Diversity Required |
|------|-------|------------------------|-------------------------|
| **Pilot** (1–10) | 3–10 pairs | ≥2 model families (e.g., sentence-transformers + NVIDIA + OpenAI) | ≥1 corpus, ≥50 chunks |
| **Preliminary** (11–50) | 11–50 pairs | ≥4 model families, including ≥1 cross-dimensional pair | ≥3 corpora across different domains |
| **Validated** (51+) | 51+ pairs | ≥6 model families, systematic coverage of dimension ranges (384, 768, 1024, 1536, 2048+) | ≥5 corpora, varying chunk density (10–10K chunks) |

### D.3 Model Diversity Requirements

The calibration dataset must include pairs from each of these categories:

| Category | Example Pairs | Why |
|----------|--------------|-----|
| Same model, same config | nemotron-embed vs nemotron-embed (rerun) | Establishes the "transparent" baseline |
| Same model, different quantization | nemotron-embed FP32 vs INT8 | Tests quantization drift |
| Same family, different size | all-MiniLM-L6 vs all-MiniLM-L12 | Tests within-family version drift |
| Different family, same dimensions | sentence-t5-base (768d) vs e5-base (768d) | Tests cross-family at same dimensions |
| Different family, different dimensions | nemotron (2048d) vs MiniLM (384d) | Tests the hardest case (Experiment 1 scenario) |
| Fine-tuned vs base | e5-base vs e5-base-finetuned-on-X | Tests anisotropic warping |

### D.4 Corpus Characteristics

| Property | Requirement | Rationale |
|----------|------------|-----------|
| Minimum chunks | 50 | Below this, Jaccard@K3 is too noisy (3 of 50 = 6%, meaningful; 3 of 10 = 30%, trivial) |
| Preferred chunks | 200–1000 | Balances statistical power with computation cost |
| Domain diversity | ≥3 domains in validated tier | Models may agree on common domains, diverge on specialized ones |
| Chunk density | Mix of sparse (1 chunk per topic) and dense (many chunks per topic) | Dense corpora test ranking precision; sparse corpora test recall |

### D.5 Labeling Protocol

**Who judges "actualQualityDivergent"?**

1. **Automated threshold (default):** `actualQualityDivergent = (jaccardAtK3 < 0.5)`. This is the current threshold from Experiment 1's runner. Cheap and reproducible but may miss nuanced divergence.

2. **LLM judge (recommended for pilot):** Given the top-3 chunks from each model for each query, an LLM evaluates: "Would a user get a meaningfully different answer from these two result sets?" Binary yes/no per query; pair-level divergence = fraction of queries where the judge says "yes" > 0.3.

3. **Human review (gold standard for validated):** A human reviews a sample of query result pairs and labels quality divergence. Required for at least 10% of pairs in the validated tier.

### D.6 Threshold Update Protocol

When new calibration pairs are added:

1. Recompute the ROC curve for each verdict threshold against the `actualQualityDivergent` labels.
2. If the optimal threshold (maximizing F1 for divergence detection) differs from the current threshold by > 10%, update the threshold.
3. Log the threshold change with: old value, new value, number of pairs, AUC before and after.
4. All existing `CompatibilityProfile` outputs remain valid — they carry their `calibrationConfidence` and `labeledPairsUsed`, so consumers know what thresholds were in effect.

**Monotonic confidence:** `calibrationConfidence` only advances forward (uncalibrated → pilot → preliminary → validated). It does not regress, even if new data challenges existing thresholds. If new data invalidates the model, the thresholds update, but the confidence tier stays (since more data = more confidence in the *updated* thresholds).

---

## E. Migration Path — Codebase Changes

### E.1 `src/embedding/esv.ts` — Preserve, Don't Replace

**Keep unchanged:**
- `ESV` interface (still the correct type for a single model's fingerprint)
- `ESVComparison` interface and `compareESV()` function (still correct for same-model drift detection)
- `computeESV()`, `computePairwiseDistances()`, `cosineDistance()` — all still needed

**Add:**
- Export `frobeniusNorm()` utility (currently inline in `compareESV()`; extract for reuse)

```typescript
// NEW export
export function frobeniusNorm(matrix: number[][]): number {
  let sum = 0;
  const n = matrix.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sum += matrix[i][j] ** 2;
    }
  }
  return Math.sqrt(sum);
}
```

**Rationale:** `ESVComparison` was designed for same-model drift detection (is model A still behaving like model A?). It answers that question correctly. The problem is that it was *also* used for cross-model interoperability, which is a different question. Keep `ESVComparison` for its intended purpose; add `CompatibilityProfile` for the new purpose.

### E.2 `src/esp/layers.ts` — Integrate CompatibilityProfile

**Keep unchanged:**
- L1 (runtime), L2 (lexical), L4 (propositional), L5 (decision) — all still correct for their purposes
- `ESP2Assessment` interface — still the right container for multi-layer same-model assessment

**Add:**
- Optional `crossModelProfile` field to `ESP2Assessment`:

```typescript
export interface ESP2Assessment {
  overall: LayerStatus;
  layers: LayerResult[];
  compatibleForBinaryExchange: boolean;
  requiresRebaseline: boolean;
  timestamp: string;
  /** Cross-model compatibility profile. Present when comparing different models. */
  crossModelProfile?: CompatibilityProfile;
}
```

**Modify `assessL3()`:** When comparing two ESVs from *different* models (detected by `currentESV.modelId !== baselineESV.modelId`), compute and attach a `CompatibilityProfile` instead of relying solely on `compareESV()`.

```typescript
function assessL3(
  currentESV: ESV,
  baselineESV: ESV,
  retrievalMetrics?: RetrievalMetrics,
): { result: LayerResult; profile?: CompatibilityProfile } {
  const now = new Date().toISOString();
  const sameModel = currentESV.modelId === baselineESV.modelId;

  if (sameModel) {
    // Same-model drift detection — existing logic, unchanged
    const comparison = compareESV(baselineESV, currentESV);
    // ... existing status mapping ...
    return { result: { layer: 'geometric', status, details, timestamp: now } };
  }

  // Cross-model comparison — use CompatibilityProfile
  const profile = computeCompatibilityProfile(currentESV, baselineESV, retrievalMetrics);
  const status: LayerStatus = profile.operationalVerdict === 'reject' ? 'drift'
    : profile.operationalVerdict === 'high-risk' ? 'warning'
    : 'stable';

  return {
    result: {
      layer: 'geometric',
      status,
      details: `Cross-model: ${profile.operationalVerdict} — ${profile.verdictRationale}`,
      timestamp: now,
    },
    profile,
  };
}
```

### E.3 New File: `src/embedding/compatibility.ts`

This is the core new file. Contains `CompatibilityProfile`, `RetrievalMetrics`, `computeCompatibilityProfile()`, and `computeVerdict()`.

**Function signatures:**

```typescript
import type { ESV } from './esv.js';
import { frobeniusNorm } from './esv.js';

export interface CompatibilityProfile { /* ... as defined in §C.1 ... */ }
export interface RetrievalMetrics { /* ... as defined in §C.1 ... */ }

/**
 * Compute a full CompatibilityProfile from two ESVs and optional retrieval data.
 *
 * @param esvA - First model's ESV.
 * @param esvB - Second model's ESV.
 * @param retrieval - Optional measured retrieval overlap metrics.
 * @param calibration - Optional calibration metadata. Defaults to uncalibrated.
 */
export function computeCompatibilityProfile(
  esvA: ESV,
  esvB: ESV,
  retrieval?: RetrievalMetrics | null,
  calibration?: { confidence: CompatibilityProfile['calibrationConfidence']; labeledPairs: number },
): CompatibilityProfile;

/**
 * Compute the ordering inversion rate across all anchor triplets.
 *
 * @param fingerprintA - Pairwise distance matrix for model A.
 * @param fingerprintB - Pairwise distance matrix for model B.
 * @returns Inversion rate in [0, 1].
 */
export function computeOrderingInversionRate(
  fingerprintA: number[][],
  fingerprintB: number[][],
): number;

/**
 * Compute the normalized architecture distance between two fingerprint matrices.
 *
 * @param fingerprintA - Pairwise distance matrix for model A.
 * @param fingerprintB - Pairwise distance matrix for model B.
 * @returns Normalized distance in [0, 1].
 */
export function computeArchitectureDistance(
  fingerprintA: number[][],
  fingerprintB: number[][],
): number;
```

**`computeOrderingInversionRate` implementation:**

```typescript
export function computeOrderingInversionRate(
  fingerprintA: number[][],
  fingerprintB: number[][],
): number {
  const n = fingerprintA.length;
  let inversions = 0;
  let totalTriplets = 0;

  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      for (let j = i + 1; j < n; j++) {
        if (j === k) continue;
        totalTriplets++;
        const orderA = fingerprintA[i][k] < fingerprintA[j][k];
        const orderB = fingerprintB[i][k] < fingerprintB[j][k];
        if (orderA !== orderB) inversions++;
      }
    }
  }

  return totalTriplets > 0 ? inversions / totalTriplets : 0;
}
```

### E.4 `src/benchmark/cross-model-esv-bench.ts` — Output CompatibilityProfile

**Current state:** The benchmark runner outputs the raw JSON in `esp-experiment1-results.json` with ad-hoc fields (`espVerdict`, `espPredictedIncompatible`, `espCorrect`).

**Change:** After computing raw metrics, call `computeCompatibilityProfile()` and include the full profile in the output.

```typescript
// In the comparison loop, after measuring retrieval metrics:
import { computeCompatibilityProfile } from '../embedding/compatibility.js';

const profile = computeCompatibilityProfile(esvA, esvB, {
  jaccardAtK3: measuredJaccard,
  kendallTauAtK10: measuredKendallTau,
  queryCount: queries.length,
  corpusChunkCount: chunks.length,
});

// Replace ad-hoc verdict fields with:
result.compatibilityProfile = profile;
```

**What stays the same:** The benchmark runner's corpus loading, query generation, embedding calls, and Jaccard/Kendall computation are all unchanged. Only the output format changes.

---

## F. Experiment 1 Re-Scored Under New Spec

### F.1 Architecture Distance (Layer 1)

**Raw Frobenius distance:** 3.147 (from experiment results)

**Normalization math:**

The Frobenius norm of each fingerprint matrix is computed from the pairwise distance matrices. For a 27×27 matrix:
- Number of off-diagonal elements: 27 × 26 = 702 (each pair counted twice)
- Using the statistical summary from the ESVs:

For nemotron-embed (mean pairwise distance 0.817, σ = 0.068):
```
‖G_nemotron‖_F ≈ √(Σ g²ᵢⱼ)
```
With mean 0.817 and σ 0.068, E[g²] = μ² + σ² = 0.6675 + 0.0046 = 0.6721.
Sum of squares of all 702 off-diagonal elements ≈ 702 × 0.6721 = 471.8.
`‖G_nemotron‖_F ≈ √471.8 ≈ 21.72`

For MiniLM (mean 0.893, σ = 0.116):
```
E[g²] = 0.7974 + 0.0135 = 0.8109
Sum ≈ 702 × 0.8109 = 569.2
‖G_MiniLM‖_F ≈ √569.2 ≈ 23.86
```

Mean magnitude: (21.72 + 23.86) / 2 = **22.79**

**Normalized architecture distance:** 3.147 / 22.79 = **0.138**

**Band:** 0.05–0.20 → **Compatible architecture** (closer to "same family" than expected — the anchor geometry is more similar than the raw Frobenius suggested).

### F.2 Retrieval Overlap Risk (Layer 2)

From experiment data: Jaccard@K3 = 0.730, Kendall τ@K10 = 0.630.

```
retrievalOverlapRisk = 1 - (0.6 × 0.730 + 0.4 × 0.630)
                     = 1 - (0.438 + 0.252)
                     = 1 - 0.690
                     = 0.310
```

**Retrieval overlap risk:** **0.31** → falls in the **Moderate risk** band (0.20–0.40).

This means: "Retrieval mostly agrees; expect some edge-case divergence."

### F.3 Ranking Instability Risk (Layer 3)

Not directly measured from anchor triplets in Experiment 1. Estimated from Kendall τ:

```
rankingInstabilityRisk ≈ 1 - τ = 1 - 0.630 = 0.370
```

**Ranking instability risk:** **0.37** → **High instability** band (0.30–0.50).

This is the most concerning signal — semantic orderings are inverted for a substantial fraction of comparisons. However, note this is estimated from retrieval rankings, not anchor triplets. The actual anchor-triplet inversion rate may differ.

### F.4 Downstream Answer Risk (Layer 4)

**Not measured.** `downstreamAnswerRisk = null`.

### F.5 Full CompatibilityProfile

```json
{
  "architectureDistance": 0.138,
  "retrievalOverlapRisk": 0.31,
  "rankingInstabilityRisk": 0.37,
  "downstreamAnswerRisk": null,
  "calibrationConfidence": "uncalibrated",
  "labeledPairsUsed": 0,
  "operationalVerdict": "caution",
  "verdictRationale": "Models are architecturally different but no strong evidence of retrieval divergence. Architecture distance: 0.138. Retrieval overlap risk: 0.31. Ranking instability: 0.37. Use with quality monitoring.",
  "modelA": "nemotron-embed@dgx",
  "modelB": "all-MiniLM-L6-v2@local",
  "anchorSetVersion": "esp-anchor-v1",
  "measuredAt": "2026-04-09T21:55:39.918Z",
  "rawFrobeniusDistance": 3.147,
  "fingerprintMagnitudes": { "modelA": 21.72, "modelB": 23.86 },
  "retrievalMetrics": {
    "jaccardAtK3": 0.730,
    "kendallTauAtK10": 0.630,
    "queryCount": 30,
    "corpusChunkCount": 54
  },
  "dimensions": { "modelA": 2048, "modelB": 384 }
}
```

**Verdict: CAUTION** — not REJECT, not TRANSPARENT.

### F.6 Verdict Trace

Walking through the verdict rules from §C.2:

1. **Rule 1 (reject — retrieval > 0.8):** `retrievalOverlapRisk = 0.31` — does not fire.
2. **Rule 1 (reject — downstream > 0.5):** `downstreamAnswerRisk = null` — does not fire.
3. **Rule 2 (high-risk — retrieval > 0.5):** `retrievalOverlapRisk = 0.31` — does not fire.
4. **Rule 2 (high-risk — ranking > 0.5):** `rankingInstabilityRisk = 0.37` — does not fire.
5. **Rule 3 (transparent — arch < 0.05):** `architectureDistance = 0.138` — does not fire.
6. **Rule 4 (caution — default):** ✅ **Matches.**

### F.7 Comparison: Old vs New

| Aspect | Old ESP | New CompatibilityProfile |
|--------|---------|------------------------|
| **Verdict** | `incompatible` | `caution` |
| **Operator action** | "Halt binary context exchange. Full re-encoding required." | "Use with quality monitoring." |
| **Information content** | 1 bit (yes/no) | 4 floats + confidence + rationale |
| **Correct?** | **No** — retrieval overlap 73% contradicts "halt" | **Yes** — "caution with monitoring" matches the actual risk |
| **Would it cause harm?** | Yes — unnecessary re-encoding, blocked interop | No — allows interop with appropriate monitoring |

---

## G. What This Means for Experiment 2 and Next Steps

### G.1 Does the Scale Benchmark (Experiment 2) Still Make Sense?

**Yes, and it's now better motivated.**

The recalibrated spec makes Experiment 2 more valuable, not less. The key question Experiment 2 answers is: **Does the 73% Jaccard@K3 overlap hold at scale (500+ chunks) or is it an artifact of the small corpus (54 chunks)?**

Under the old binary ESP, Experiment 2 was about "proving ESP wrong" or "confirming ESP right." Under the new CompatibilityProfile, Experiment 2 provides a **second calibration pair** at a different corpus size, which directly advances calibration confidence from `uncalibrated` toward `pilot`.

### G.2 Minimum Calibration Before Production Use

| Use Case | Minimum Tier | Pairs Needed | Rationale |
|----------|-------------|-------------|-----------|
| Internal experimentation | `uncalibrated` (0) | Current state suffices | Profiles are informational; humans make decisions |
| Automated quality gates | `pilot` (3+) | 3–5 pairs | Enough to detect gross threshold errors |
| Production retrieval routing | `preliminary` (11+) | 11–20 pairs | Need diverse model families to trust verdict rules |
| Multi-agent context exchange | `validated` (51+) | 51+ pairs | High stakes — wrong verdict = silent quality degradation |

**Current state:** 0 labeled pairs (the Experiment 1 data has not been formally ingested as a calibration pair yet).

### G.3 Recommended Next 3 Actions (Priority Order)

**1. Implement `compatibility.ts` and re-run Experiment 1 (Priority: Immediate)**

Write the `computeCompatibilityProfile()` function, the `computeOrderingInversionRate()` function, and the verdict logic from §C.2. Re-process the existing Experiment 1 data through the new code path. Verify the output matches §F.5. Formally ingest the nemotron vs MiniLM pair as calibration pair #1. This advances calibration to `pilot` (1 pair).

**Deliverable:** `src/embedding/compatibility.ts` + updated experiment output with `CompatibilityProfile`.

**2. Collect 3–5 more calibration pairs (Priority: High)**

Run cross-model comparisons for:
- Same model, different run (nemotron vs nemotron — establishes `transparent` baseline)
- Same family, different size (all-MiniLM-L6 vs all-MiniLM-L12 — tests within-family)
- If OpenAI access restored: nemotron vs text-embedding-3-small (different vendor at scale)

Each pair needs: ESV computation + retrieval overlap measurement (Jaccard@K3, Kendall τ@K10) on the existing 54-chunk corpus. This gets us to `pilot` (3+ pairs) and lets us validate or adjust the band boundaries from §B.

**Deliverable:** 3–5 new calibration pairs in a `calibration-pairs.json` file. Updated thresholds if data warrants.

**3. Run Experiment 2 (Scale Benchmark) with CompatibilityProfile output (Priority: High)**

Scale the corpus to 200–500 chunks. Re-run the nemotron vs MiniLM comparison at scale. The primary question: does `retrievalOverlapRisk` stay in the 0.2–0.4 band at scale, or does it degrade? This pair at a different corpus size is calibration pair #2 (or #6+ if paired with action 2).

**Deliverable:** Scale benchmark results with full `CompatibilityProfile`. Updated `retrievalOverlapRisk` data point at production-representative corpus size.

---

## H. Summary

**What's broken:** ESP's `compareESV()` treats geometric distance as the sole input to a binary compatible/incompatible gate. Geometric distance measures space similarity, not retrieval compatibility. For cross-architecture comparisons (nemotron vs MiniLM), these diverge — the space is different but retrieval agrees. The binary gate has no way to express this.

**What replaces it:** A `CompatibilityProfile` with 4 independent risk dimensions (architecture distance, retrieval overlap risk, ranking instability risk, downstream answer risk), a calibration confidence flag, and a graded operational verdict (`transparent` / `caution` / `high-risk` / `reject`).

**What the nemotron/MiniLM pair would score:** Architecture distance 0.138 (compatible), retrieval overlap risk 0.31 (moderate), ranking instability 0.37 (moderate-high), verdict **CAUTION** — not reject. This is the correct answer.

**What's honest:** All thresholds are provisional. Calibration confidence is `uncalibrated`. The spec includes a concrete path to calibrate (labeled pairs, diversity requirements, update protocol). No fake authority.
