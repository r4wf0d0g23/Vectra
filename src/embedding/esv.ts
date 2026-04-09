/**
 * Embedding Space Version (ESV) — computation and comparison.
 *
 * The ESV is a fingerprint of an embedding space's geometry, computed
 * from the pairwise cosine distance matrix of the canonical anchor set.
 * Two models with the same ESV are compatible for binary context exchange.
 *
 * @see docs/embedding-stability-protocol.md §2.4, §4.5
 */

import { createHash } from 'node:crypto';
import { ANCHOR_SET_VERSION } from './anchor-set.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ESV {
  /** SHA-256 hash of the flattened fingerprint matrix (first 12 hex chars). */
  version: string;
  /** Embedding model identifier. */
  modelId: string;
  /** Number of anchors used (should always be 27 for v1). */
  anchorCount: number;
  /** Pairwise cosine distance matrix (n×n, symmetric, zero diagonal). */
  fingerprint: number[][];
  /** ISO 8601 timestamp of computation. */
  computedAt: string;
  /** Mean of off-diagonal distances. */
  meanDistance: number;
  /** Standard deviation of off-diagonal distances. */
  stdDistance: number;
  /** Embedding dimensionality. */
  dimensions: number;
  /** Anchor set version used. */
  anchorSetVersion: string;
  /** Compact ESV string: "esp-v1:<hash>:<dims>:<tolerance>". */
  compact: string;
}

export interface ESVComparison {
  compatible: boolean;
  meanDrift: number;
  maxDrift: number;
  /** Number of anchor pairs where distance delta exceeds threshold. */
  breachedAnchors: number;
  /** Frobenius norm of the fingerprint difference matrix. */
  frobeniusDistance: number;
  recommendation: 'compatible' | 'warning' | 'incompatible';
}

// ─── Math Utilities ─────────────────────────────────────────────────

/** Dot product of two vectors. */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** L2 norm of a vector. */
function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

/**
 * Cosine distance between two vectors: 1 - cosine_similarity.
 * Returns 0 for identical vectors, 2 for opposite vectors.
 */
export function cosineDistance(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 1;
  const similarity = dot(a, b) / (na * nb);
  // Clamp to [-1, 1] to handle floating-point edge cases
  return 1 - Math.max(-1, Math.min(1, similarity));
}

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Compute the pairwise cosine distance matrix for a set of embeddings.
 * Returns an n×n symmetric matrix with zero diagonal.
 * Distances are rounded to 6 decimal places per ESP spec.
 */
export function computePairwiseDistances(embeddings: number[][]): number[][] {
  const n = embeddings.length;
  const matrix: number[][] = Array.from({ length: n }, () =>
    new Array(n).fill(0),
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.round(cosineDistance(embeddings[i], embeddings[j]) * 1e6) / 1e6;
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }

  return matrix;
}

/**
 * Extract off-diagonal values from a symmetric distance matrix.
 * Returns the upper triangle values (no duplicates, no diagonal).
 */
function offDiagonal(matrix: number[][]): number[] {
  const values: number[] = [];
  const n = matrix.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      values.push(matrix[i][j]);
    }
  }
  return values;
}

/** Mean of an array of numbers. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Standard deviation of an array of numbers. */
function std(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Compute the SHA-256 hash of a flattened fingerprint matrix.
 * Deterministic: uses row-major order, float64 representation rounded to 6 places.
 */
function hashFingerprint(matrix: number[][]): string {
  // Flatten to a deterministic string representation
  const flat = matrix.map((row) => row.map((v) => v.toFixed(6)).join(',')).join(';');
  return createHash('sha256').update(flat).digest('hex').slice(0, 12);
}

/**
 * Compute an Embedding Space Version from anchor embeddings.
 *
 * @param embeddings - One embedding vector per anchor (must match anchor set order).
 * @param modelId - Identifier of the embedding model used.
 * @returns Fully populated ESV object.
 */
export function computeESV(embeddings: number[][], modelId: string): ESV {
  if (embeddings.length === 0) {
    throw new Error('Cannot compute ESV from empty embeddings');
  }

  const fingerprint = computePairwiseDistances(embeddings);
  const offDiag = offDiagonal(fingerprint);
  const version = hashFingerprint(fingerprint);
  const dimensions = embeddings[0].length;
  const tolerance = 0.05;

  return {
    version,
    modelId,
    anchorCount: embeddings.length,
    fingerprint,
    computedAt: new Date().toISOString(),
    meanDistance: Math.round(mean(offDiag) * 1e6) / 1e6,
    stdDistance: Math.round(std(offDiag) * 1e6) / 1e6,
    dimensions,
    anchorSetVersion: ANCHOR_SET_VERSION,
    compact: `${ANCHOR_SET_VERSION}:${version}:${dimensions}:${tolerance}`,
  };
}

/**
 * Compare two ESVs for compatibility.
 *
 * Uses the 90/10 rule from ESP spec §1.4:
 * - If >10% of anchor pair distance deltas exceed the threshold, incompatible.
 * - Threshold for individual pair delta: 0.1 (task routing tolerance).
 *
 * @param a - Baseline ESV.
 * @param b - Current ESV to compare against baseline.
 */
export function compareESV(a: ESV, b: ESV): ESVComparison {
  if (a.anchorCount !== b.anchorCount) {
    return {
      compatible: false,
      meanDrift: Infinity,
      maxDrift: Infinity,
      breachedAnchors: a.anchorCount,
      frobeniusDistance: Infinity,
      recommendation: 'incompatible',
    };
  }

  const n = a.anchorCount;
  const threshold = 0.1;
  let sumDelta = 0;
  let maxDelta = 0;
  let breached = 0;
  let frobSum = 0;
  let pairCount = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const delta = Math.abs(a.fingerprint[i][j] - b.fingerprint[i][j]);
      sumDelta += delta;
      frobSum += delta ** 2;
      pairCount++;
      if (delta > maxDelta) maxDelta = delta;
      if (delta > threshold) breached++;
    }
  }

  const meanDrift = pairCount > 0 ? sumDelta / pairCount : 0;
  const frobeniusDistance = Math.sqrt(frobSum);
  const breachRate = pairCount > 0 ? breached / pairCount : 0;

  // Compatibility decision per ESP spec §3.5
  let recommendation: 'compatible' | 'warning' | 'incompatible';
  let compatible: boolean;

  if (meanDrift < 0.01 && maxDelta < 0.03) {
    recommendation = 'compatible';
    compatible = true;
  } else if (meanDrift < 0.08 && breachRate < 0.10) {
    recommendation = 'warning';
    compatible = true; // degraded but operational
  } else {
    recommendation = 'incompatible';
    compatible = false;
  }

  return {
    compatible,
    meanDrift: Math.round(meanDrift * 1e6) / 1e6,
    maxDrift: Math.round(maxDelta * 1e6) / 1e6,
    breachedAnchors: breached,
    frobeniusDistance: Math.round(frobeniusDistance * 1e6) / 1e6,
    recommendation,
  };
}
