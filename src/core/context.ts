/**
 * Vectra Context Composition Engine
 *
 * Context is a first-class subsystem. The harness decides what context
 * the model sees — the model never selects its own context.
 *
 * Five layers:
 *   1. Static — protocol definition, guardrails, role prompt
 *   2. Task — task description, objectives, constraints
 *   3. Working — var file contents (JIT loaded or session-cached)
 *   4. Persistent — checkpoints from prior attempts, job history
 *   5. Retrieval — memory search results, web fetch results
 */

import type { ContextLayers, JobEnvelope } from './job.js';

// ─── Context Source ─────────────────────────────────────────────────

/** A provider that can contribute content to a context layer. */
export interface ContextSource {
  /** Unique identifier for this source. */
  id: string;
  /** Which layer this source contributes to. */
  layer: keyof ContextLayers;
  /** Estimated token count (for budget tracking). */
  estimatedTokens: number;
  /** Load the content. Returns the string to inject. */
  load(): Promise<string>;
}

// ─── Context Budget ─────────────────────────────────────────────────

export interface ContextBudget {
  /** Maximum total tokens across all layers. */
  maxTotalTokens: number;
  /** Per-layer token limits. */
  layerLimits: Record<keyof ContextLayers, number>;
}

/** Default budget: conservative for orchestration, generous for execution. */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTotalTokens: 32_000,
  layerLimits: {
    static: 8_000,
    task: 4_000,
    working: 12_000,
    persistent: 4_000,
    retrieval: 4_000,
  },
};

// ─── Composition Result ─────────────────────────────────────────────

export interface CompositionResult {
  layers: ContextLayers;
  totalEstimatedTokens: number;
  truncated: boolean;
  truncationDetails: string[];
}

// ─── Context Engine ─────────────────────────────────────────────────

export class ContextEngine {
  private budget: ContextBudget;

  constructor(budget: ContextBudget = DEFAULT_CONTEXT_BUDGET) {
    this.budget = budget;
  }

  /**
   * Compose context layers for a job from registered sources.
   *
   * Sources are loaded in layer order (static first, retrieval last).
   * If a layer exceeds its budget, later sources in that layer are truncated.
   * If total exceeds budget, retrieval is truncated first, then persistent.
   */
  async compose(
    job: JobEnvelope,
    sources: ContextSource[]
  ): Promise<CompositionResult> {
    const layers: ContextLayers = {
      static: [],
      task: [],
      working: [],
      persistent: [],
      retrieval: [],
    };

    let totalTokens = 0;
    const truncationDetails: string[] = [];
    const layerOrder: (keyof ContextLayers)[] = [
      'static',
      'task',
      'working',
      'persistent',
      'retrieval',
    ];

    // Group sources by layer
    const byLayer = new Map<keyof ContextLayers, ContextSource[]>();
    for (const layer of layerOrder) {
      byLayer.set(layer, []);
    }
    for (const source of sources) {
      const group = byLayer.get(source.layer);
      if (group) {
        group.push(source);
      }
    }

    // Load each layer within budget
    for (const layer of layerOrder) {
      const layerSources = byLayer.get(layer) ?? [];
      const layerLimit = this.budget.layerLimits[layer];
      let layerTokens = 0;

      for (const source of layerSources) {
        if (layerTokens + source.estimatedTokens > layerLimit) {
          truncationDetails.push(
            `${layer}/${source.id}: skipped (would exceed layer budget: ${layerTokens}/${layerLimit})`
          );
          continue;
        }

        if (totalTokens + source.estimatedTokens > this.budget.maxTotalTokens) {
          truncationDetails.push(
            `${layer}/${source.id}: skipped (would exceed total budget: ${totalTokens}/${this.budget.maxTotalTokens})`
          );
          continue;
        }

        try {
          const content = await source.load();
          layers[layer].push(content);
          layerTokens += source.estimatedTokens;
          totalTokens += source.estimatedTokens;
        } catch (err) {
          truncationDetails.push(
            `${layer}/${source.id}: load failed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    return {
      layers,
      totalEstimatedTokens: totalTokens,
      truncated: truncationDetails.length > 0,
      truncationDetails,
    };
  }

  /**
   * Create context sources for a job's static layer from protocol data.
   */
  static protocolSources(
    protocolContent: string,
    guardrails: string[]
  ): ContextSource[] {
    const sources: ContextSource[] = [];

    sources.push({
      id: 'protocol-definition',
      layer: 'static',
      estimatedTokens: Math.ceil(protocolContent.length / 4),
      async load() {
        return protocolContent;
      },
    });

    if (guardrails.length > 0) {
      const guardrailText = guardrails.map((g, i) => `${i + 1}. ${g}`).join('\n');
      sources.push({
        id: 'guardrails',
        layer: 'static',
        estimatedTokens: Math.ceil(guardrailText.length / 4),
        async load() {
          return `## Guardrails\n${guardrailText}`;
        },
      });
    }

    return sources;
  }

  /**
   * Create a context source for a var file.
   */
  static varSource(varId: string, content: string): ContextSource {
    return {
      id: `var-${varId}`,
      layer: 'working',
      estimatedTokens: Math.ceil(content.length / 4),
      async load() {
        return content;
      },
    };
  }
}
