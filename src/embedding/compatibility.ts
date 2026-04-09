/**
 * Cross-model embedding compatibility assessment.
 *
 * Implements the layered risk profile from docs/esp-recalibration-spec.md.
 * Replaces the binary compatible/incompatible gate for cross-model comparisons.
 *
 * ESVComparison (esv.ts) is retained for same-model drift detection (its original
 * and correct use case).
 *
 * @see docs/esp-recalibration-spec.md §B–E
 */

import type { ESV } from './esv.js';
import { frobeniusNorm } from './esv.js';

// Re-export frobeniusNorm so consumers can import from this module too
export { frobeniusNorm };

// ─── Types ───────────────────────────────────────────────────────────

export interface RetrievalMetrics {
  /** Mean Jaccard similarity at K=3 across query set. 0–1. */
  jaccardAtK3: number;
  /** Mean Kendall τ at K=10 across query set. 0–1 (already normalized, 0=no correlation, 1=perfect). */
  kendallTauAtK10: number;
  /** Number of queries in the evaluation set. */
  queriesEvaluated: number;
  /** Number of corpus chunks. */
  corpusChunks: number;
}

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

  /** L4: Downstream answer divergence risk. 0–1. null (expensive, not implemented). */
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

  /** Model A identifier. */
  modelA: string;

  /** Model B identifier. */
  modelB: string;

  /** Anchor set version used for fingerprint computation. */
  anchorSetVersion: string;

  /** ISO 8601 timestamp when the profile was computed. */
  measuredAt: string;

  // ── Raw Metrics ───────────────────────────────────────────────

  /** Unnormalized Frobenius distance of fingerprint delta. */
  rawFrobeniusDistance: number;

  /** Frobenius norms of each input fingerprint matrix. */
  fingerprintMagnitudes: { modelA: number; modelB: number };

  /** Retrieval metrics breakdown, if measured. */
  retrievalMetrics: RetrievalMetrics | null;

  /** Dimensions of each model (for binary exchange feasibility). */
  dimensions: { modelA: number; modelB: number };
}

// ─── Layer Functions ─────────────────────────────────────────────────

/**
 * Compute the normalized architecture distance between two fingerprint matrices.
 *
 * Computes the Frobenius norm of (A - B), divided by the mean of
 * ||A||_F and ||B||_F. Clamped to [0, 1].
 */
export function computeArchitectureDistance(
  fingerprintA: number[][],
  fingerprintB: number[][],
): number {
  const n = fingerprintA.length;

  // Build full difference matrix
  const diff: number[][] = Array.from({ length: n }, (_, i) =>
    fingerprintA[i].map((v, j) => v - fingerprintB[i][j]),
  );

  const rawDist = frobeniusNorm(diff);
  const magA = frobeniusNorm(fingerprintA);
  const magB = frobeniusNorm(fingerprintB);
  const meanMag = (magA + magB) / 2;

  if (meanMag === 0) return 0;

  return Math.min(1, rawDist / meanMag);
}

/**
 * Compute the ordering inversion rate across all anchor triplets.
 *
 * For each anchor k, for each pair (i, j) where i < j and neither equals k,
 * checks if the ordering `dist(i,k) < dist(j,k)` flips between model A and model B.
 *
 * @returns Inversion rate in [0, 1]. 0 = all orderings preserved, 1 = all inverted.
 */
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

/**
 * Compute retrieval overlap risk from measured retrieval metrics.
 *
 * Composite: `1 - (0.6 * jaccardAtK3 + 0.4 * kendallTauAtK10)`
 * Returns 0–1 where 0 = perfect overlap, 1 = no overlap.
 */
export function computeRetrievalOverlapRisk(metrics: RetrievalMetrics): number {
  return 1 - (0.6 * metrics.jaccardAtK3 + 0.4 * metrics.kendallTauAtK10);
}

/**
 * Compute the operational verdict from a partial compatibility profile.
 *
 * Rules are evaluated in priority order; first match wins.
 *
 * 1. reject  — retrievalOverlapRisk > 0.8 OR downstreamAnswerRisk > 0.5
 * 2. high-risk — retrievalOverlapRisk > 0.5 OR rankingInstabilityRisk > 0.5
 * 3. transparent — architectureDistance < 0.1 AND retrieval ok/null
 * 4. caution — everything else
 */
export function computeVerdict(
  profile: Omit<CompatibilityProfile, 'operationalVerdict' | 'verdictRationale'>,
): { verdict: CompatibilityProfile['operationalVerdict']; rationale: string } {
  const {
    architectureDistance,
    retrievalOverlapRisk,
    rankingInstabilityRisk,
    downstreamAnswerRisk,
    retrievalMetrics,
  } = profile;

  // Rule 1: REJECT — hard evidence of retrieval or answer divergence
  if (retrievalOverlapRisk !== null && retrievalOverlapRisk > 0.8) {
    const jaccard = retrievalMetrics !== null ? retrievalMetrics.jaccardAtK3.toFixed(3) : 'n/a';
    return {
      verdict: 'reject',
      rationale: `Retrieval overlap critically low (Jaccard@K3: ${jaccard}). Cross-model context exchange will produce unreliable results.`,
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
    const jaccard = retrievalMetrics !== null ? retrievalMetrics.jaccardAtK3.toFixed(3) : 'n/a';
    return {
      verdict: 'high-risk',
      rationale: `Retrieval overlap is low (Jaccard@K3: ${jaccard}). Expect meaningful retrieval divergence.`,
    };
  }
  if (rankingInstabilityRisk > 0.5) {
    return {
      verdict: 'high-risk',
      rationale: `Ranking instability risk ${rankingInstabilityRisk.toFixed(2)} exceeds 0.5. Semantic orderings are frequently inverted between models.`,
    };
  }

  // Rule 3: TRANSPARENT — same model or near-identical space
  if (
    architectureDistance < 0.1 &&
    (retrievalOverlapRisk === null || retrievalOverlapRisk < 0.2)
  ) {
    return {
      verdict: 'transparent',
      rationale: 'Same-model or identical-family comparison. Retrieval behavior expected to be identical.',
    };
  }

  // Rule 4: CAUTION — different architectures, no strong evidence of divergence
  let rationale: string;
  if (retrievalOverlapRisk !== null && retrievalMetrics !== null) {
    const jaccard = retrievalMetrics.jaccardAtK3.toFixed(3);
    rationale =
      `Architecturally dissimilar (distance: ${architectureDistance.toFixed(3)}), ` +
      `but retrieval overlap is moderate (Jaccard@K3: ${jaccard}). ` +
      `Use with caution, not rejection.`;
  } else {
    rationale =
      `Architecturally dissimilar (distance: ${architectureDistance.toFixed(3)}). ` +
      `Retrieval overlap not yet measured — use with caution pending empirical validation.`;
  }

  return { verdict: 'caution', rationale };
}

/**
 * Compute a full CompatibilityProfile from two ESVs and optional retrieval data.
 *
 * Orchestrates all layer computations and assembles the final profile.
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
  calibration?: {
    confidence: CompatibilityProfile['calibrationConfidence'];
    labeledPairs: number;
  },
): CompatibilityProfile {
  const cal = calibration ?? { confidence: 'uncalibrated' as const, labeledPairs: 0 };
  const retrievalData = retrieval ?? null;

  // Compute individual fingerprint magnitudes
  const magA = frobeniusNorm(esvA.fingerprint);
  const magB = frobeniusNorm(esvB.fingerprint);
  const meanMag = (magA + magB) / 2;

  // Build difference matrix and compute raw Frobenius distance
  const n = esvA.fingerprint.length;
  const diff: number[][] = Array.from({ length: n }, (_, i) =>
    esvA.fingerprint[i].map((v, j) => v - esvB.fingerprint[i][j]),
  );
  const rawFrobeniusDistance = frobeniusNorm(diff);

  // L1: Architecture distance (normalized)
  const architectureDistance = meanMag > 0
    ? Math.min(1, rawFrobeniusDistance / meanMag)
    : 0;

  // L3: Ranking instability risk from anchor triplet inversions
  const rankingInstabilityRisk = computeOrderingInversionRate(
    esvA.fingerprint,
    esvB.fingerprint,
  );

  // L2: Retrieval overlap risk (null if no retrieval data)
  const retrievalOverlapRisk = retrievalData !== null
    ? computeRetrievalOverlapRisk(retrievalData)
    : null;

  // L4: Downstream answer risk — not implemented (expensive)
  const downstreamAnswerRisk: number | null = null;

  const partial: Omit<CompatibilityProfile, 'operationalVerdict' | 'verdictRationale'> = {
    architectureDistance,
    retrievalOverlapRisk,
    rankingInstabilityRisk,
    downstreamAnswerRisk,
    calibrationConfidence: cal.confidence,
    labeledPairsUsed: cal.labeledPairs,
    modelA: esvA.modelId,
    modelB: esvB.modelId,
    anchorSetVersion: esvA.anchorSetVersion,
    measuredAt: new Date().toISOString(),
    rawFrobeniusDistance,
    fingerprintMagnitudes: { modelA: magA, modelB: magB },
    retrievalMetrics: retrievalData,
    dimensions: { modelA: esvA.dimensions, modelB: esvB.dimensions },
  };

  const { verdict, rationale } = computeVerdict(partial);

  return {
    ...partial,
    operationalVerdict: verdict,
    verdictRationale: rationale,
  };
}
