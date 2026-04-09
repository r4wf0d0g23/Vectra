/**
 * Embedding Drift Detector — T1-compatible drift scanner.
 *
 * Computes the current ESV, compares against stored baselines,
 * and produces structured drift reports for the telemetry pipeline.
 *
 * @see docs/embedding-stability-protocol.md §3
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Embedder } from './embedder.js';
import { ANCHOR_TEXTS } from './anchor-set.js';
import { type ESV, type ESVComparison, computeESV, compareESV } from './esv.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface DriftReport {
  timestamp: string;
  baselineVersion: string;
  currentVersion: string;
  compatible: boolean;
  severity: 'clean' | 'warning' | 'critical';
  meanDrift: number;
  maxDrift: number;
  breachedAnchors: number;
  affectedAnchorIndices: number[];
  frobeniusDistance: number;
  recommendation: string;
}

// ─── Drift Detector ─────────────────────────────────────────────────

export class DriftDetector {
  private embedder: Embedder;
  private baselinePath: string;

  /**
   * @param embedder - Embedding client to use.
   * @param baselinePath - File path for storing/loading the ESV baseline JSON.
   */
  constructor(embedder: Embedder, baselinePath: string) {
    this.embedder = embedder;
    this.baselinePath = baselinePath;
  }

  /**
   * Compute the ESV for the current model by embedding the full anchor set.
   */
  async computeCurrentESV(): Promise<ESV> {
    const modelId = await this.embedder.getModelId();
    const embeddings = await this.embedder.embed(ANCHOR_TEXTS);
    return computeESV(embeddings, modelId);
  }

  /**
   * Compare the current ESV against a provided baseline.
   * Returns a structured DriftReport with severity classification.
   */
  async detectDrift(baselineESV: ESV): Promise<DriftReport> {
    const currentESV = await this.computeCurrentESV();
    const comparison = compareESV(baselineESV, currentESV);

    return this.buildReport(baselineESV, currentESV, comparison);
  }

  /**
   * Save an ESV as the new baseline.
   */
  async saveBaseline(esv: ESV): Promise<void> {
    await mkdir(dirname(this.baselinePath), { recursive: true });
    await writeFile(this.baselinePath, JSON.stringify(esv, null, 2), 'utf-8');
  }

  /**
   * Load the stored baseline ESV, or null if none exists.
   */
  async loadBaseline(): Promise<ESV | null> {
    try {
      const raw = await readFile(this.baselinePath, 'utf-8');
      return JSON.parse(raw) as ESV;
    } catch {
      return null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private buildReport(
    baseline: ESV,
    current: ESV,
    comparison: ESVComparison,
  ): DriftReport {
    // Identify which anchor pair indices were breached
    const affectedIndices: number[] = [];
    const n = baseline.anchorCount;
    const threshold = 0.1;

    for (let i = 0; i < n; i++) {
      let anchorBreached = false;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const delta = Math.abs(
          baseline.fingerprint[i][j] - current.fingerprint[i][j],
        );
        if (delta > threshold) {
          anchorBreached = true;
          break;
        }
      }
      if (anchorBreached) {
        affectedIndices.push(i);
      }
    }

    // Severity classification per ESP spec §3.5
    let severity: DriftReport['severity'];
    let recommendation: string;

    if (comparison.meanDrift < 0.01 && comparison.maxDrift < 0.03) {
      severity = 'clean';
      recommendation =
        'No drift detected. Models are functionally identical.';
    } else if (comparison.recommendation === 'warning') {
      severity = 'warning';
      recommendation =
        'Minor drift detected. Monitor at higher cadence. Consider alignment transform.';
    } else if (comparison.recommendation === 'incompatible') {
      severity = 'critical';
      recommendation =
        'CRITICAL: Embedding spaces are incompatible. Halt binary context exchange. Full re-encoding required.';
    } else {
      severity = 'clean';
      recommendation = 'Embedding spaces are compatible.';
    }

    return {
      timestamp: new Date().toISOString(),
      baselineVersion: baseline.version,
      currentVersion: current.version,
      compatible: comparison.compatible,
      severity,
      meanDrift: comparison.meanDrift,
      maxDrift: comparison.maxDrift,
      breachedAnchors: comparison.breachedAnchors,
      affectedAnchorIndices: affectedIndices,
      frobeniusDistance: comparison.frobeniusDistance,
      recommendation,
    };
  }
}
