import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RouteBinding, RouteResolver } from './enforcement-controller.js';

type Route = { taskPattern: string; protocolId: string; varIds: string[]; priority: number };
type Snapshot = { routes: Route[]; loadedAt: string };

const READ_ONLY_TOOLS = new Set(['read', 'memory_get', 'memory_search', 'web_fetch', 'get_goal', 'session_status', 'sessions_list', 'sessions_history']);

function frontmatter(raw: string): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('ATP frontmatter missing');
  return match[1];
}

function scalar(block: string, key: string): string {
  const match = block.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
  if (!match) throw new Error(`ATP field missing: ${key}`);
  return match[1].trim();
}

function inlineArray(value: string): string[] {
  const match = value.match(/^\[(.*)\]$/);
  return match ? match[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
}

function list(block: string, key: string): string[] {
  const inline = block.match(new RegExp(`^${key}:\\s*(\\[[^\\n]*\\])`, 'm'));
  if (inline) return inlineArray(inline[1]);
  const start = block.match(new RegExp(`^${key}:\\s*$`, 'm'));
  if (!start || start.index === undefined) return [];
  return block.slice(start.index + start[0].length).split(/\r?\n/).map((line) => line.match(/^\s+-\s+["']?([^"'\n]+)["']?\s*$/)?.[1]).filter((v): v is string => Boolean(v));
}

function parseRoutes(raw: string): Route[] {
  const fm = frontmatter(raw);
  const routing = fm.match(/^routing:\s*\r?\n([\s\S]*?)(?=^[a-z][a-z0-9_-]*:|(?![\s\S]))/m)?.[1];
  if (!routing) throw new Error('ATP routing table missing');
  const chunks = routing.split(/^\s*-\s+task_pattern:\s*/m).slice(1);
  const routes = chunks.map((chunk) => {
    const firstLine = chunk.split(/\r?\n/, 1)[0].trim().replace(/^['"]|['"]$/g, '');
    const protocolId = chunk.match(/^\s+execution_protocol:\s*([a-z0-9-]+)\s*$/m)?.[1];
    const vars = chunk.match(/^\s+var_ids:\s*(\[[^\n]*\])\s*$/m)?.[1] ?? '[]';
    const priority = Number(chunk.match(/^\s+priority:\s*(\d+)\s*$/m)?.[1] ?? (firstLine === '*' ? 0 : 50));
    if (!protocolId) throw new Error('ATP route protocol missing');
    return { taskPattern: firstLine, protocolId, varIds: inlineArray(vars), priority };
  });
  if (!routes.length) throw new Error('ATP routing table empty');
  return routes;
}

function normalize(value: string): string { return value.toLowerCase().replace(/[^\w\s/-]/g, ' ').replace(/\s+/g, ' ').trim(); }
function matches(task: string, pattern: string): number {
  if (pattern === '*') return 0;
  const terms = pattern.toLowerCase().split(/\s*\/\s*/).filter(Boolean);
  return terms.filter((term) => term.split(/\s+/).every((word) => task.includes(word))).length;
}

/** Real ATP instance resolver with atomic last-known-good reload semantics. */
export class AtpProductionRouteResolver implements RouteResolver {
  private lastKnownGood: Snapshot | null = null;
  constructor(private readonly instancePath: string, private readonly validatorAdapters: Readonly<Record<string, string>>) {}

  private async reload(): Promise<Snapshot> {
    try {
      const raw = await readFile(join(this.instancePath, 'protocols', 'orchestration-main.md'), 'utf8');
      const candidate = { routes: parseRoutes(raw), loadedAt: new Date().toISOString() };
      this.lastKnownGood = candidate;
      return candidate;
    } catch (error) {
      if (this.lastKnownGood) return this.lastKnownGood;
      throw error;
    }
  }

  async resolve(task: string): Promise<RouteBinding> {
    const snapshot = await this.reload();
    const normalized = normalize(task);
    const candidates = snapshot.routes.map((route) => ({ route, score: matches(normalized, route.taskPattern) }))
      .filter(({ route, score }) => score > 0 || route.taskPattern === '*')
      .sort((a, b) => b.route.priority - a.route.priority || b.score - a.score);
    const specific = candidates.filter(({ route }) => route.taskPattern !== '*');
    if (specific.length > 1 && specific[0].route.priority === specific[1].route.priority && specific[0].score === specific[1].score) {
      return { kind: 'ambiguous', requiredVariables: [], toolImpacts: ['unknown'], allowReadOnlyDegradation: false };
    }
    const selected = specific[0] ?? candidates.find(({ route }) => route.taskPattern === '*');
    if (!selected) return { kind: 'none', requiredVariables: [], toolImpacts: ['unknown'], allowReadOnlyDegradation: false };

    const protocolRaw = await readFile(join(this.instancePath, 'protocols', `${selected.route.protocolId}.md`), 'utf8');
    const protocolFm = frontmatter(protocolRaw);
    const tools = list(protocolFm, 'tool_allowlist');
    const readOnly = tools.length > 0 && tools.every((tool) => READ_ONLY_TOOLS.has(tool));
    const requiredVariables = await Promise.all(selected.route.varIds.map(async (id) => {
      const raw = await readFile(join(this.instancePath, 'vars', `${id}.md`), 'utf8');
      const fm = frontmatter(raw);
      return { id, version: scalar(fm, 'version'), schemaVersion: '1.0.0', bytes: Buffer.from(raw), adapterId: this.validatorAdapters[id] };
    }));
    return {
      kind: 'single', protocolId: selected.route.protocolId, protocolVersion: scalar(protocolFm, 'version'), protocolSchemaVersion: '1.0.0',
      protocolBytes: Buffer.from(protocolRaw), requiredVariables,
      toolImpacts: readOnly ? ['read-only'] : tools.length ? tools.map(() => 'write-capable') : ['unknown'],
      allowReadOnlyDegradation: selected.route.protocolId === 'conversational' && readOnly,
    };
  }
}

export const receiptSha256 = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex');

/**
 * Provider interception cannot establish terminal lifecycle authority. This
 * contract must be implemented by the agent loop that owns tool execution and
 * terminal completion; Vectra intentionally ships no permissive placeholder.
 */
export interface AgentLifecycleAuthority {
  readonly terminalReceiptEnforcement: true;
  correlateProviderRequest(request: unknown): Promise<{ runId: string; terminalCandidate: boolean }>;
  verifyTerminalReceipt(runId: string): Promise<{ valid: boolean; receiptSha256?: string; reason?: string }>;
}
