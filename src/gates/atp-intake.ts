/**
 * Vectra ATP Intake Gate — dispatch table integration.
 *
 * Wires the ATP dispatch table into Vectra's message handler.
 * For every inbound message:
 * 1. Load dispatch table from {atpPath}/protocols/orchestration-main.md
 * 2. Pattern match against routing entries
 * 3. If matched: return protocol binding with required var IDs
 * 4. If unmatched: write held file to {atpPath}/intake/, return null
 *
 * GUARDRAIL: Fails open — if the dispatch table is unreadable or parsing
 * fails, the gate returns null and the caller proceeds without a protocol
 * match (conversational fallback). Never blocks message flow.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AtpLoader } from '../atp/loader.js';
import { AtpDispatchMatcher } from '../atp/matcher.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ATPMatchResult {
  protocolId: string;
  varIds: string[];
  modelClass: string;
}

export interface HeldTask {
  file: string;
  held_at: string;
  task_description: string;
  status: string;
}

// ─── ATP Intake Gate ────────────────────────────────────────────────

export class ATPIntakeGate {
  private atpPath: string;
  private loader: AtpLoader | null = null;
  private matcher: AtpDispatchMatcher | null = null;
  private initialized = false;

  constructor(atpPath: string) {
    this.atpPath = atpPath;
  }

  /**
   * Initialize the gate by loading the ATP instance.
   * Called lazily on first match attempt.
   * Fail-open: errors are swallowed and the gate stays uninitialized.
   */
  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return this.matcher !== null;

    this.initialized = true;
    try {
      this.loader = new AtpLoader(this.atpPath);
      const data = await this.loader.load();

      if (data.routingTable.length === 0) {
        return false;
      }

      // Collect guardrails per protocol
      const guardrails = new Map<string, string[]>();
      for (const [id, proto] of data.protocols) {
        if (proto.frontmatter.guardrails) {
          guardrails.set(id, proto.frontmatter.guardrails);
        }
      }

      this.matcher = new AtpDispatchMatcher(data.routingTable, guardrails);
      return true;
    } catch {
      // Fail open — dispatch table unreadable
      this.matcher = null;
      return false;
    }
  }

  /**
   * Match a message against the ATP dispatch table.
   *
   * Returns the best protocol match, or null if:
   * - No protocol matched (wildcard "*" is excluded from results)
   * - Dispatch table couldn't be loaded (fail-open)
   *
   * The wildcard catch-all is intentionally excluded — it represents
   * "conversational" which is the default when no match is found.
   */
  async match(text: string): Promise<ATPMatchResult | null> {
    const ready = await this.ensureInitialized();
    if (!ready || !this.matcher) {
      // Fail open: no dispatch table available
      return null;
    }

    const normalized = text
      .toLowerCase()
      .replace(/[^\w\s/-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const matches = this.matcher.match(normalized);

    // Filter out wildcard catch-all — that's the default, not a real match
    const specific = matches.filter((m) => m.matchedPattern !== '*');

    if (specific.length === 0) {
      return null;
    }

    // Return highest-priority specific match
    const best = specific[0];
    return {
      protocolId: best.protocolId,
      varIds: best.varIds,
      modelClass: best.modelClass,
    };
  }

  /**
   * Load var file contents for a matched protocol.
   *
   * @param varIds - Var IDs from the match result.
   * @returns Map of var ID to file content.
   */
  async loadVars(varIds: string[]): Promise<Record<string, string>> {
    const vars: Record<string, string> = {};

    for (const varId of varIds) {
      const varPath = join(this.atpPath, 'vars', `${varId}.md`);
      try {
        vars[varId] = await readFile(varPath, 'utf-8');
      } catch {
        // Missing var file is non-fatal — skip it
        vars[varId] = '';
      }
    }

    return vars;
  }

  /**
   * Hold an unmatched task for later review.
   *
   * Writes a JSON file to {atpPath}/intake/held-{timestamp}.json
   * with the task description and metadata.
   *
   * @returns Path to the held file.
   */
  async holdTask(text: string, sessionId: string): Promise<string> {
    const intakePath = join(this.atpPath, 'intake');

    // Ensure intake directory exists
    try {
      await mkdir(intakePath, { recursive: true });
    } catch {
      // Already exists — fine
    }

    const timestamp = Date.now();
    const filename = `held-${timestamp}.json`;
    const filePath = join(intakePath, filename);

    const heldRecord = {
      held_at: new Date(timestamp).toISOString(),
      task_description: text,
      session_id: sessionId,
      status: 'pending',
      matched_protocol: null,
      resolution: null,
    };

    await writeFile(filePath, JSON.stringify(heldRecord, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Get all held tasks from the intake directory.
   *
   * Returns tasks sorted chronologically (oldest first).
   * Synchronous wrapper returns empty — use getHeldTasksAsync for data.
   */
  getHeldTasks(): HeldTask[] {
    // Sync file reads in Node are blocking; return empty.
    // Callers that need data should use getHeldTasksAsync().
    return [];
  }

  /**
   * Async version of getHeldTasks.
   */
  async getHeldTasksAsync(): Promise<HeldTask[]> {
    const intakePath = join(this.atpPath, 'intake');
    const tasks: HeldTask[] = [];

    let files: string[];
    try {
      files = await readdir(intakePath);
    } catch {
      return tasks;
    }

    const heldFiles = files
      .filter((f) => f.startsWith('held-') && f.endsWith('.json'))
      .sort();

    for (const file of heldFiles) {
      try {
        const raw = await readFile(join(intakePath, file), 'utf-8');
        const parsed = JSON.parse(raw) as {
          held_at?: string;
          task_description?: string;
          status?: string;
        };
        tasks.push({
          file,
          held_at: parsed.held_at ?? 'unknown',
          task_description: parsed.task_description ?? '',
          status: parsed.status ?? 'unknown',
        });
      } catch {
        // Skip malformed files
      }
    }

    return tasks;
  }

  /**
   * Force reload of the dispatch table.
   * Useful after ATP protocol files are updated.
   */
  async reload(): Promise<void> {
    this.initialized = false;
    this.matcher = null;
    this.loader = null;
    await this.ensureInitialized();
  }
}
