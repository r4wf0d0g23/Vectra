/**
 * Vectra ATP Loader — loads and hot-reloads ATP instance data.
 *
 * Reads protocol files and var files from the ATP instance directory.
 * Watches for file changes and reloads affected data. Provides typed
 * access to protocol routing tables, var contents, and metadata.
 */

import { readFile, readdir, watch } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Protocol Frontmatter ───────────────────────────────────────────

export interface ProtocolFrontmatter {
  id: string;
  name: string;
  version: string;
  status: 'active' | 'draft' | 'deprecated';
  classification: string;
  triggers: string[];
  priority?: number;
  preload_size_class?: string;
  requires?: {
    vars?: Array<{ id: string; staleness_policy: string }>;
    docs?: Array<{ url: string; section?: string }>;
  };
  routing?: RoutingEntry[];
  guardrails?: string[];
  escalation?: string[];
  post_update?: string[];
  checkpoint_policy?: {
    on_partial: string;
    clean_state_definition: string;
    rollback: string;
  };
  tool_allowlist?: string[];
}

export interface RoutingEntry {
  task_pattern: string;
  execution_protocol: string;
  var_ids: string[];
  model_class: string;
  tool_allowlist?: string[];
  artifacts_path?: string;
  priority?: number;
}

// ─── Var Frontmatter ────────────────────────────────────────────────

export interface VarFrontmatter {
  id: string;
  name: string;
  version: string;
  status: string;
  classification: string;
  validator: string;
  staleness_policy: string;
  verify_cmd?: string;
  source: string;
}

// ─── Loaded Data ────────────────────────────────────────────────────

export interface LoadedProtocol {
  frontmatter: ProtocolFrontmatter;
  content: string;
  filePath: string;
}

export interface LoadedVar {
  frontmatter: VarFrontmatter;
  content: string;
  filePath: string;
}

export interface AtpInstanceData {
  protocols: Map<string, LoadedProtocol>;
  vars: Map<string, LoadedVar>;
  /** The orchestration-main routing table (most-used, cached separately). */
  routingTable: RoutingEntry[];
}

// ─── YAML Frontmatter Parser ────────────────────────────────────────

/**
 * Simple YAML-like frontmatter parser.
 * Handles the subset used in ATP files (key: value, arrays, nested objects).
 * Not a full YAML parser — just enough for ATP frontmatter.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, content: raw };
  }

  const yamlBlock = match[1];
  const content = match[2];
  const result: Record<string, unknown> = {};

  // Simple line-by-line parsing for flat key: value pairs
  const lines = yamlBlock.split('\n');
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    // Array item
    const arrayMatch = line.match(/^\s+-\s+(.+)/);
    if (arrayMatch && currentKey && currentArray) {
      let val: unknown = arrayMatch[1].trim();
      // Remove quotes
      if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      currentArray.push(val);
      continue;
    }

    // Key: value
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1];
      const rawVal = kvMatch[2].trim();

      if (rawVal === '' || rawVal === '|') {
        // Start of array or multiline
        currentKey = key;
        currentArray = [];
        result[key] = currentArray;
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        // Inline array
        const items = rawVal.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        result[key] = items;
        currentKey = null;
        currentArray = null;
      } else {
        // Simple value
        let val: unknown = rawVal;
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (typeof val === 'string' && /^\d+$/.test(val)) val = parseInt(val, 10);
        else if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        result[key] = val;
        currentKey = key;
        currentArray = null;
      }
    }
  }

  return { frontmatter: result, content };
}

// ─── Loader ─────────────────────────────────────────────────────────

export class AtpLoader {
  private instancePath: string;
  private data: AtpInstanceData;
  private watchers: AbortController[] = [];

  constructor(instancePath: string) {
    this.instancePath = instancePath;
    this.data = {
      protocols: new Map(),
      vars: new Map(),
      routingTable: [],
    };
  }

  /**
   * Load all protocols and vars from the instance directory.
   */
  async load(): Promise<AtpInstanceData> {
    await this.loadProtocols();
    await this.loadVars();
    this.extractRoutingTable();
    return this.data;
  }

  /**
   * Get the current loaded data.
   */
  getData(): AtpInstanceData {
    return this.data;
  }

  /**
   * Start watching for file changes and hot-reload.
   */
  async startWatching(): Promise<void> {
    const dirs = [
      join(this.instancePath, 'protocols'),
      join(this.instancePath, 'vars'),
    ];

    for (const dir of dirs) {
      const ac = new AbortController();
      this.watchers.push(ac);

      // Node 20+ async file watching
      void (async () => {
        try {
          const watcher = watch(dir, { signal: ac.signal });
          for await (const event of watcher) {
            if (event.filename?.endsWith('.md')) {
              // Reload the changed directory
              if (dir.endsWith('protocols')) {
                await this.loadProtocols();
                this.extractRoutingTable();
              } else {
                await this.loadVars();
              }
            }
          }
        } catch (err) {
          // AbortError is expected on stop
          if ((err as NodeJS.ErrnoException).name !== 'AbortError') {
            process.stderr.write(
              `[vectra] ATP watcher error for ${dir}: ${err}\n`
            );
          }
        }
      })();
    }
  }

  /**
   * Stop watching for changes.
   */
  stopWatching(): void {
    for (const ac of this.watchers) {
      ac.abort();
    }
    this.watchers = [];
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async loadProtocols(): Promise<void> {
    const protocolDir = join(this.instancePath, 'protocols');
    let files: string[];
    try {
      files = await readdir(protocolDir);
    } catch {
      return;
    }

    for (const file of files.filter((f) => f.endsWith('.md'))) {
      const filePath = join(protocolDir, file);
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter, content } = parseFrontmatter(raw);

      if (frontmatter.id) {
        this.data.protocols.set(frontmatter.id as string, {
          frontmatter: frontmatter as unknown as ProtocolFrontmatter,
          content,
          filePath,
        });
      }
    }
  }

  private async loadVars(): Promise<void> {
    const varDir = join(this.instancePath, 'vars');
    let files: string[];
    try {
      files = await readdir(varDir);
    } catch {
      return;
    }

    for (const file of files.filter((f) => f.endsWith('.md'))) {
      const filePath = join(varDir, file);
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter, content } = parseFrontmatter(raw);

      if (frontmatter.id) {
        this.data.vars.set(frontmatter.id as string, {
          frontmatter: frontmatter as unknown as VarFrontmatter,
          content,
          filePath,
        });
      }
    }
  }

  private extractRoutingTable(): void {
    const orchMain = this.data.protocols.get('orchestration-main');
    if (orchMain?.frontmatter.routing) {
      this.data.routingTable = orchMain.frontmatter.routing;
    }
  }
}
