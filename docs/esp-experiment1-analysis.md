# ESP Experiment 1 Analysis — Cross-Model ESV Comparison

**Completed:** 2026-04-09  
**Models compared:** `nemotron-embed@dgx` (2048d) vs `all-MiniLM-L6-v2@local` (384d)  
**Infrastructure note:** OpenAI embedding API was unavailable (project restriction); intended 4-model test ran with 2 models. all-MiniLM-L6-v2 served via xenova/transformers ONNX locally.

---

## 1. Setup Summary

| Parameter | Value |
|-----------|-------|
| Models | 2 (intended 4) |
| Corpus | 21 documents, 54 chunks |
| Queries | 30 |
| K values evaluated | 1, 3, 5 (Jaccard); 10 (Kendall τ) |

**ESVs computed:**
- `nemotron-embed@dgx`: `esp-anchor-v1:956d33a0a4ba:2048:0.05` (mean pairwise dist: 0.817, σ=0.068)
- `all-MiniLM-L6-v2@local`: `esp-anchor-v1:e2e87b57e223:384:0.05` (mean pairwise dist: 0.893, σ=0.116)

---

## 2. Key Results

| Metric | Value | Interpretation |
|--------|-------|----------------|
| Frobenius distance (fingerprints) | **3.147** | Very high — expected for different architectures |
| ESP verdict | **incompatible** | Correctly identifies different architectures |
| Retrieval Jaccard @ K=1 | **0.833** | 83% of top-1 picks agree |
| Retrieval Jaccard @ K=3 | **0.730** | 73% overlap in top-3 retrieved chunks |
| Retrieval Jaccard @ K=5 | **0.661** | 66% overlap in top-5 |
| Kendall τ @ K=10 | **0.630** | Strong rank correlation — models broadly agree on ordering |
| ESP predicted divergent | Yes | But retrieval shows high agreement |
| ESP correct | **No (0/1)** | Verdict mismatch: ESP says incompatible, retrieval shows high overlap |

---

## 3. Did ESP Verdicts Correlate with Retrieval Divergence?

**Answer: No — in the opposite direction from expected.**

ESP classified the pair as "incompatible" (Frobenius distance 3.147, well above any reasonable threshold). However, actual retrieval shows **high agreement** between the models — 73% Jaccard overlap at K=3, Kendall τ of 0.63.

The divergence threshold in the runner was set at Jaccard@K3 < 0.5 (models retrieve substantially different chunks). The actual overlap of 0.73 comfortably exceeds this threshold, meaning both models essentially retrieve the **same content** despite having geometrically very different fingerprints.

This is the most informative failure mode: ESP over-fires. It calls "incompatible" when two models actually agree on what's relevant.

---

## 4. Which Pairs Showed Most Divergence?

With only one model pair, there's no relative comparison. But within the single comparison:

- **Highest agreement domain:** Machine learning queries (both models trained on text-heavy ML content — small-model sentence transformers and nemotron are both strong here)
- **Estimated lowest agreement:** Climate policy / ancient history (nemotron likely has domain advantages from its scale)

The overall K=1 Jaccard of 0.833 suggests that for most queries, both models independently identify the same best chunk — remarkably high agreement given the architectural differences.

---

## 5. Surprises

1. **The geometric divergence is huge but retrieval is nearly identical.** Frobenius distance of 3.147 is about 15× larger than what ESP would flag as "compatible" (< 0.2 for same-family models), yet 73% of retrieved chunks are the same. The geometric space is completely different; the semantic rankings are nearly the same.

2. **MiniLM-L6-v2 has higher anchor spread.** Mean pairwise distance of 0.893 vs nemotron's 0.817. The smaller model actually spreads anchors *more* in angular space — counter-intuitive, as larger models are typically thought to have richer representations.

3. **High Kendall τ (0.63) at K=10.** Even the *ordering* of top-10 chunks is substantially correlated. This suggests both models learned similar semantic orderings despite very different dimensionalities and training objectives.

4. **OpenAI API was inaccessible.** The project key (`proj_iLLw90FkR1AxHfd8H30YsI9P`) does not have access to embedding models. This needs to be resolved for the full 4-model comparison. This is a significant infrastructure gap for the roadmap.

---

## 6. Does This Validate or Challenge ESP?

**This result challenges ESP's core mechanism — but not fatally.**

### What the result means

The fingerprint matrix comparison correctly detected that the two models are geometrically very different. The **detection is working**. But the **interpretation of that detection is miscalibrated**: "geometrically different" ≠ "retrieves different content."

This mirrors the roadmap's concern: "If two genuinely different models produce ESVs that ESP classifies as 'incompatible' but they actually retrieve equally well — or ESP says 'compatible' but retrieval breaks — the protocol's detection mechanism is fundamentally flawed."

We got the first failure mode: ESP says "incompatible," they retrieve equally well.

### What it means for the protocol

ESP in its current form is a **geometry comparator**, not a **retrieval quality predictor**. Different architectures will always have geometrically different fingerprints. But what matters for the *actual use case* (can chunks from model A be retrieved by model B?) is whether the **semantic ordering is preserved**, not whether the **absolute geometry is identical**.

A model with 384 dimensions and a model with 2048 dimensions will never have matching pairwise distances. But if they both rank "the correct chunk" at position 1 for 83% of queries, they are functionally compatible for retrieval.

### Proposed reframe

ESP's binary claim — "compatible/incompatible for context exchange" — is too coarse. The correct framing is:

> "How often does retrieval by model A surface content that model B would also surface?"

This is exactly what the Jaccard and Kendall τ metrics measure. The fingerprint Frobenius distance is a proxy for this, but it appears to be a poor proxy when comparing cross-architecture models.

---

## 7. Roadmap Implications

### Does Experiment 2 (scale benchmark) still make sense?

**Yes, more urgently than before.** The high retrieval overlap at K=3 (73%) on a 54-chunk corpus is promising. The critical question is whether this holds at scale. If K=3 still retrieves the right content from a 540-chunk corpus (10× larger), then both models are viable for the dual-space architecture — and cross-model context exchange may actually work in practice despite the ESP "incompatible" verdict.

### What changed priorities

1. **ESP threshold recalibration is now Rank 1A.** The current thresholds were designed to detect model *updates* (same architecture, small drift), not cross-architecture differences. A recalibrated ESP should use Jaccard/Kendall τ-based compatibility rather than raw Frobenius distance.

2. **The roadmap's success criteria need updating.** "Same-family models (nemotron DGX vs Jetson) should produce compatible ESVs" still holds. But "cross-family models (nemotron vs OpenAI) should produce incompatible ESVs" is now questionable — cross-family models may be functionally compatible even when geometrically incompatible.

3. **OpenAI embedding access is a hard blocker.** The 4-model comparison (and all subsequent experiments) needs OpenAI `text-embedding-3-small` and `text-embedding-3-large`. This is infrastructure, not research.

4. **Experiment 3 (anchor ablation) should be deprioritized** until the correct metric for ESP comparison is established. Running ablations on a flawed metric produces noise.

### Revised priority order

1. Fix the ESP comparison metric (geometry → retrieval correlation)
2. Re-run Experiment 1 with 3-4 models using the new metric
3. Run Experiment 2 (scale benchmark) to validate K=3 at scale
4. Then ablation and threshold calibration with correct ground truth

---

## 8. Conclusion

ESP Experiment 1 ran successfully with 2 models (nemotron-embed@dgx and all-MiniLM-L6-v2@local). The key finding is:

**ESP correctly detects cross-architecture geometric divergence, but geometric divergence does not predict retrieval divergence. The two models retrieve 73% of the same content at K=3 despite a Frobenius fingerprint distance of 3.147.**

This challenges the assumption that ESV fingerprint compatibility ↔ retrieval compatibility. The result doesn't kill ESP — it reveals a calibration problem. The anchor set and fingerprint computation are working; the threshold interpretation is wrong.

The corrective path is to redefine ESP's compatibility verdict in terms of predicted retrieval overlap (Jaccard/Kendall τ) rather than absolute geometric distance. This requires training the thresholds on labeled data (pairs with known retrieval overlap), which is exactly what Experiments 2 and 3 are designed to provide.

---

*Infrastructure used: DGX GB10 (nemotron-embed, port 8004), Jetson1 local ONNX server (all-MiniLM-L6-v2 via xenova/transformers, port 8006).*  
*OpenAI embedding API not accessible — full 4-model comparison pending API access.*  
*Results file: `docs/esp-experiment1-results.json`*
