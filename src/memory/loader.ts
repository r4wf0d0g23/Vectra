/**
 * Vectra Memory Layer — ATP-native memory/context preloader.
 *
 * Loads ATP vars and daily memory files to preload context before each
 * model call. Replaces OpenClaw's QMD memory search with a simpler,
 * ATP-native approach.
 *
 * Sources are resolved from the workspace directory:
 * - Daily logs: memory/YYYY-MM-DD.md (today + yesterday)
 * - Long-term memory: MEMORY.md (main session only — never in shared contexts)
 * - Crew state: ATP var file content
 * - Intake queue: held tasks from atp-instance/intake/
 * - Static context: SOUL.md, IDENTITY.md, USER.md
 *
 * GUARDRAIL: isMainSession gates MEMORY.md and any mainSessionOnly sources.
 * Shared/group contexts never see personal long-term memory.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────

export interface MemoryContext {
  /** Assembled from static + memory sources. */
  systemPrompt: string;
  /** Policies, role, SOUL.md equivalent. */
  staticContext: string;
  /** Daily logs, MEMORY.md (main session only). */
  memoryContext: string;
  /** Crew-state var content. */
  crewState: string;
  /** Held tasks from atp-instance/intake/. */
  intakeQueue: string[];
}

export interface MemoryLoaderConfig {
  /** How many days back to load daily logs (today + N-1 previous). */
  timeWindowDays: number;
  /** Maximum tokens for the assembled system prompt. */
  maxTokens: number;
  /** Source files to load (relative to workspace). */
  sources: string[];
  /** Sources only loaded in non-shared (main session) contexts. */
  mainSessionOnly: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Read a file, returning empty string on any error. */
async function safeReadFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

/** Format a date as YYYY-MM-DD. */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── Memory Loader ──────────────────────────────────────────────────

export class MemoryLoader {
  private atpPath: string;
  private workspacePath: string;
  private contextVar: MemoryLoaderConfig;

  constructor(
    atpPath: string,
    workspacePath: string,
    contextVar: MemoryLoaderConfig,
  ) {
    this.atpPath = atpPath;
    this.workspacePath = workspacePath;
    this.contextVar = contextVar;
  }

  /**
   * Load full memory context for a session.
   *
   * @param _sessionId - Session identifier (reserved for future per-session caching).
   * @param isMainSession - If false, MEMORY.md and mainSessionOnly sources are excluded.
   */
  async load(_sessionId: string, isMainSession: boolean): Promise<MemoryContext> {
    // Load all parts concurrently
    const [staticCtx, dailyLogs, longTermMemory, crewState, intakeQueue] =
      await Promise.all([
        this.loadStaticContext(isMainSession),
        this.loadDailyLogs(),
        isMainSession ? this.loadLongTermMemory() : Promise.resolve(''),
        this.loadCrewState(),
        this.loadIntakeQueue(),
      ]);

    // Assemble memory context from daily + long-term
    const memoryParts: string[] = [];
    if (dailyLogs) memoryParts.push(dailyLogs);
    if (longTermMemory) memoryParts.push(longTermMemory);
    const memoryContext = memoryParts.join('\n\n---\n\n');

    // Build system prompt within token budget
    const allParts: string[] = [];
    if (staticCtx) allParts.push(staticCtx);
    if (memoryContext) allParts.push(memoryContext);
    if (crewState) allParts.push(`## Crew State\n${crewState}`);
    if (intakeQueue.length > 0) {
      allParts.push(
        `## Intake Queue (${intakeQueue.length} held tasks)\n` +
          intakeQueue.map((t, i) => `${i + 1}. ${t}`).join('\n'),
      );
    }

    const systemPrompt = this.assembleSystemPrompt(
      allParts,
      this.contextVar.maxTokens,
    );

    return {
      systemPrompt,
      staticContext: staticCtx,
      memoryContext,
      crewState,
      intakeQueue,
    };
  }

  // ── Private Loaders ─────────────────────────────────────────────

  /**
   * Load static context sources (SOUL.md, IDENTITY.md, USER.md, etc).
   * Respects mainSessionOnly gating.
   */
  private async loadStaticContext(isMainSession: boolean): Promise<string> {
    const parts: string[] = [];

    for (const source of this.contextVar.sources) {
      // Skip main-session-only sources in shared contexts
      if (
        !isMainSession &&
        this.contextVar.mainSessionOnly.includes(source)
      ) {
        continue;
      }

      const content = await safeReadFile(
        join(this.workspacePath, source),
      );
      if (content) {
        parts.push(content.trim());
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * Load today's + recent daily memory files.
   * Loads timeWindowDays worth of files (today + previous days).
   */
  private async loadDailyLogs(): Promise<string> {
    const parts: string[] = [];
    const now = new Date();

    for (let i = 0; i < this.contextVar.timeWindowDays; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const filename = `${formatDate(date)}.md`;
      const filePath = join(this.workspacePath, 'memory', filename);

      const content = await safeReadFile(filePath);
      if (content) {
        parts.push(`## Daily Log: ${formatDate(date)}\n${content.trim()}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Load crew-state var from ATP instance.
   */
  private async loadCrewState(): Promise<string> {
    const varPath = join(this.atpPath, 'vars', 'crew-state.md');
    return safeReadFile(varPath);
  }

  /**
   * Load intake queue — held tasks from atp-instance/intake/.
   * Returns task descriptions from held JSON files.
   */
  private async loadIntakeQueue(): Promise<string[]> {
    const intakePath = join(this.atpPath, 'intake');
    const tasks: string[] = [];

    let files: string[];
    try {
      files = await readdir(intakePath);
    } catch {
      return tasks;
    }

    const heldFiles = files
      .filter((f) => f.startsWith('held-') && f.endsWith('.json'))
      .sort(); // chronological by timestamp in filename

    for (const file of heldFiles) {
      try {
        const raw = await readFile(join(intakePath, file), 'utf-8');
        const parsed = JSON.parse(raw) as {
          task_description?: string;
          status?: string;
        };
        if (parsed.status !== 'resolved' && parsed.task_description) {
          tasks.push(parsed.task_description);
        }
      } catch {
        // Skip malformed held files
      }
    }

    return tasks;
  }

  /**
   * Load MEMORY.md — long-term curated memory.
   * GUARDRAIL: Only called when isMainSession is true.
   */
  private async loadLongTermMemory(): Promise<string> {
    const content = await safeReadFile(
      join(this.workspacePath, 'MEMORY.md'),
    );
    if (content) {
      return `## Long-Term Memory\n${content.trim()}`;
    }
    return '';
  }

  /**
   * Assemble system prompt from all sources within token budget.
   * Truncates from the end if total exceeds maxTokens.
   */
  private assembleSystemPrompt(parts: string[], maxTokens: number): string {
    const assembled: string[] = [];
    let totalTokens = 0;

    for (const part of parts) {
      const partTokens = estimateTokens(part);

      if (totalTokens + partTokens <= maxTokens) {
        assembled.push(part);
        totalTokens += partTokens;
      } else {
        // Fit as much of this part as possible
        const remainingTokens = maxTokens - totalTokens;
        if (remainingTokens > 100) {
          // Only truncate if we can fit something meaningful
          const charBudget = remainingTokens * 4;
          assembled.push(
            part.slice(0, charBudget) + '\n\n[... truncated to fit token budget]',
          );
        }
        break;
      }
    }

    return assembled.join('\n\n---\n\n');
  }
}
