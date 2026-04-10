/**
 * ATP Execution Recorder — append-only store for protocol execution outcomes.
 *
 * Tracks every ATP bundle execution: outcome, duration, model class used,
 * complexity, and whether the current model class is right-sized.
 *
 * Used by the self-improvement loop to adapt model class assignments
 * per protocol over time (downgrade on 10 consecutive successes, upgrade on failure).
 *
 * Storage: atp-instance/data/execution-records.json
 *
 * @see docs/recursive-self-improvement-spec.md §K
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ATPExecutionRecord, ExecutionRecordStore } from '../embedding/types.js';

// ─── Paths ───────────────────────────────────────────────────────────

const DEFAULT_RECORDS_PATH = 'atp-instance/data/execution-records.json';

// ─── Model class ordering ─────────────────────────────────────────────

/**
 * Model class hierarchy: capable > agent > balanced > fast
 * Lower index = cheaper/faster; higher index = more capable.
 */
const MODEL_CLASS_ORDER: string[] = ['fast', 'balanced', 'agent', 'capable'];

/** Default complexity mapping by protocol ID */
const PROTOCOL_COMPLEXITY: Record<string, ATPExecutionRecord['taskComplexity']> = {
  'openclaw-config-change': 'mechanical',
  'dgx-inference-ops':      'analytical',
  'crew-ops':               'mechanical',
  'crew-peering':           'mechanical',
  'cradleos-deploy':        'analytical',
  'vectra-build':           'analytical',
  'memory-maintenance':     'mechanical',
  'atp-protocol-review':    'judgment',
};

// ─── Default store ───────────────────────────────────────────────────

function defaultStore(): ExecutionRecordStore {
  return {
    schemaVersion: '1.0.0',
    records: [],
    lastUpdated: new Date().toISOString(),
    recordCount: 0,
    summaries: {
      byProtocolAndModel: {},
      varChangeFrequency: {},
    },
  };
}

// ─── Disk I/O ────────────────────────────────────────────────────────

function loadStore(recordsPath: string): ExecutionRecordStore {
  if (!existsSync(recordsPath)) {
    const store = defaultStore();
    saveStore(store, recordsPath);
    return store;
  }
  try {
    return JSON.parse(readFileSync(recordsPath, 'utf-8')) as ExecutionRecordStore;
  } catch {
    return defaultStore();
  }
}

function saveStore(store: ExecutionRecordStore, recordsPath: string): void {
  const dir = dirname(recordsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = recordsPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, recordsPath);
}

// ─── Summary computation ──────────────────────────────────────────────

function recomputeSummaries(store: ExecutionRecordStore): void {
  const byProtocolAndModel: ExecutionRecordStore['summaries']['byProtocolAndModel'] = {};
  const varChangeFrequency: ExecutionRecordStore['summaries']['varChangeFrequency'] = {};

  for (const record of store.records) {
    const { protocolId, modelClass, outcome, varsVerified } = record;

    if (!byProtocolAndModel[protocolId]) byProtocolAndModel[protocolId] = {};
    if (!byProtocolAndModel[protocolId]![modelClass]) {
      byProtocolAndModel[protocolId]![modelClass] = {
        total: 0, success: 0, partial: 0, failure: 0, escalated: 0,
      };
    }
    const bucket = byProtocolAndModel[protocolId]![modelClass]!;
    bucket.total++;
    if (outcome === 'success') bucket.success++;
    else if (outcome === 'partial') bucket.partial++;
    else if (outcome === 'failure') bucket.failure++;
    else if (outcome === 'escalated') bucket.escalated++;

    for (const v of (varsVerified ?? [])) {
      if (!varChangeFrequency[v.varId]) {
        varChangeFrequency[v.varId] = { verifyCount: 0, changedCount: 0, changeRate: 0 };
      }
      const vf = varChangeFrequency[v.varId]!;
      if (v.verifyRan) vf.verifyCount++;
      if (v.stateChanged) vf.changedCount++;
      vf.changeRate = vf.verifyCount > 0 ? vf.changedCount / vf.verifyCount : 0;
    }
  }

  store.summaries = { byProtocolAndModel, varChangeFrequency };
}

// ─── Functional API ──────────────────────────────────────────────────

export function loadExecutionRecords(recordsPath: string = DEFAULT_RECORDS_PATH): ExecutionRecordStore {
  return loadStore(recordsPath);
}

export function saveExecutionRecords(
  store: ExecutionRecordStore,
  recordsPath: string = DEFAULT_RECORDS_PATH,
): void {
  saveStore(store, recordsPath);
}

export function recordExecution(
  record: ATPExecutionRecord,
  recordsPath: string = DEFAULT_RECORDS_PATH,
): void {
  const store = loadStore(recordsPath);
  store.records.push(record);
  store.recordCount = store.records.length;
  store.lastUpdated = new Date().toISOString();
  recomputeSummaries(store);
  saveStore(store, recordsPath);
}

// ─── Class API ───────────────────────────────────────────────────────

/**
 * Object-oriented wrapper for the ATP execution recorder.
 */
export class ATPExecutionRecorder {
  private recordsPath: string;

  constructor(recordsPath: string = DEFAULT_RECORDS_PATH) {
    this.recordsPath = recordsPath;
    loadStore(recordsPath); // initialize if missing
  }

  /** Append a new execution record and update summaries */
  record(entry: ATPExecutionRecord): void {
    recordExecution(entry, this.recordsPath);
  }

  /**
   * Get the success rate for a specific protocol + model class combination.
   * Looks at last N records for that protocol+model.
   */
  getSuccessRate(protocolId: string, modelClass: string, lastN: number = 10): number {
    const store = loadStore(this.recordsPath);
    const relevant = store.records
      .filter(r => r.protocolId === protocolId && r.modelClass === modelClass)
      .slice(-lastN);
    if (relevant.length === 0) return 0;
    const successes = relevant.filter(r => r.outcome === 'success').length;
    return successes / relevant.length;
  }

  /**
   * Check if model class should be downgraded.
   * Returns recommended cheaper model class, or null if no change.
   * Triggers on 10 consecutive successes.
   */
  checkModelClassDowngrade(protocolId: string, currentModelClass: string): string | null {
    const store = loadStore(this.recordsPath);
    const relevant = store.records
      .filter(r => r.protocolId === protocolId && r.modelClass === currentModelClass)
      .slice(-10);

    if (relevant.length < 10) return null;

    const allSuccess = relevant.every(r => r.outcome === 'success');
    if (!allSuccess) return null;

    const currentIdx = MODEL_CLASS_ORDER.indexOf(currentModelClass);
    if (currentIdx <= 0) return null; // already at 'fast', can't downgrade

    return MODEL_CLASS_ORDER[currentIdx - 1]!;
  }

  /**
   * Check if model class should be upgraded.
   * Returns recommended more-capable model class, or null if no change.
   * Triggers on any failure at current class.
   */
  checkModelClassUpgrade(protocolId: string, currentModelClass: string): string | null {
    const store = loadStore(this.recordsPath);
    const relevant = store.records
      .filter(r => r.protocolId === protocolId && r.modelClass === currentModelClass)
      .slice(-1);

    if (relevant.length === 0) return null;

    const lastRecord = relevant[0]!;
    if (lastRecord.outcome !== 'failure' && lastRecord.outcome !== 'escalated') return null;

    const currentIdx = MODEL_CLASS_ORDER.indexOf(currentModelClass);
    if (currentIdx < 0 || currentIdx >= MODEL_CLASS_ORDER.length - 1) return null;

    return MODEL_CLASS_ORDER[currentIdx + 1]!;
  }

  /** Get aggregate stats for a protocol */
  getProtocolStats(protocolId: string): {
    total: number;
    success: number;
    partial: number;
    failure: number;
    escalated: number;
    successRate: number;
  } {
    const store = loadStore(this.recordsPath);
    const all = store.records.filter(r => r.protocolId === protocolId);
    const total = all.length;
    const success = all.filter(r => r.outcome === 'success').length;
    const partial = all.filter(r => r.outcome === 'partial').length;
    const failure = all.filter(r => r.outcome === 'failure').length;
    const escalated = all.filter(r => r.outcome === 'escalated').length;
    return {
      total,
      success,
      partial,
      failure,
      escalated,
      successRate: total > 0 ? success / total : 0,
    };
  }

  /** Get all records */
  getAll(): ATPExecutionRecord[] {
    return loadStore(this.recordsPath).records;
  }

  /** Get task complexity for a protocol (from hardcoded map) */
  static getProtocolComplexity(protocolId: string): ATPExecutionRecord['taskComplexity'] {
    return PROTOCOL_COMPLEXITY[protocolId] ?? 'analytical';
  }
}
