# Opus Next-Steps Review — Post CompatibilityProfile Implementation

**Date:** 2026-04-09  
**Reviewer:** Opus Research Architect  
**Status:** State-of-project review with concrete next-step recommendations  
**Scope:** ESP geometric layer, CompatibilityProfile, observation layer, calibration path  

---

## A. Honest Project Assessment

### What Can Be Claimed With Confidence

1. **ESP's anchor fingerprinting produces real, reproducible geometric signatures.** The ESV computation (`esv.ts`, 242 lines) produces deterministic hashes from real model embeddings. ESV `eb29870568bd` for nemotron-embed on DGX and `e2e87b57e223` for MiniLM-L6-v2 are computed from real anchor embeddings. The computation is sound.

2. **The binary compatible/incompatible gate was wrong for cross-model comparison, and the diagnosis was correct.** Frobenius distance 3.147 yielded "incompatible" while Jaccard@K3 = 0.73 showed 73% retrieval overlap. The root cause analysis — that geometric distance measures space similarity, not retrieval compatibility — is accurate. This is genuinely a framing problem.

3. **The CompatibilityProfile is a structurally better replacement.** Four independent risk dimensions + calibration confidence + graded verdict is categorically superior to a single binary gate. The implementation in `compatibility.ts` matches the spec. The verdict rules are ordered correctly (reject → high-risk → transparent → caution). The nemotron-vs-MiniLM re-scoring (architecture distance 0.138, retrieval overlap risk 0.31, verdict "caution") is the correct answer for the data.

4. **The ordering inversion computation is implemented and plausible.** `computeOrderingInversionRate()` in `compatibility.ts` iterates all anchor triplets (O(n³) on n=27 = 17,550 triplets). This is a real geometric metric. However, it has **not been independently validated** — the only ranking instability value we have (0.37 for nemotron vs MiniLM) is estimated from Kendall τ, not computed from anchor triplets. The actual anchor-triplet value may differ.

### What Claims Are Still Unsupported

1. **We don't know if CompatibilityProfile verdicts are correct.** We have exactly **one data point** (nemotron vs MiniLM). The verdict "caution" *feels* right given 73% Jaccard overlap, but "feels right" is not "empirically validated." We have zero transparent-verdict pairs, zero high-risk pairs, and zero reject pairs. The threshold boundaries (0.2, 0.5, 0.8 for retrieval overlap risk) are design-time guesses with no empirical backing.

2. **We don't know if architecture distance predicts anything.** The normalized architecture distance of 0.138 lands in the "compatible architecture" band (0.05–0.20). But we only have one measurement. We don't know what MiniLM-L6 vs MiniLM-L12 scores. We don't know what nemotron-vs-nemotron (different hardware) scores. Without those reference points, the band boundaries are arbitrary lines on a number line.

3. **We don't know if the ranking instability metric is computed correctly from anchor triplets.** The implementation exists but has never been run against real ESV data — the 0.37 value in the experiment re-scoring is approximated from `1 - τ`, not computed from `computeOrderingInversionRate()`. There could be a gap between Kendall τ-estimated and actual anchor-triplet inversion rates.

4. **We don't know if K=3 retrieval holds at scale.** The 73% Jaccard@K3 was measured on 54 chunks. At 540 chunks, K=3 retrieves 0.56% of the corpus instead of 5.6%. Whether the overlap holds is the single most consequential unknown for the project.

5. **ESP v2's 5-layer architecture is implemented but only L3 (geometric) has been exercised.** L1 (runtime) is a string comparison. L2 (lexical) is a hash comparison of tokenized anchors — never tested across models. L4 (propositional) requires the `PropositionExtractor` to call nemotron3-super — never validated in an ESP assessment run. L5 (decision) is a placeholder returning "unknown." The `runESP2Assessment()` function exists but has never been called.

### The Biggest Open Scientific Question

**Does normalized architecture distance have any predictive power over retrieval compatibility?**

This is the foundational claim ESP rests on: that you can infer something about retrieval behavior from geometric fingerprint comparison. Experiment 1 showed the *old* metric (raw Frobenius) had no predictive power — it over-fired. The *new* metric (normalized architecture distance + ordering inversion rate) is hypothesized to be better, but this is untested. If normalized architecture distance doesn't correlate with retrieval overlap across 5+ model pairs, the entire geometric approach is a dead end — you'd need to measure retrieval directly every time, which defeats the purpose of a lightweight compatibility check.

### Is the CompatibilityProfile Fix Sufficient?

**It's necessary but reveals a deeper tension.** The CompatibilityProfile correctly separates architecture distance from retrieval overlap risk. But this separation creates a new problem: the *cheap* layers (architecture distance, ranking instability — computed from anchor fingerprints alone) may not predict the *expensive* layer (retrieval overlap risk — requires embedding the full corpus with both models). If the cheap layers don't predict the expensive layer, then:

- For any new model pair, you must run the expensive retrieval comparison anyway
- The cheap geometric comparison becomes diagnostic logging, not a decision gate
- ESP degrades from "protocol that prevents bad context exchange" to "protocol that documents what happened after you already ran the expensive test"

This isn't fatal — diagnostic value is real. But it's a significant reduction from the original ESP vision of a lightweight compatibility check that prevents expensive mistakes.

---

## B. Calibration Path Analysis

### Next 3 Calibration Pairs — Concrete Recommendations

**Pair 1: MiniLM-L6-v2 vs MiniLM-L12-v2 (same family, different size)**

- **Models:** `all-MiniLM-L6-v2` (384d, local ONNX) vs `all-MiniLM-L12-v2` (384d, local ONNX)
- **Endpoint:** Both via xenova/transformers on Jetson1 (port 8006, swap model between runs)
- **Expected outcome:** Architecture distance 0.02–0.08 (same family, same dimensions). Retrieval Jaccard@K3 > 0.85. Verdict: transparent or low-caution.
- **What it proves:** Whether same-family pairs produce low architecture distance (validates the lower band boundary). Whether same-dimension comparison works differently than cross-dimension.
- **Effort:** ~1 hour (model swap + re-run existing benchmark runner)
- **Why first:** Cheapest to run. No new infrastructure. Provides the "near-identical" reference point that's completely missing from calibration data.

**Pair 2: nemotron-embed DGX vs nemotron-embed DGX (self-comparison, re-run)**

- **Models:** `nemotron-embed@dgx` vs `nemotron-embed@dgx` (same model, two separate ESV computations)
- **Endpoint:** DGX GB10 port 8004
- **Expected outcome:** Architecture distance ~0.000 (identical model, deterministic inference). Jaccard@K3 = 1.0. Verdict: transparent.
- **What it proves:** Whether the "transparent" baseline is actually at 0.0 or if there's measurement noise. Establishes the floor. If architecture distance > 0.01 for same-model-same-hardware, something is wrong with the measurement.
- **Effort:** ~30 minutes (re-run existing experiment with same model on both sides)
- **Why second:** Establishes the absolute baseline. If this doesn't score 0.0, the normalization is broken.

**Pair 3: nemotron-embed (2048d) vs e5-base-v2 (768d, local)**

- **Models:** `nemotron-embed@dgx` (2048d) vs `intfloat/e5-base-v2` (768d, via xenova/transformers or sentence-transformers on DGX)
- **Endpoint:** DGX for nemotron, DGX or Jetson for e5-base-v2 via ONNX
- **Expected outcome:** Architecture distance 0.10–0.25 (different architecture, different dimensions, but both general-purpose). Retrieval Jaccard@K3 uncertain — this is the genuinely informative comparison.
- **What it proves:** Whether the nemotron-vs-MiniLM result generalizes to a different cross-family pair. If architecture distance and retrieval overlap risk land in similar bands to the first experiment, the bands might be real. If they diverge wildly, the bands are artifacts of a single data point.
- **Effort:** ~2 hours (need to set up e5-base-v2 serving endpoint)
- **Why third:** This is the first pair that genuinely tests generalization. Same-family (pair 1) and self-comparison (pair 2) are necessary reference points but don't challenge the metric.

### What `pilot` Confidence Actually Unlocks

With 5 labeled pairs (current 1 + the 3 above + 1 more), you could:

1. **Check whether architecture distance bands are non-arbitrary.** Do same-family pairs consistently land below 0.10? Do cross-family pairs consistently land above 0.10? If there's overlap, the band boundaries need adjustment.
2. **Check whether retrieval overlap risk is monotonically related to architecture distance.** If it's not — if some architecturally-distant pairs have low retrieval risk and some architecturally-similar pairs have high retrieval risk — then the cheap metric doesn't predict the expensive metric, and the entire ESP cost-efficiency argument collapses.
3. **Set a provisional "reject" threshold.** Right now, the reject threshold (retrievalOverlapRisk > 0.8) is a guess. With 5 pairs, you might have enough range to say "no pair above X has acceptable retrieval quality."

What you **cannot** do with 5 pairs:
- Set thresholds with statistical confidence (need 20+ for any meaningful ROC analysis)
- Claim generalization across domains (all data is on the same 54-chunk corpus)
- Claim robustness to corpus characteristics (chunk count, domain mix)

### Is 5 Pairs Sufficient?

**No, but the question is wrong.** The right question is: "What's the minimum to know whether the geometric approach is *worth pursuing further*?" That number is closer to 5 than 50. With 5 diverse pairs, you can see whether architecture distance and retrieval overlap are correlated at all. If the correlation is < 0.5, stop investing in geometric comparison and switch to direct retrieval comparison. If > 0.7, the geometric approach has legs and you invest in the full 50-pair calibration.

5 pairs is a **go/no-go checkpoint**, not a calibration dataset.

### MiniLM-L6 vs MiniLM-L12 Prediction

**Predicted CompatibilityProfile:**
- Architecture distance: **0.03–0.07** (same family, same dimensions, similar training data, different depth)
- Retrieval overlap risk: **0.05–0.15** (high agreement expected — both are sentence-transformers trained on similar data)
- Ranking instability risk: **0.05–0.15** (orderings should be well-preserved within the same family)
- Verdict: **transparent** (if architecture distance < 0.10 and retrieval overlap risk < 0.20)

**What it would prove if confirmed:**
- The "same family" band (0.05–0.20 architecture distance) is real — same-family pairs actually land there
- The transparent verdict fires correctly for genuinely compatible models
- The CompatibilityProfile distinguishes "same family" from "cross-architecture" (MiniLM pair at ~0.05 vs nemotron-MiniLM at 0.138)

**What it would prove if contradicted (e.g., architecture distance > 0.15):**
- The "same family" band is wrong — even closely related models produce significant geometric divergence
- Architecture distance is dominated by model depth/capacity differences, not just architecture family
- The band boundaries need to be wider, or the normalization needs rethinking

---

## C. Scale Benchmark vs. Calibration — What to Run First

### Case for Scale Benchmark First

**Argument:** The 73% Jaccard@K3 on 54 chunks might be an artifact of small corpus size. If K=3 at 500 chunks yields Jaccard < 0.30, then the entire CompatibilityProfile is measuring something irrelevant — because neither model's retrieval is useful at scale, making inter-model comparison moot. Scale benchmark tests the *foundation* that ESP sits on.

**Risk of skipping:** You calibrate CompatibilityProfile thresholds on a 54-chunk corpus, then discover at 500 chunks that retrieval quality collapses for everyone. All calibration work was wasted because the test conditions were unrealistic.

### Case for Calibration First

**Argument:** Calibration pairs are cheap (30 minutes to 2 hours each, mostly model swap + re-run). The scale benchmark requires building `corpus-loader.ts`, assembling a 200-500 chunk corpus, generating queries, and running retrieval. That's a full day. Getting 3-5 calibration pairs first tells you whether the geometric approach is worth pursuing *at all* before investing in the scale benchmark.

**Risk of skipping:** You build the scale benchmark infrastructure, run it, and discover that architecture distance has zero predictive power over retrieval compatibility. The scale benchmark data is still useful for the K-crossover question, but the ESP-specific analysis was premature.

### Risk Assessment

| Risk | Probability | Impact | Expected Cost |
|------|------------|--------|---------------|
| Scale benchmark reveals K=3 collapses at 500 chunks | Medium (30%) | High — undermines entire dual-space thesis | Major architectural rethink |
| Calibration reveals no correlation between architecture distance and retrieval | Medium (40%) | High — geometric approach is dead | Pivot to direct retrieval comparison |
| Scale benchmark at 54 chunks is representative of 500 chunks | Moderate (40%) | Low — current data is already meaningful | None (good outcome) |
| Architecture distance is predictive with 5 pairs | Low-moderate (30%) | Low — proceed to full calibration | None (good outcome) |

### Concrete Recommendation: Calibration First, Then Scale

**Run the 3 calibration pairs first (2-3 hours total), then the scale benchmark (full day).**

Rationale:
1. **Calibration pairs are cheaper per unit of information.** Each pair costs 30-120 minutes and tells you something independent about the metric. The scale benchmark costs a full day and primarily answers one question (K-crossover).
2. **Calibration can kill the geometric approach cheaply.** If the first 3 pairs show no correlation between architecture distance and retrieval overlap, you save yourself the day of scale benchmark work (at least the ESP-specific portions of it).
3. **The scale benchmark is still valuable regardless of ESP.** Even if geometric comparison fails, you need the K-crossover data for the dual-space architecture. But you want to know whether to *also* compute CompatibilityProfiles at scale, or just focus on single-model retrieval quality.
4. **Pair 2 (self-comparison) takes 30 minutes and is maximally informative.** If same-model architecture distance isn't ~0.0, something is fundamentally wrong. This is the cheapest possible sanity check.

**Order:**
1. Self-comparison (pair 2) — 30 min — validates the floor
2. MiniLM-L6 vs MiniLM-L12 (pair 1) — 1 hour — validates same-family band
3. nemotron vs e5-base-v2 (pair 3) — 2 hours — tests generalization
4. **Checkpoint:** Does architecture distance correlate with retrieval overlap across 4 pairs (including original)? If yes → proceed to scale benchmark. If no → pivot.
5. Scale benchmark at 200-500 chunks — full day

---

## D. The Observation Layer — Is It Premature?

### Current State

`src/observation/` contains 5 files, ~25KB total:
- `types.ts` — `VectraObservation`, `Proposition`, `Entity`, `Condition`, `Ambiguity` types
- `extractor.ts` — `PropositionExtractor` calling nemotron3-super on DGX port 8001
- `store.ts` — 4-tier observation store (raw evidence → observations → resolved facts → active context)
- `stability.ts` — `StabilityQuorum` assessment (embedding + proposition + decision stability)
- `index.ts` — exports

### Is It Useful Right Now?

**No.** The observation layer has zero integration points with the rest of the system. It's never been called outside of the L4 assessment in `layers.ts`, and `runESP2Assessment()` itself has never been called end-to-end. The `PropositionExtractor` depends on nemotron3-super at DGX port 8001, which is a live dependency — but nobody has verified whether it produces stable, useful extractions on real content.

The 4-tier store is an elaborate data structure with no consumers. No part of Vectra reads from the store. No part of the retrieval pipeline uses proposition-level embeddings. The store implements insert, query-by-entity, query-by-time-range, and confidence-filtered retrieval — but these operations have no callers.

### Does Proposition-Level Chunking Make Sense Before K=3 Scales?

**No.** Proposition-level chunking multiplies the number of index entries (one text chunk → 3-8 propositions). If K=3 on 54 chunks already produces 73% overlap, K=3 on 54 × 5 = 270 proposition entries may produce a much lower overlap because the search space is denser. You need to know the K-crossover at document-level chunking first, then separately at proposition-level chunking.

Running the observation layer before validating K-crossover is building on an assumption (K=3 is sufficient at proposition granularity) that hasn't been tested even at document granularity beyond 54 chunks.

### Integration Dependency Chain

For the observation layer to be useful, the following must be true:

1. **L3 (geometric) must be calibrated** — you need to know whether the embedding space comparison works before adding a proposition layer on top. If L3 is unreliable, L4's stability assessment (which runs L3 as a sub-component) is unreliable too.
2. **K-crossover must be established** — proposition-level chunking affects the number of index entries, which affects the required K. You need to know K at document-level first.
3. **PropositionExtractor must be validated** — does nemotron3-super produce consistent, accurate extractions? Nobody has tested this independently. The `StabilityQuorum` runs the extractor multiple times and checks Jaccard, but this test has never been executed.
4. **The retrieval pipeline must support proposition-level querying** — currently, retrieval is document-chunk-level. Adding proposition-level entries requires index schema changes.

### Honest Verdict

**Validate the geometric layer first. The observation layer code is not wasted — it's well-structured and architecturally sound — but it should sit dormant until prerequisites 1-3 are met.**

Specific recommendation:
- **Do not delete or refactor** `src/observation/`. The types and implementation are clean.
- **Do not build on it** until: (a) CompatibilityProfile is calibrated with ≥5 pairs showing geometric correlation, AND (b) K-crossover is established at 200+ chunks.
- **Do validate the PropositionExtractor independently** as a side task — call it on 20 diverse texts, check extraction quality, log results. This doesn't require the full integration chain. It's a 1-hour test that tells you whether nemotron3-super is a viable extraction model for proposition-level work.

---

## E. The OpenAI Embedding Blocker

### What Cross-Vendor Comparison Uniquely Proves

The nemotron-vs-MiniLM comparison is cross-architecture and cross-dimension, but both models are open-source and run locally. Adding OpenAI (text-embedding-3-small, text-embedding-3-large) would provide:

1. **A closed-source, API-only model pair.** This tests whether ESP works when you can't inspect the model internals — the realistic production scenario.
2. **A same-vendor, different-size pair** (3-small vs 3-large). This is the OpenAI equivalent of MiniLM-L6 vs MiniLM-L12 — tests same-family detection within a different vendor.
3. **A different training regime.** OpenAI's embedding models are trained with RLHF/instruction-following components; nemotron and MiniLM are not. If architecture distance captures training-regime differences, OpenAI comparisons would show it.

### Can Local/DGX Models Give Equivalent Scientific Value?

**Mostly yes, for the current calibration phase.**

What you can test without OpenAI:
- Same-model determinism (nemotron vs nemotron) ✓
- Same-family, different size (MiniLM-L6 vs MiniLM-L12) ✓
- Cross-family, cross-dimension (nemotron vs MiniLM) ✓ (already done)
- Cross-family, same-dimension (e5-base-v2 768d vs any other 768d model) ✓

What you **cannot** test without OpenAI:
- Closed-source API model behavior (API latency variance, non-determinism)
- OpenAI's specific embedding geometry (which may be qualitatively different from open-source models due to training differences)
- The specific 1536d and 3072d dimension ranges

**For the go/no-go checkpoint (5 calibration pairs), OpenAI is not needed.** You can get 5 diverse pairs from local/DGX models. For the full `preliminary` calibration (20+ pairs), OpenAI would be valuable but is one of many model families you'd want.

### Priority

**Proceed with local models. Fix OpenAI access as a background task, not a blocker.**

The key blocker is the project API key (`proj_iLLw90FkR1AxHfd8H30YsI9P`) lacking embedding model access. This is an account configuration issue, not a technical one. File the fix, but don't let it gate the calibration path.

---

## F. Recommended Next 3 Executable Actions

### Action 1: Run the 3 Calibration Pairs

**What to build/run:**
1. Re-run the existing `cross-model-esv-bench.ts` with nemotron-embed on both sides (self-comparison). Verify architecture distance ≈ 0.0.
2. Set up MiniLM-L12-v2 in the ONNX pipeline (same as L6 but different model file). Run the benchmark against MiniLM-L6-v2.
3. Set up e5-base-v2 via ONNX or sentence-transformers on DGX. Run against nemotron-embed.

For each pair, run through `computeCompatibilityProfile()` with actual ESV data. Record all 4 risk dimensions + verdict. Record actual Jaccard@K3 and Kendall τ@K10.

**What it proves/unlocks:**
- Whether architecture distance has any predictive power (correlation with retrieval overlap across 4 data points)
- Whether the verdict bands are non-arbitrary
- Go/no-go decision for the geometric approach
- Advances calibration from `uncalibrated` (0 formal pairs) to `pilot` (4 pairs)

**Estimated effort:** 3-4 hours total (30 min self-comparison + 1 hour MiniLM pair + 2 hours e5 pair setup and run)

**What it does NOT answer:**
- Whether the correlation holds at scale (500 chunks)
- Whether proposition-level chunking changes the picture
- Whether the thresholds are optimal (need 20+ pairs for ROC analysis)
- Whether adversarial evasion is possible

### Action 2: Run the Scale Benchmark (K-crossover at 200-500 chunks)

**What to build/run:**
1. Assemble a 200-500 chunk corpus. Simplest approach: download 40-80 Wikipedia articles across diverse topics, chunk at 512 tokens. No dataset licensing complexity.
2. Generate 50-100 queries using Sonnet/Opus (3 types: point, span, synthesis).
3. Embed corpus + queries with nemotron-embed (DGX). Run retrieval at K=1,3,5,10,20.
4. Measure: (a) Jaccard@K3 between nemotron and MiniLM at the larger corpus size, (b) quality retention at each K vs full-text baseline.

**What it proves/unlocks:**
- Whether K=3 is viable at scale or collapses
- Whether cross-model Jaccard@K3 degrades with corpus size
- The actual K-crossover point for production corpus sizes
- Whether the dual-space architecture thesis holds

**Estimated effort:** 6-8 hours (2 hours corpus prep, 1 hour query generation, 1 hour embedding, 2-3 hours retrieval + judging + analysis)

**What it does NOT answer:**
- Whether proposition-level chunking changes the K-crossover
- Whether the crossover is stable across domains
- Whether re-ranking would help

### Action 3: Compute Actual Anchor-Triplet Inversion Rates for All Pairs

**What to build/run:**
1. For all calibration pairs from Action 1, run `computeOrderingInversionRate()` on the actual ESV fingerprint matrices. This function exists in `compatibility.ts` but has never been called on real data.
2. Compare the anchor-triplet inversion rate against the Kendall τ-estimated ranking instability (1 - τ) for each pair.
3. Document the gap (or agreement) between the two measures.

**What it proves/unlocks:**
- Whether the anchor-triplet metric and the retrieval-ranking metric agree (they should correlate positively, but may diverge if the anchor set isn't representative of the retrieval corpus)
- Whether the anchor set is a good proxy for general retrieval behavior
- If they diverge significantly for some pairs → the anchor set has blind spots for those model comparisons

**Estimated effort:** 1-2 hours (pure computation on existing ESV data — no new model calls needed)

**What it does NOT answer:**
- Which specific anchors are causing any divergence
- Whether more anchors would help
- Whether randomized probing outperforms curated anchors

---

## G. The Falsification Question

### Does Architecture-Distance Still Need the Adversarial Evasion Test?

**Yes, and the CompatibilityProfile makes it more important, not less.**

The adversarial evasion test (Experiment 4 in the roadmap) asks: can a model be crafted to preserve anchor geometry while diverging on real content? Under the old binary gate, a false "compatible" verdict was bad but could be caught by noticing retrieval quality degradation in practice. Under the CompatibilityProfile, a false "transparent" verdict is more dangerous because the profile is designed to be *trusted* — it has calibration confidence, rationale, and multi-dimensional assessment, all of which create a false sense of security if the underlying anchor comparison is gameable.

However, the adversarial test is expensive (12+ hours, requires fine-tuning infrastructure). It should come **after** the go/no-go checkpoint from Action 1. If architecture distance doesn't even correlate with retrieval overlap in the non-adversarial case, adversarial evasion is moot.

### New Falsification Risks From CompatibilityProfile Design

**Risk 1: Verdict-shopping through retrieval metric availability.**

The verdict rules have an asymmetry: reject and high-risk can only fire when `retrievalOverlapRisk` is non-null, but `caution` is the default when it's null. This means: if you skip the expensive retrieval comparison, you can never get a `reject` verdict from the cheap metrics alone. A pair with architecture distance 0.95 and ranking instability 0.49 gets `caution`, not `reject` or `high-risk` — because 0.49 < 0.50.

This is a design choice (documented: "unknown defaults to proceed with monitoring"), but it creates a perverse incentive: if you want to avoid a reject verdict, just don't run the retrieval comparison.

**Mitigation:** Add a rule: if `architectureDistance > 0.5` AND `retrievalOverlapRisk === null`, the verdict should be `high-risk` (not `caution`), with rationale "Architecture is highly dissimilar and retrieval compatibility has not been measured."

**Risk 2: Calibration confidence stasis.**

The spec says calibration confidence only advances forward. But what if the 5 pilot pairs are all from the same corpus, same domain, same chunk count? You're at `pilot` confidence but the thresholds are still effectively uncalibrated for any corpus that differs from the test corpus. Calibration confidence conflates "number of pairs" with "diversity of pairs." The current tier definitions require diversity at `preliminary` (≥3 corpora) but not at `pilot`.

**Risk 3: The 0.6/0.4 weighting in retrieval overlap risk.**

`retrievalOverlapRisk = 1 - (0.6 × Jaccard@K3 + 0.4 × KendallTau@K10)`. The 0.6/0.4 split is design-time. It's plausible but completely uncalibrated. If Kendall τ turns out to be a better predictor of downstream answer quality than Jaccard@K3, the weighting is backwards. With only 1 data point, you can't fit this.

### The Single Falsification Experiment That Would Kill the Geometric Approach

**If 5 calibration pairs show Pearson r < 0.5 between normalized architecture distance and retrieval overlap risk, abandon the geometric comparison approach entirely.**

Concretely: plot architecture distance (x-axis) against retrieval overlap risk (y-axis) for all pairs. If the correlation is weak (r < 0.5), the cheap geometric metric doesn't predict the expensive retrieval metric. In that case:

- There is no shortcut — you must run retrieval comparison for every model pair
- ESP's geometric fingerprinting becomes a diagnostic annotation, not a decision gate
- The anchor set, ordering inversion computation, and fingerprint comparison are all overhead with no predictive value
- The correct pivot is: replace ESP's geometric layer with a direct retrieval sampling protocol (embed 50 random queries with both models, compute Jaccard@K3, use that as the compatibility metric)

This doesn't kill the *need* for embedding compatibility detection. It kills *this specific approach* of using anchor fingerprints as a proxy for retrieval compatibility.

The data to run this test is produced by Action 1. If the 4 pairs (self, same-family, cross-family-same-as-experiment-1, new-cross-family) show weak correlation, the answer is clear. No additional experiments needed.

---

## Summary

| Question | Answer |
|----------|--------|
| Where does ESP stand? | Correctly diagnosed its own failure. CompatibilityProfile is a better design. Zero empirical validation of the new design. |
| Biggest risk? | Architecture distance may not predict retrieval compatibility — making the geometric approach worthless as a decision gate. |
| Next step? | 3 calibration pairs (3-4 hours) → go/no-go on geometric approach. |
| Observation layer? | Premature. Validate geometric layer first. Code is fine, just dormant. |
| OpenAI blocker? | Not a blocker for the critical path. Fix in background. |
| Kill condition? | Pearson r < 0.5 between architecture distance and retrieval overlap across 5 pairs → abandon geometric comparison. |

---

*This review is a diagnostic, not a roadmap. It identifies what's unknown and proposes the cheapest experiments to resolve each unknown. The project has done good work in 24 hours — honest self-critique, correct root cause analysis, well-structured code. What it needs now is data, not more architecture.*
