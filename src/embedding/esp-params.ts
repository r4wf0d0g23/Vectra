/**
 * ESP Parameter Store — load/save/rollback for tunable ESP parameters.
 *
 * Primary storage: data/esp-params.json
 * On each save, the atp-instance/vars/esp-params.md var file is also updated.
 *
 * Also provides applyToCompatibilityTs() which rewrites the hardcoded
 * constants in src/embedding/compatibility.ts with learned values.
 *
 * @see docs/recursive-self-improvement-spec.md §D
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ESPParams, ConfidenceTier } from './types.js';
import { SAFE_HARBOR_PARAMS } from './types.js';

// ─── File paths ──────────────────────────────────────────────────────

const DEFAULT_PARAMS_PATH = 'data/esp-params.json';

// ─── Versioned param state (internal) ───────────────────────────────

interface ESPParamsVersioned {
  version: string;
  updatedAt: string;
  calibrationPairsAtUpdate: number;
  calibrationConfidence: ConfidenceTier;
  wJaccard: number;
  wTau: number;
  tTransparent: number;
  tHighRisk: number;
  tReject: number;
  safeHarbor: {
    wJaccard: 0.6;
    tTransparent: 0.1;
    tHighRisk: 0.5;
    tReject: 0.8;
  };
  previous: Omit<ESPParamsVersioned, 'previous' | 'safeHarbor'> | null;
}

export interface UpdateMetadata {
  calibrationPairs: number;
  confidence: ConfidenceTier;
  trainLoss?: number;
  holdoutLoss?: number;
  reason?: string;
}

// ─── Version increment ───────────────────────────────────────────────

function incrementVersion(version: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return '0.1.0';
  parts[2]!++;
  if (parts[2]! >= 100) { parts[1]!++; parts[2] = 0; }
  if (parts[1]! >= 100) { parts[0]!++; parts[1] = 0; }
  return parts.join('.');
}

// ─── Default initial state ───────────────────────────────────────────

function defaultVersioned(): ESPParamsVersioned {
  return {
    version: '0.0.0',
    updatedAt: new Date().toISOString(),
    calibrationPairsAtUpdate: 0,
    calibrationConfidence: 'uncalibrated',
    wJaccard: 0.6,
    wTau: 0.4,
    tTransparent: 0.1,
    tHighRisk: 0.5,
    tReject: 0.8,
    safeHarbor: { wJaccard: 0.6, tTransparent: 0.1, tHighRisk: 0.5, tReject: 0.8 },
    previous: null,
  };
}

// ─── Disk I/O ────────────────────────────────────────────────────────

function loadVersioned(paramsPath: string): ESPParamsVersioned {
  if (!existsSync(paramsPath)) {
    const def = defaultVersioned();
    saveVersioned(def, paramsPath);
    return def;
  }
  try {
    return JSON.parse(readFileSync(paramsPath, 'utf-8')) as ESPParamsVersioned;
  } catch {
    return defaultVersioned();
  }
}

function saveVersioned(v: ESPParamsVersioned, paramsPath: string): void {
  const dir = dirname(paramsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = paramsPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(v, null, 2), 'utf-8');
  renameSync(tmpPath, paramsPath);
}

// ─── Markdown var update ──────────────────────────────────────────────

/**
 * Update the atp-instance/vars/esp-params.md var file with current state.
 * Called after every save so the var stays in sync.
 */
function updateMarkdownVar(v: ESPParamsVersioned): void {
  // Resolve relative to workspace, not cwd
  const varPath = resolve(process.cwd(), '../atp-instance/vars/esp-params.md');
  if (!existsSync(dirname(varPath))) return; // silently skip if atp-instance not available

  const now = new Date().toISOString();
  const content = `---
id: esp-params
name: ESP Tunable Parameters
version: 0.1.0
status: active
created: 2026-04-09
last_verified: ${now.slice(0, 10)}
verified_by: esp-param-store
classification: private
validator: json-file
staleness_policy: on-change-only
verify_cmd: |
  test -f /home/agent-raw/.openclaw/workspace/vectra/data/esp-params.json && \\
    node -e "const p = JSON.parse(require('fs').readFileSync('vectra/data/esp-params.json','utf-8')); console.log('version:', p.version, 'confidence:', p.calibrationConfidence)"
source: live
---

# ESP Tunable Parameters

## Current Value

**Version:** \`${v.version}\`
**Updated:** ${v.updatedAt}
**Calibration confidence:** ${v.calibrationConfidence}
**Pairs at update:** ${v.calibrationPairsAtUpdate}

### Active Parameters

| Parameter | Value | Bounds | Description |
|-----------|-------|--------|-------------|
| \`wJaccard\` | ${v.wJaccard} | [0.0, 1.0] | Jaccard weight in retrieval overlap risk |
| \`wTau\` | ${v.wTau.toFixed(2)} | derived | 1 - wJaccard |
| \`tTransparent\` | ${v.tTransparent} | [0.01, 0.25] | Risk threshold for transparent verdict |
| \`tHighRisk\` | ${v.tHighRisk} | [0.3, 0.7] | Risk threshold for high-risk verdict |
| \`tReject\` | ${v.tReject} | [0.6, 0.95] | Risk threshold for reject verdict |

### Safe Harbor Parameters (immutable)

| Parameter | Value |
|-----------|-------|
| \`wJaccard\` | 0.6 |
| \`tTransparent\` | 0.1 |
| \`tHighRisk\` | 0.5 |
| \`tReject\` | 0.8 |

### Previous 3 Update History

${v.previous
  ? `| ${v.previous.updatedAt.slice(0, 10)} | v${v.previous.version} | wJ=${v.previous.wJaccard} tT=${v.previous.tTransparent} tH=${v.previous.tHighRisk} tR=${v.previous.tReject} | ${v.previous.calibrationConfidence} |`
  : '_No prior updates._'}

## Update Instructions

This file is machine-maintained by \`src/embedding/esp-params.ts\`.
Do not edit manually. The optimizer updates this after each accepted parameter revision.
`;

  try {
    writeFileSync(varPath, content, 'utf-8');
  } catch {
    // Non-fatal: markdown var update failure does not block operation
  }
}

// ─── Public functional API ───────────────────────────────────────────

/**
 * Load current ESP params.
 */
export function loadESPParams(paramsPath: string = DEFAULT_PARAMS_PATH): ESPParams {
  const v = loadVersioned(paramsPath);
  return {
    wJaccard: v.wJaccard,
    tTransparent: v.tTransparent,
    tHighRisk: v.tHighRisk,
    tReject: v.tReject,
  };
}

/**
 * Save updated params. Saves current as previous for rollback.
 */
export function saveESPParams(
  params: ESPParams,
  metadata: UpdateMetadata,
  paramsPath: string = DEFAULT_PARAMS_PATH,
): void {
  const current = loadVersioned(paramsPath);

  // Archive current as previous (drop its own previous to avoid deep nesting)
  const { previous: _prev, safeHarbor: _sh, ...archivable } = current;
  const previous: Omit<ESPParamsVersioned, 'previous' | 'safeHarbor'> = archivable;

  const next: ESPParamsVersioned = {
    version: incrementVersion(current.version),
    updatedAt: new Date().toISOString(),
    calibrationPairsAtUpdate: metadata.calibrationPairs,
    calibrationConfidence: metadata.confidence,
    wJaccard: params.wJaccard,
    wTau: 1 - params.wJaccard,
    tTransparent: params.tTransparent,
    tHighRisk: params.tHighRisk,
    tReject: params.tReject,
    safeHarbor: { wJaccard: 0.6, tTransparent: 0.1, tHighRisk: 0.5, tReject: 0.8 },
    previous,
  };

  saveVersioned(next, paramsPath);
  updateMarkdownVar(next);
}

/**
 * Rollback to previous params.
 * Returns the restored params, or safe harbor if no previous exists.
 */
export function rollbackESPParams(paramsPath: string = DEFAULT_PARAMS_PATH): ESPParams {
  const current = loadVersioned(paramsPath);
  if (!current.previous) {
    console.error('[esp-params] rollback: no previous version — reverting to safe harbor');
    return loadSafeHarborParams();
  }
  const prev = current.previous;
  const restored: ESPParamsVersioned = {
    version: prev.version,
    updatedAt: new Date().toISOString(),
    calibrationPairsAtUpdate: prev.calibrationPairsAtUpdate,
    calibrationConfidence: prev.calibrationConfidence,
    wJaccard: prev.wJaccard,
    wTau: prev.wTau,
    tTransparent: prev.tTransparent,
    tHighRisk: prev.tHighRisk,
    tReject: prev.tReject,
    safeHarbor: { wJaccard: 0.6, tTransparent: 0.1, tHighRisk: 0.5, tReject: 0.8 },
    previous: null,
  };
  saveVersioned(restored, paramsPath);
  updateMarkdownVar(restored);
  return {
    wJaccard: restored.wJaccard,
    tTransparent: restored.tTransparent,
    tHighRisk: restored.tHighRisk,
    tReject: restored.tReject,
  };
}

/** Returns the immutable safe harbor params */
export function loadSafeHarborParams(): ESPParams {
  return { ...SAFE_HARBOR_PARAMS };
}

/**
 * Apply learned params to src/embedding/compatibility.ts by rewriting
 * hardcoded constants in-place.
 *
 * Replaces:
 *   - computeRetrievalOverlapRisk: 0.6 / 0.4 weights
 *   - computeVerdict: threshold values 0.8, 0.5, 0.1, 0.2
 */
export function applyToCompatibilityTs(
  params: ESPParams,
  compatibilityPath: string = 'src/embedding/compatibility.ts',
): void {
  if (!existsSync(compatibilityPath)) {
    console.error(`[esp-params] applyToCompatibilityTs: file not found at ${compatibilityPath}`);
    return;
  }

  let src = readFileSync(compatibilityPath, 'utf-8');

  // Replace weights in computeRetrievalOverlapRisk
  // Pattern: 1 - (0.6 * metrics.jaccardAtK3 + 0.4 * metrics.kendallTauAtK10)
  const wTau = Math.round((1 - params.wJaccard) * 100) / 100;
  src = src.replace(
    /return 1 - \([\d.]+\s*\*\s*metrics\.jaccardAtK3\s*\+\s*[\d.]+\s*\*\s*metrics\.kendallTauAtK10\)/,
    `return 1 - (${params.wJaccard} * metrics.jaccardAtK3 + ${wTau} * metrics.kendallTauAtK10)`,
  );

  // Replace tReject threshold in computeVerdict (Rule 1: > 0.8)
  src = src.replace(
    /retrievalOverlapRisk\s*!==\s*null\s*&&\s*retrievalOverlapRisk\s*>\s*[\d.]+\s*\)\s*\{[\s\S]*?rationale:.*Retrieval overlap critically low/,
    (match) => match.replace(/>\s*[\d.]+\s*\)/, `> ${params.tReject})`),
  );

  // Replace tHighRisk threshold in computeVerdict (Rule 2: > 0.5)
  src = src.replace(
    /retrievalOverlapRisk\s*!==\s*null\s*&&\s*retrievalOverlapRisk\s*>\s*[\d.]+\s*\)\s*\{[\s\S]*?rationale:.*Retrieval overlap is low/,
    (match) => match.replace(/>\s*[\d.]+\s*\)/, `> ${params.tHighRisk})`),
  );

  // Replace tTransparent threshold in computeVerdict (Rule 3: < 0.1)
  src = src.replace(
    /architectureDistance\s*<\s*[\d.]+\s*&&/,
    `architectureDistance < ${params.tTransparent} &&`,
  );

  // Replace secondary transparent check (retrievalOverlapRisk < 0.2 — derived as tTransparent * 2)
  const tTransparentDouble = Math.round(params.tTransparent * 2 * 100) / 100;
  src = src.replace(
    /\(retrievalOverlapRisk\s*===\s*null\s*\|\|\s*retrievalOverlapRisk\s*<\s*[\d.]+\)/,
    `(retrievalOverlapRisk === null || retrievalOverlapRisk < ${tTransparentDouble})`,
  );

  const tmpPath = compatibilityPath + '.tmp';
  writeFileSync(tmpPath, src, 'utf-8');
  renameSync(tmpPath, compatibilityPath);

  console.error(
    `[esp-params] Applied params to compatibility.ts: ` +
    `wJ=${params.wJaccard}, tT=${params.tTransparent}, tH=${params.tHighRisk}, tR=${params.tReject}`,
  );
}

// ─── Class API ───────────────────────────────────────────────────────

/** Object-oriented wrapper for ESP parameter store */
export class ESPParamStore {
  private paramsPath: string;

  constructor(paramsPath: string = DEFAULT_PARAMS_PATH) {
    this.paramsPath = paramsPath;
    // Initialize file if missing
    loadVersioned(paramsPath);
  }

  getCurrent(): ESPParams {
    return loadESPParams(this.paramsPath);
  }

  update(
    proposed: Partial<Pick<ESPParams, 'wJaccard' | 'tTransparent' | 'tHighRisk' | 'tReject'>>,
    calibrationPairs: number,
    confidence: ConfidenceTier,
  ): void {
    const current = this.getCurrent();
    const merged: ESPParams = { ...current, ...proposed };
    saveESPParams(merged, { calibrationPairs, confidence }, this.paramsPath);
  }

  rollback(_reason: string): void {
    rollbackESPParams(this.paramsPath);
  }

  revertToSafeHarbor(): void {
    const safe = loadSafeHarborParams();
    const versioned = loadVersioned(this.paramsPath);
    saveESPParams(safe, {
      calibrationPairs: versioned.calibrationPairsAtUpdate,
      confidence: versioned.calibrationConfidence,
      reason: 'safe-harbor-revert',
    }, this.paramsPath);
  }

  getActiveParams(): { wJaccard: number; tTransparent: number; tHighRisk: number; tReject: number } {
    return loadESPParams(this.paramsPath);
  }
}
