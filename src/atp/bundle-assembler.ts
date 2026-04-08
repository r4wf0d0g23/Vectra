/**
 * Vectra Bundle Assembler — builds context bundles from ATP var files.
 *
 * Loads var file contents based on their staleness policy:
 * - always-verify: run verify_cmd, use fresh output
 * - session-cache: load from file, cache for session duration
 * - ttl:Xd: load from file, respect TTL
 * - on-change-only: load from file, no refresh needed
 */

import type { AtpInstanceData, LoadedVar } from './loader.js';
import type { ContextSource } from '../core/context.js';

// ─── Staleness Resolution ───────────────────────────────────────────

export type FreshnessStrategy = 'jit' | 'session-cache' | 'ttl' | 'static';

function resolveFreshnessStrategy(policy: string): FreshnessStrategy {
  if (policy === 'always-verify') return 'jit';
  if (policy === 'session-cache') return 'session-cache';
  if (policy.startsWith('ttl:')) return 'ttl';
  return 'static';
}

// ─── Session Cache ──────────────────────────────────────────────────

const sessionCache = new Map<string, { content: string; loadedAt: number }>();

// ─── Assembler ──────────────────────────────────────────────────────

export class BundleAssembler {
  private data: AtpInstanceData;

  constructor(data: AtpInstanceData) {
    this.data = data;
  }

  /**
   * Assemble context sources for the given var IDs.
   * Returns ContextSource objects that can be passed to the ContextEngine.
   */
  assembleVarSources(varIds: string[]): ContextSource[] {
    const sources: ContextSource[] = [];

    for (const varId of varIds) {
      const loadedVar = this.data.vars.get(varId);
      if (!loadedVar) {
        process.stderr.write(
          `[vectra] Warning: var '${varId}' not found in ATP instance\n`
        );
        continue;
      }

      const strategy = resolveFreshnessStrategy(
        loadedVar.frontmatter.staleness_policy
      );

      sources.push(this.createVarSource(varId, loadedVar, strategy));
    }

    return sources;
  }

  /**
   * Clear the session cache. Call at session start or on explicit refresh.
   */
  clearCache(): void {
    sessionCache.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────

  private createVarSource(
    varId: string,
    loadedVar: LoadedVar,
    strategy: FreshnessStrategy
  ): ContextSource {
    return {
      id: `var-${varId}`,
      layer: 'working',
      estimatedTokens: Math.ceil(loadedVar.content.length / 4),
      async load(): Promise<string> {
        switch (strategy) {
          case 'session-cache': {
            const cached = sessionCache.get(varId);
            if (cached) return cached.content;
            sessionCache.set(varId, {
              content: loadedVar.content,
              loadedAt: Date.now(),
            });
            return loadedVar.content;
          }
          case 'ttl': {
            // For TTL vars, use cached content (loader handles refresh via file watcher)
            return loadedVar.content;
          }
          case 'jit': {
            // JIT vars should ideally run verify_cmd, but that requires exec.
            // For now, return file content with a freshness warning.
            return `<!-- JIT: verify_cmd not yet wired -->\n${loadedVar.content}`;
          }
          case 'static':
          default:
            return loadedVar.content;
        }
      },
    };
  }
}
