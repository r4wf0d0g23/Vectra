/**
 * Vectra Dispatch Matcher — pattern match logic for ATP routing.
 *
 * Evolved from the atp-enforcement dispatch concept (now superseded).
 * Vectra owns dispatch as a transport interceptor — not an OpenClaw plugin.
 * Matches normalized task descriptions against protocol routing patterns
 * using substring matching with priority ordering.
 */

import type { RoutingEntry } from './loader.js';

// ─── Match Result ───────────────────────────────────────────────────

export interface RoutingMatch {
  /** Matched protocol ID. */
  protocolId: string;
  /** Pattern that matched. */
  matchedPattern: string;
  /** Var IDs to include in the context bundle. */
  varIds: string[];
  /** Required model class. */
  modelClass: string;
  /** Allowed tools. */
  toolAllowlist: string[];
  /** Guardrails from the protocol. */
  guardrails: string[];
  /** Priority (higher = prefer). */
  priority: number;
  /** Pattern specificity (number of terms — more specific = higher). */
  patternSpecificity: number;
  /** Match confidence (0-1). */
  confidence: number;
}

// ─── Matcher Interface ──────────────────────────────────────────────

export interface DispatchMatcher {
  match(normalizedTask: string): RoutingMatch[];
}

// ─── Pattern Matcher ────────────────────────────────────────────────

export class AtpDispatchMatcher implements DispatchMatcher {
  private entries: RoutingEntry[];
  private protocolGuardrails: Map<string, string[]>;

  constructor(
    entries: RoutingEntry[],
    protocolGuardrails: Map<string, string[]> = new Map()
  ) {
    this.entries = entries;
    this.protocolGuardrails = protocolGuardrails;
  }

  /**
   * Match a normalized task description against the routing table.
   *
   * Matching rules:
   * 1. Wildcard "*" matches everything (lowest priority)
   * 2. Pattern terms are split by " / " — any term match counts
   * 3. More terms matched = higher specificity
   * 4. Entries have explicit priority (default 0)
   *
   * Returns all matches, sorted by (priority DESC, specificity DESC).
   */
  match(normalizedTask: string): RoutingMatch[] {
    const matches: RoutingMatch[] = [];

    for (const entry of this.entries) {
      const result = this.matchEntry(normalizedTask, entry);
      if (result) {
        matches.push(result);
      }
    }

    // Sort: higher priority first, then higher specificity
    matches.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.patternSpecificity - a.patternSpecificity;
    });

    return matches;
  }

  /**
   * Update the routing table (for hot-reload).
   */
  updateEntries(entries: RoutingEntry[]): void {
    this.entries = entries;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private matchEntry(
    normalizedTask: string,
    entry: RoutingEntry
  ): RoutingMatch | null {
    const pattern = entry.task_pattern;

    // Wildcard matches everything
    if (pattern === '*') {
      return {
        protocolId: entry.execution_protocol,
        matchedPattern: '*',
        varIds: entry.var_ids ?? [],
        modelClass: entry.model_class ?? 'fast',
        toolAllowlist: entry.tool_allowlist ?? [],
        guardrails: this.protocolGuardrails.get(entry.execution_protocol) ?? [],
        priority: entry.priority ?? 0,
        patternSpecificity: 0,
        confidence: 0.1, // Wildcard = low confidence
      };
    }

    // Split pattern into terms by " / "
    const terms = pattern
      .toLowerCase()
      .split(/\s*\/\s*/)
      .map((t) => t.trim())
      .filter(Boolean);

    // Count how many terms match the task
    let matchedTerms = 0;
    for (const term of terms) {
      // Each term can have multiple words — check substring match
      const termWords = term.split(/\s+/);
      const allWordsPresent = termWords.every((w) => normalizedTask.includes(w));
      if (allWordsPresent) {
        matchedTerms++;
      }
    }

    if (matchedTerms === 0) {
      return null;
    }

    const specificity = matchedTerms;
    const confidence = matchedTerms / terms.length;

    return {
      protocolId: entry.execution_protocol,
      matchedPattern: pattern,
      varIds: entry.var_ids ?? [],
      modelClass: entry.model_class ?? 'fast',
      toolAllowlist: entry.tool_allowlist ?? [],
      guardrails: this.protocolGuardrails.get(entry.execution_protocol) ?? [],
      priority: entry.priority ?? 50, // Default priority 50 for specific patterns
      patternSpecificity: specificity,
      confidence,
    };
  }
}
