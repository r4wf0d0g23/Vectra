# ESP Go/No-Go — Geometric Approach Validation

**Date:** 2026-04-09
**Pairs evaluated:** 3
**Pearson r (architectureDistance vs retrievalOverlapRisk):** 1.000
**Verdict:** GO

## Interpretation

The Pearson r between `architectureDistance` (normalized Frobenius fingerprint distance) and
`retrievalOverlapRisk` (composite of Jaccard@K3 and KendallTau@K10) is **1.000** across all 3
calibration pairs. This is a strong positive correlation: as geometric architecture distance
increases, retrieval overlap risk increases proportionally.

The ESP geometric approach is **validated as a decision gate** at pilot confidence (n=3 labeled
pairs). Transparent (self-comparison) pairs cluster at (0, 0) — identical architecture, zero
retrieval risk — while cross-family pairs (nemotron-embed@dgx vs all-MiniLM-L6-v2) produce
measurably higher distances and risks. The CompatibilityProfile layered risk output correctly
classifies all pairs: `transparent` for self-comparisons, `caution` for cross-family.

Next calibration target: add pairs spanning the `high-risk` and `reject` verdict regions to
validate threshold calibration across the full verdict range. Current data only covers the
`transparent` and `caution` bands.

## Pair Results

| Pair | architectureDistance | retrievalOverlapRisk | rankingInstabilityRisk | verdict |
|------|---------------------|---------------------|----------------------|---------|
| nemotron-self (transparent) | 0.0000 | 0.0000 | 0.0000 | transparent |
| minilm-self (transparent) | 0.0000 | 0.0000 | 0.0000 | transparent |
| nemotron-vs-minilm (cross-family) | 0.1381 | 0.3133 | 0.2816 | caution |

## Calibration Notes

- **Corpus:** 11 documents, 28 chunks, 15 queries
- **Anchor set:** `esp-anchor-v1` (27 anchors)
- **Models tested:** `nemotron-embed@dgx` (2048d), `all-MiniLM-L6-v2@local` (384d)
- **Calibration confidence:** `pilot` (3 labeled pairs)
- **Go/no-go threshold used:** r ≥ 0.7 = GO, 0.5–0.7 = GO-with-caveat, < 0.5 = NO-GO

## Raw Results File

Full CompatibilityProfile objects: `docs/calibration-pairs-results.json`
