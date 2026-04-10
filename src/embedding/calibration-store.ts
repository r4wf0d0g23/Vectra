/**
 * Calibration Store — append-only persistent store for labeled calibration pairs.
 *
 * Provides both a class API (CalibrationStore) for object-oriented use and
 * functional exports (loadCalibrationStore, mergePairs) for the benchmark runner.
 *
 * Storage: data/calibration-store.json (relative to vectra workspace root)
 *
 * @see docs/recursive-self-improvement-spec.md §C
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CalibrationPair,
  CalibrationStoreData,
  ConfidenceTier,
  ESPParams,
} from './types.js';
import { SAFE_HARBOR_PARAMS, computeConfidenceTier } from './types.js';

const DEFAULT_STORE_PATH = 'data/calibration-store.json';

// ─── Band classification ─────────────────────────────────────────────

/**
 * Classify a pair into a verdict band using given thresholds.
 * Uses retrievalOverlapRisk as the primary band signal.
 */
function classifyBand(
  pair: CalibrationPair,
  params: ESPParams = SAFE_HARBOR_PARAMS,
): 'transparent' | 'caution' | 'high-risk' | 'reject' {
  const risk = pair.retrievalOverlapRisk;
  if (risk >= params.tReject) return 'reject';
  if (risk >= params.tHighRisk) return 'high-risk';
  if (risk >= params.tTransparent) return 'caution';
  return 'transparent';
}

/**
 * Compute band counts for all (non-outlier) pairs using given params.
 */
export function computeBandCounts(
  pairs: CalibrationPair[],
  params: ESPParams = SAFE_HARBOR_PARAMS,
): CalibrationStoreData['bandCounts'] {
  const counts: CalibrationStoreData['bandCounts'] = {
    transparent: 0,
    caution: 0,
    'high-risk': 0,
    reject: 0,
  };
  for (const pair of pairs) {
    if (pair.isOutlier) continue;
    counts[classifyBand(pair, params)]++;
  }
  return counts;
}

// ─── Static utilities ────────────────────────────────────────────────

/**
 * Compute a stable pair ID from model names and corpus ID.
 * SHA-256(modelA + "|" + modelB + "|" + corpusId), first 16 hex chars.
 */
export function generatePairId(modelA: string, modelB: string, corpusId: string): string {
  return createHash('sha256')
    .update(`${modelA}|${modelB}|${corpusId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Compute corpus ID from a list of chunk texts.
 * SHA-256(sorted chunks joined with "|"), first 16 hex chars.
 */
function computeCorpusId(chunks: string[]): string {
  return createHash('sha256')
    .update([...chunks].sort().join('|'))
    .digest('hex')
    .slice(0, 16);
}

// ─── Default store ───────────────────────────────────────────────────

function defaultStore(): CalibrationStoreData {
  return {
    schemaVersion: '1.0.0',
    pairs: [],
    lastUpdated: new Date().toISOString(),
    pairCount: 0,
    bandCounts: { transparent: 0, caution: 0, 'high-risk': 0, reject: 0 },
  };
}

// ─── Functional API ──────────────────────────────────────────────────

/**
 * Load calibration store from disk.
 * Creates the file (with empty store) if missing.
 */
export function loadCalibrationStore(storePath: string = DEFAULT_STORE_PATH): CalibrationStoreData {
  if (!existsSync(storePath)) {
    const store = defaultStore();
    saveCalibrationStore(store, storePath);
    return store;
  }
  try {
    const raw = readFileSync(storePath, 'utf-8');
    return JSON.parse(raw) as CalibrationStoreData;
  } catch {
    const store = defaultStore();
    saveCalibrationStore(store, storePath);
    return store;
  }
}

/**
 * Save calibration store to disk atomically (write to .tmp, then rename).
 */
export function saveCalibrationStore(
  store: CalibrationStoreData,
  storePath: string = DEFAULT_STORE_PATH,
): void {
  const dir = dirname(storePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = storePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, storePath);
}

/**
 * Merge new pairs into the calibration store.
 * Deduplicates by ID, recomputes band counts, returns stats.
 *
 * @returns { added, updated, triggered } — triggered if conditions for optimizer run are met.
 */
export function mergePairs(
  newPairs: CalibrationPair[],
  storePath: string = DEFAULT_STORE_PATH,
): { added: number; updated: number; triggered: boolean } {
  const store = loadCalibrationStore(storePath);
  const existingById = new Map<string, CalibrationPair>(store.pairs.map(p => [p.id, p]));

  let added = 0;
  let updated = 0;

  for (const pair of newPairs) {
    if (existingById.has(pair.id)) {
      // Update existing pair
      existingById.set(pair.id, pair);
      updated++;
    } else {
      existingById.set(pair.id, pair);
      added++;
    }
  }

  const allPairs = Array.from(existingById.values());
  const activePairs = allPairs.filter(p => !p.isOutlier);

  store.pairs = allPairs;
  store.pairCount = activePairs.length;
  store.bandCounts = computeBandCounts(activePairs);
  store.lastUpdated = new Date().toISOString();

  saveCalibrationStore(store, storePath);

  // Trigger condition: need 5+ new pairs since last optimizer run, and some band coverage
  // Simple check: total active pairs >= 5 AND at least 2 bands with at least 1 pair each
  const activeBandsWithAnyPairs = Object.values(store.bandCounts).filter(c => c > 0).length;
  const triggered = activePairs.length >= 5 && activeBandsWithAnyPairs >= 2;

  return { added, updated, triggered };
}

// ─── Class API ───────────────────────────────────────────────────────

/**
 * Object-oriented calibration store.
 * Wraps the functional API with state management.
 */
export class CalibrationStore {
  private pairs: CalibrationPair[] = [];
  private storePath: string;

  constructor(storePath: string = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    this.load();
  }

  // ── Private ──────────────────────────────────────────────────────

  private load(): void {
    const data = loadCalibrationStore(this.storePath);
    this.pairs = data.pairs;
  }

  private save(): void {
    const activePairs = this.getActive();
    const store: CalibrationStoreData = {
      schemaVersion: '1.0.0',
      pairs: this.pairs,
      lastUpdated: new Date().toISOString(),
      pairCount: activePairs.length,
      bandCounts: computeBandCounts(activePairs),
    };
    saveCalibrationStore(store, this.storePath);
  }

  // ── Public ────────────────────────────────────────────────────────

  /**
   * Add a new pair (dedup by ID).
   * isOutlier defaults to false on initial add.
   */
  add(pair: Omit<CalibrationPair, 'id' | 'isOutlier'>): CalibrationPair {
    const id = CalibrationStore.computeId(pair.modelA, pair.modelB, pair.corpusId);
    const existing = this.pairs.find(p => p.id === id);
    if (existing) {
      // Update in place (merge)
      Object.assign(existing, pair, { id, isOutlier: existing.isOutlier });
      this.save();
      return existing;
    }
    const full: CalibrationPair = { ...pair, id, isOutlier: false };
    this.pairs.push(full);
    this.save();
    return full;
  }

  /** Get all non-outlier pairs */
  getActive(): CalibrationPair[] {
    return this.pairs.filter(p => !p.isOutlier);
  }

  /** Get all pairs (including outliers) */
  getAll(): CalibrationPair[] {
    return [...this.pairs];
  }

  /** Get pairs classified in a specific verdict band */
  getByBand(
    band: 'transparent' | 'caution' | 'high-risk' | 'reject',
    params: ESPParams = SAFE_HARBOR_PARAMS,
  ): CalibrationPair[] {
    return this.getActive().filter(p => classifyBand(p, params) === band);
  }

  /** Flag a pair as outlier (CB-3) */
  flagOutlier(id: string, _reason: string): void {
    const pair = this.pairs.find(p => p.id === id);
    if (pair) {
      pair.isOutlier = true;
      this.save();
    }
  }

  /** Get current calibration confidence tier */
  getConfidence(): ConfidenceTier {
    const active = this.getActive();
    const bandCounts = computeBandCounts(active);
    return computeConfidenceTier(active.length, bandCounts);
  }

  /** Get band counts for active pairs */
  getBandCounts(params: ESPParams = SAFE_HARBOR_PARAMS): CalibrationStoreData['bandCounts'] {
    return computeBandCounts(this.getActive(), params);
  }

  /**
   * Check if optimizer should trigger.
   * Returns true if active pair count has grown by at least N since lastTriggerCount.
   */
  shouldTrigger(lastTriggerCount: number, N: number = 5): boolean {
    return this.getActive().length >= lastTriggerCount + N;
  }

  // ── Static utilities ──────────────────────────────────────────────

  /** Compute pair ID from model names and corpus ID */
  static computeId(modelA: string, modelB: string, corpusId: string): string {
    return generatePairId(modelA, modelB, corpusId);
  }

  /** Compute corpus ID from chunk texts */
  static computeCorpusId(chunks: string[]): string {
    return computeCorpusId(chunks);
  }
}
