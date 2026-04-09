/**
 * Stability quorum assessment for proposition and embedding stability.
 *
 * @see docs/esp-critique-response.md §D.1
 */

import { cosineDistance } from '../embedding/esv.js';
import type { Embedder } from '../embedding/embedder.js';
import type { PropositionExtractor } from './extractor.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface StabilityQuorum {
  embeddingStable: boolean;
  propositionStable: boolean;
  /** Placeholder — requires wired proxy pipeline. Always true in this implementation. */
  decisionStable: boolean;
  /** True if >= 2 of 3 signals are stable. */
  quorumMet: boolean;
  /** 0-1: count of stable signals / 3. */
  confidence: number;
  details: {
    embeddingVariance?: number;
    propositionSimilarity?: number;
    decisionConsistency?: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Compute max pairwise cosine distance among a set of embedding vectors.
 */
function maxPairwiseDistance(embeddings: number[][]): number {
  let maxDist = 0;
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const d = cosineDistance(embeddings[i]!, embeddings[j]!);
      if (d > maxDist) maxDist = d;
    }
  }
  return maxDist;
}

/**
 * Jaccard similarity between two sets of strings.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  if (union === 0) return 1;
  return intersection / union;
}

// ─── assessStability ──────────────────────────────────────────────────

/**
 * Run a multi-signal stability quorum assessment on a piece of text.
 *
 * - Embedding stability: embed `runs` times, check max pairwise cosine distance < 0.02
 * - Proposition stability: extract `runs` times, check Jaccard similarity > 0.8
 * - Decision stability: placeholder — always true (requires wired proxy pipeline)
 */
export async function assessStability(
  text: string,
  extractor: PropositionExtractor,
  embedder: Embedder,
  runs: number = 3,
): Promise<StabilityQuorum> {
  // ── L1: Embedding stability ──────────────────────────────────────
  const embeddings: number[][] = [];
  for (let i = 0; i < runs; i++) {
    const emb = await embedder.embedOne(text);
    embeddings.push(emb);
  }
  const embeddingVariance = maxPairwiseDistance(embeddings);
  const embeddingStable = embeddingVariance < 0.02;

  // ── L2: Proposition stability ────────────────────────────────────
  // Use a stable source ID for repeated extractions of the same text
  const stabSourceId = 'stability-probe';
  const propRuns: string[][] = [];
  for (let i = 0; i < runs; i++) {
    const obs = await extractor.extract(text, stabSourceId);
    propRuns.push(obs.propositions.map((p) => p.text));
  }

  // Compute mean pairwise Jaccard across all run pairs
  let totalJaccard = 0;
  let pairCount = 0;
  for (let i = 0; i < propRuns.length; i++) {
    for (let j = i + 1; j < propRuns.length; j++) {
      totalJaccard += jaccardSimilarity(propRuns[i]!, propRuns[j]!);
      pairCount++;
    }
  }
  const propositionSimilarity = pairCount > 0 ? totalJaccard / pairCount : 1;
  const propositionStable = propositionSimilarity > 0.8;

  // ── L3: Decision stability (placeholder) ─────────────────────────
  // NOTE: Decision stability requires sending the same context through the
  // proxy pipeline multiple times and comparing model decisions. Not implemented
  // here because it requires the proxy pipeline to be wired end-to-end.
  const decisionStable = true;
  const decisionConsistency = 1.0;

  // ── Quorum ────────────────────────────────────────────────────────
  const stableCount = [embeddingStable, propositionStable, decisionStable].filter(Boolean).length;
  const quorumMet = stableCount >= 2;
  const confidence = stableCount / 3;

  return {
    embeddingStable,
    propositionStable,
    decisionStable,
    quorumMet,
    confidence,
    details: {
      embeddingVariance,
      propositionSimilarity,
      decisionConsistency,
    },
  };
}
