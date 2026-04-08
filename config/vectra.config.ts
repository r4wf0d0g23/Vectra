/**
 * Vectra Configuration
 *
 * Central configuration for the Vectra harness. All tunables in one place.
 */

import type { ModelClass } from '../src/core/job.js';

// ─── Configuration Interface ────────────────────────────────────────

export interface VectraConfig {
  /** Path to the ATP instance directory. */
  atpInstancePath: string;

  /** Path to store checkpoints. */
  checkpointPath: string;

  /** Path to write telemetry JSONL. */
  telemetryPath: string;

  /** Autonomy level (4 = bounded autonomous, 5 = scheduled/event-driven). */
  autonomyLevel: 4 | 5;

  /**
   * Timeout multiplier applied to all protocol step durations.
   * Set to 3x as directed — gives operations generous time to complete.
   */
  timeoutMultiplier: number;

  /** Maximum sub-agent recursion depth before hard stop. */
  maxRecursionDepth: number;

  /** Maximum cost in USD for a single task chain before halt. */
  costCeilingUsd: number;

  /** Default model class for unspecified protocols. */
  defaultModelClass: ModelClass;

  /** Model class assignments (matches worker-config.md). */
  modelClassAssignments: Record<ModelClass, string>;

  /** Telemetry flush interval in milliseconds. */
  telemetryFlushIntervalMs: number;

  /** Captain-2 failover: missed heartbeat threshold before failover. */
  failoverMissedHeartbeats: number;

  /** Captain-2 failover: heartbeat interval in milliseconds. */
  heartbeatIntervalMs: number;

  /** Ops channel for escalation notifications. */
  opsChannel: string;
}

// ─── Default Configuration ──────────────────────────────────────────

export const DEFAULT_CONFIG: VectraConfig = {
  atpInstancePath: '/home/agent-raw/.openclaw/workspace/atp-instance',
  checkpointPath: '/home/agent-raw/.openclaw/workspace/vectra/checkpoints',
  telemetryPath: '/home/agent-raw/.openclaw/workspace/vectra/telemetry/events.jsonl',
  autonomyLevel: 4,
  timeoutMultiplier: 3,
  maxRecursionDepth: 3,
  costCeilingUsd: 5.0,
  defaultModelClass: 'fast',
  modelClassAssignments: {
    fast: 'xai/grok-4-1-fast',
    agent: 'openai/gpt-5.4-mini',
    balanced: 'anthropic/claude-sonnet-4-6',
    capable: 'anthropic/claude-opus-4-6',
  },
  telemetryFlushIntervalMs: 5000,
  failoverMissedHeartbeats: 3,
  heartbeatIntervalMs: 30_000,
  opsChannel: 'agent:main:discord:channel:1475311507418910843',
};

/**
 * Load configuration. Currently returns defaults.
 * Future: merge with a vectra.config.json file if present.
 */
export function loadConfig(overrides?: Partial<VectraConfig>): VectraConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
