/**
 * ESP v2 multi-layer stability detection.
 *
 * Five layers:
 *   L1 Runtime      — model identity check
 *   L2 Lexical      — token-level hash comparison
 *   L3 Geometric    — ESV fingerprint comparison
 *   L4 Propositional — proposition extraction stability
 *   L5 Decision     — (placeholder, requires wired proxy pipeline)
 *
 * @see docs/esp-critique-response.md §D.1
 */

import { createHash } from 'node:crypto';
import { compareESV, type ESV } from '../embedding/esv.js';
import type { Embedder } from '../embedding/embedder.js';
import type { PropositionExtractor } from '../observation/extractor.js';

// ─── Types ────────────────────────────────────────────────────────────

export type LayerStatus = 'stable' | 'warning' | 'drift' | 'unknown';

export interface LayerResult {
  layer: 'runtime' | 'lexical' | 'geometric' | 'propositional' | 'decision';
  status: LayerStatus;
  details: string;
  timestamp: string;
}

export interface ESP2Assessment {
  /** Worst status across all layers. */
  overall: LayerStatus;
  layers: LayerResult[];
  /** True if L1 + L2 + L3 are all stable. */
  compatibleForBinaryExchange: boolean;
  /** True if L1 (runtime) failed. */
  requiresRebaseline: boolean;
  timestamp: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const STATUS_RANK: Record<LayerStatus, number> = {
  stable: 0,
  warning: 1,
  drift: 2,
  unknown: 3,
};

function worstStatus(statuses: LayerStatus[]): LayerStatus {
  return statuses.reduce((worst, s) =>
    STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst,
    'stable' as LayerStatus,
  );
}

/**
 * Tokenize text: split on whitespace and punctuation, lowercase.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\.,;:!?()\[\]{}"'\/\\<>@#$%^&*+=|~`\-]+/)
    .filter((t) => t.length > 0);
}

/**
 * Hash a set of tokens (sorted for determinism) to a hex string.
 */
function hashTokens(tokens: string[]): string {
  const sorted = [...tokens].sort().join('|');
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

/**
 * Jaccard similarity between two string arrays.
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

// ─── Canonical test text for L4 ───────────────────────────────────────

const L4_CANONICAL_TEXT =
  'The system processed the request successfully. Configuration was loaded from the default path. All three validation checks passed.';

// ─── Layer Assessors ──────────────────────────────────────────────────

/** L1: Runtime — model identity check. */
function assessL1(currentModelId: string, baselineModelId: string): LayerResult {
  const now = new Date().toISOString();
  if (currentModelId === baselineModelId) {
    return {
      layer: 'runtime',
      status: 'stable',
      details: `Model ID matches baseline: ${currentModelId}`,
      timestamp: now,
    };
  }
  return {
    layer: 'runtime',
    status: 'drift',
    details: `Model ID mismatch — current: ${currentModelId}, baseline: ${baselineModelId}`,
    timestamp: now,
  };
}

/**
 * L2: Lexical — token-level hash comparison.
 *
 * Compares a freshly computed hash of anchor texts against a stored lexical hash.
 * If no stored hash is provided, computes from the anchor set in the current ESV
 * (always matches — baseline is established on first run).
 */
function assessL2(
  anchorTexts: string[],
  storedLexicalHash?: string,
): LayerResult {
  const now = new Date().toISOString();
  const allTokens = anchorTexts.flatMap(tokenize);
  const currentHash = hashTokens(allTokens);

  if (!storedLexicalHash) {
    return {
      layer: 'lexical',
      status: 'stable',
      details: `Lexical hash established: ${currentHash} (no stored baseline to compare)`,
      timestamp: now,
    };
  }

  if (currentHash === storedLexicalHash) {
    return {
      layer: 'lexical',
      status: 'stable',
      details: `Lexical hash matches baseline: ${currentHash}`,
      timestamp: now,
    };
  }

  // Compute per-text token sets for the diff estimate
  const currentTokenSet = new Set(allTokens);
  const storedTokenCount = currentTokenSet.size; // best approximation without stored tokens
  const diffRate = storedTokenCount > 0
    ? 1 - jaccardSimilarity([...currentTokenSet], [...currentTokenSet]) // placeholder — can't recover stored tokens from hash
    : 1;

  // Without stored token sets we can only know hashes differ
  // Classify as warning (we can't compute a token diff rate from a hash)
  void diffRate;
  return {
    layer: 'lexical',
    status: 'warning',
    details: `Lexical hash mismatch — current: ${currentHash}, stored: ${storedLexicalHash}`,
    timestamp: now,
  };
}

/** L3: Geometric — ESV fingerprint comparison via compareESV(). */
function assessL3(currentESV: ESV, baselineESV: ESV): LayerResult {
  const now = new Date().toISOString();
  const comparison = compareESV(baselineESV, currentESV);

  let status: LayerStatus;
  switch (comparison.recommendation) {
    case 'compatible':
      status = 'stable';
      break;
    case 'warning':
      status = 'warning';
      break;
    case 'incompatible':
      status = 'drift';
      break;
  }

  return {
    layer: 'geometric',
    status,
    details: `meanDrift=${comparison.meanDrift}, maxDrift=${comparison.maxDrift}, breachedAnchors=${comparison.breachedAnchors}, frobenius=${comparison.frobeniusDistance}`,
    timestamp: now,
  };
}

/** L4: Propositional — extract propositions twice, compare Jaccard similarity. */
async function assessL4(extractor: PropositionExtractor): Promise<LayerResult> {
  const now = new Date().toISOString();

  const [obs1, obs2] = await Promise.all([
    extractor.extract(L4_CANONICAL_TEXT, 'l4-probe-1'),
    extractor.extract(L4_CANONICAL_TEXT, 'l4-probe-2'),
  ]);

  const texts1 = obs1.propositions.map((p) => p.text);
  const texts2 = obs2.propositions.map((p) => p.text);
  const similarity = jaccardSimilarity(texts1, texts2);

  const status: LayerStatus = similarity > 0.8 ? 'stable' : 'warning';

  return {
    layer: 'propositional',
    status,
    details: `Jaccard similarity=${similarity.toFixed(4)} (threshold=0.8), run1=${texts1.length} props, run2=${texts2.length} props`,
    timestamp: now,
  };
}

/** L5: Decision — placeholder. */
function assessL5(): LayerResult {
  return {
    layer: 'decision',
    status: 'unknown',
    details: 'Not implemented: requires wired proxy pipeline.',
    timestamp: new Date().toISOString(),
  };
}

// ─── runESP2Assessment ────────────────────────────────────────────────

export interface ESP2Config {
  modelId: string;
  currentESV: ESV;
  baselineESV: ESV;
  currentText: string;
  extractor: PropositionExtractor;
  embedder: Embedder;
  /** Optional: stored lexical hash from a previous run to compare against. */
  storedLexicalHash?: string;
  /** Optional: anchor texts to use for lexical hashing (defaults to anchor texts from ESV). */
  anchorTexts?: string[];
}

export async function runESP2Assessment(config: ESP2Config): Promise<ESP2Assessment> {
  const timestamp = new Date().toISOString();

  // Derive anchor texts from the baseline ESV's anchorCount for L2.
  // If explicit anchorTexts are provided, use those.
  const anchorTexts = config.anchorTexts ?? [config.currentText];

  const [l1, l2, l3, l4] = await Promise.all([
    Promise.resolve(assessL1(config.modelId, config.baselineESV.modelId)),
    Promise.resolve(assessL2(anchorTexts, config.storedLexicalHash)),
    Promise.resolve(assessL3(config.currentESV, config.baselineESV)),
    assessL4(config.extractor),
  ]);
  const l5 = assessL5();

  const layers: LayerResult[] = [l1, l2, l3, l4, l5];
  const overall = worstStatus(layers.map((l) => l.status));

  const compatibleForBinaryExchange =
    l1.status === 'stable' && l2.status === 'stable' && l3.status === 'stable';

  const requiresRebaseline = l1.status === 'drift';

  return {
    overall,
    layers,
    compatibleForBinaryExchange,
    requiresRebaseline,
    timestamp,
  };
}
