/**
 * Vectra Receipt Gate — validates handoff artifacts + T2 scan.
 *
 * No job is complete without a valid receipt. The receipt gate
 * checks that the artifact exists, is schema-valid, and contains
 * all required fields. T2 runs this after every sub-agent completion.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Receipt Schema (inline, matches handoff-artifact.schema.json) ──

export interface HandoffArtifact {
  bundle_id: string;
  protocol_id: string;
  completed_at: string;
  changes: string[];
  var_updates: Array<{
    var_id: string;
    field: string;
    old_value: string;
    new_value: string;
  }>;
  next_action: string;
  state_after: Record<string, unknown>;
}

const REQUIRED_FIELDS: (keyof HandoffArtifact)[] = [
  'bundle_id',
  'protocol_id',
  'completed_at',
  'changes',
  'var_updates',
  'next_action',
  'state_after',
];

// ─── Validation Result ──────────────────────────────────────────────

export type ReceiptViolationSeverity = 'missing' | 'incomplete' | 'invalid';

export interface ReceiptValidationResult {
  valid: boolean;
  bundleId: string;
  severity: ReceiptViolationSeverity | null;
  missingFields: string[];
  detail: string;
}

// ─── Receipt Gate ───────────────────────────────────────────────────

export class ReceiptGate {
  private artifactsPath: string;

  constructor(artifactsPath: string) {
    this.artifactsPath = artifactsPath;
  }

  /**
   * Validate a receipt for a given bundle ID.
   */
  async validate(bundleId: string): Promise<ReceiptValidationResult> {
    // Attempt to find the artifact file
    const artifact = await this.loadArtifact(bundleId);

    if (!artifact) {
      return {
        valid: false,
        bundleId,
        severity: 'missing',
        missingFields: REQUIRED_FIELDS as string[],
        detail: `No artifact found for bundle_id: ${bundleId}`,
      };
    }

    // Check required fields
    const missing = REQUIRED_FIELDS.filter(
      (f) => artifact[f] === undefined || artifact[f] === null
    );

    if (missing.length > 0) {
      return {
        valid: false,
        bundleId,
        severity: 'incomplete',
        missingFields: missing,
        detail: `Artifact missing required fields: ${missing.join(', ')}`,
      };
    }

    // Validate field types
    if (!Array.isArray(artifact.changes) || artifact.changes.length === 0) {
      return {
        valid: false,
        bundleId,
        severity: 'invalid',
        missingFields: [],
        detail: 'changes must be a non-empty array',
      };
    }

    if (typeof artifact.completed_at !== 'string' || !artifact.completed_at) {
      return {
        valid: false,
        bundleId,
        severity: 'invalid',
        missingFields: [],
        detail: 'completed_at must be a non-empty ISO timestamp string',
      };
    }

    return {
      valid: true,
      bundleId,
      severity: null,
      missingFields: [],
      detail: 'Receipt valid',
    };
  }

  /**
   * Attempt to load an artifact by bundle_id.
   * Scans the artifacts directory for a file containing the bundle_id.
   */
  private async loadArtifact(
    bundleId: string
  ): Promise<HandoffArtifact | null> {
    const { readdir } = await import('node:fs/promises');
    let files: string[];
    try {
      files = await readdir(this.artifactsPath);
    } catch {
      return null;
    }

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const raw = await readFile(join(this.artifactsPath, file), 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.bundle_id === bundleId) {
          return parsed as unknown as HandoffArtifact;
        }
      } catch {
        // Skip unparseable files
        continue;
      }
    }

    return null;
  }
}
