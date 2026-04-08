/**
 * Vectra Intake Gate — task admission + protocol match.
 *
 * Every task must pass through intake before entering the system.
 * Intake normalizes the task, matches it against protocols, and
 * either admits the job or holds it for T3 analysis.
 */

import type { JobEnvelope } from '../core/job.js';
import type { RoutingMatch, DispatchMatcher } from '../atp/matcher.js';

// ─── Intake Result ──────────────────────────────────────────────────

export interface IntakeResult {
  admitted: boolean;
  matches: RoutingMatch[];
  /** If not admitted, where the held task was written. */
  heldPath: string | null;
  /** Reason for holding. */
  holdReason: string | null;
}

// ─── Intake Gate ────────────────────────────────────────────────────

export class IntakeGate {
  private matcher: DispatchMatcher;

  constructor(matcher: DispatchMatcher) {
    this.matcher = matcher;
  }

  /**
   * Process a job through the intake gate.
   *
   * 1. Normalize the task description
   * 2. Match against dispatch table
   * 3. If match found → admit
   * 4. If no match → hold for T3
   */
  async evaluate(job: JobEnvelope): Promise<IntakeResult> {
    const normalized = this.normalize(job.description);
    const matches = this.matcher.match(normalized);

    if (matches.length === 0) {
      return {
        admitted: false,
        matches: [],
        heldPath: null, // Caller writes the held file
        holdReason: `No protocol matched for: "${job.description}"`,
      };
    }

    return {
      admitted: true,
      matches,
      heldPath: null,
      holdReason: null,
    };
  }

  /**
   * Normalize task description for matching.
   * Lowercase, strip punctuation, collapse whitespace.
   */
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s/-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
