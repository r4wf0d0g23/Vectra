/**
 * Vectra Configuration
 *
 * Central configuration for the Vectra harness. All tunables in one place.
 *
 * Instance-specific values (paths, channel IDs, model provider URLs) are NOT
 * defaulted here — they must be supplied via vectra.instance.json or environment
 * variables. This keeps the harness generic across deployments.
 *
 * Required env vars (when not using instance config):
 *   VECTRA_ATP_PATH        — path to the ATP instance directory
 *   VECTRA_CHECKPOINT_PATH — path to store checkpoints
 *   VECTRA_TELEMETRY_PATH  — path to write telemetry JSONL
 *   VECTRA_OPS_CHANNEL     — transport channel ID for ops escalations
 *   VECTRA_UPSTREAM_URL    — upstream LLM provider base URL
 *   VECTRA_INSTANCE        — path to vectra.instance.json (optional, overrides above)
 */

import type { ModelClass } from '../src/core/job.js';

// ─── Configuration Interface ────────────────────────────────────────

export interface VectraConfig {
  /** Path to the ATP instance directory. Required — no default. */
  atpInstancePath: string;

  /** Path to store checkpoints. Required — no default. */
  checkpointPath: string;

  /** Path to write telemetry JSONL. Required — no default. */
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

  /** Model class assignments (maps tier names to provider/model strings). */
  modelClassAssignments: Record<ModelClass, string>;

  /** Telemetry flush interval in milliseconds. */
  telemetryFlushIntervalMs: number;

  /** Captain-2 failover: missed heartbeat threshold before failover. */
  failoverMissedHeartbeats: number;

  /** Captain-2 failover: heartbeat interval in milliseconds. */
  heartbeatIntervalMs: number;

  /**
   * Ops channel for escalation notifications.
   * Format is transport-specific (e.g. 'agent:main:discord:channel:<id>').
   * Required — no default. Set via instance config or VECTRA_OPS_CHANNEL.
   */
  opsChannel: string;

  // ─── Transport Proxy ────────────────────────────────────────────

  /** Port Vectra's proxy listens on. OpenClaw's baseURL points here. */
  proxyPort: number;

  /**
   * Upstream model API base URL (the real LLM provider endpoint).
   * Required — no default. Set via instance config or VECTRA_UPSTREAM_URL.
   * Example: 'https://api.anthropic.com', 'https://api.openai.com'
   */
  upstreamBaseUrl: string;

  /**
   * OpenClaw gateway URL (for tool invocations via /tools/invoke).
   * Defaults to localhost — acceptable during build phase when Vectra
   * runs alongside OpenClaw on the same machine.
   */
  openclawGatewayUrl: string;

  /** OpenClaw gateway auth token (for tool invocations). */
  openclawGatewayToken: string;
}

// ─── Default Configuration ──────────────────────────────────────────

export const DEFAULT_CONFIG: VectraConfig = {
  // Paths: no absolute defaults — must be set per instance
  atpInstancePath: process.env['VECTRA_ATP_PATH'] ?? '',
  checkpointPath: process.env['VECTRA_CHECKPOINT_PATH'] ?? '',
  telemetryPath: process.env['VECTRA_TELEMETRY_PATH'] ?? '',

  autonomyLevel: 4,
  timeoutMultiplier: 3,
  maxRecursionDepth: 3,
  costCeilingUsd: 5.0,
  defaultModelClass: 'fast',

  // Model class assignments: sensible defaults but operator should override
  modelClassAssignments: {
    fast: 'xai/grok-4-1-fast',
    agent: 'openai/gpt-5.4-mini',
    balanced: 'anthropic/claude-sonnet-4-6',
    capable: 'anthropic/claude-opus-4-6',
  },

  telemetryFlushIntervalMs: 5000,
  failoverMissedHeartbeats: 3,
  heartbeatIntervalMs: 30_000,

  // Channel and transport: no defaults — instance-specific
  opsChannel: process.env['VECTRA_OPS_CHANNEL'] ?? '',

  proxyPort: 18800,

  // Upstream LLM provider: no default — set per instance
  upstreamBaseUrl: process.env['VECTRA_UPSTREAM_URL'] ?? '',

  // OpenClaw gateway: localhost is a reasonable default during build phase
  openclawGatewayUrl: process.env['VECTRA_OPENCLAW_URL'] ?? 'http://localhost:18789',
  openclawGatewayToken: process.env['VECTRA_OPENCLAW_TOKEN'] ?? '',
};

/**
 * Load configuration. Merges defaults with provided overrides.
 * In production, overrides come from vectra.instance.json loaded at boot.
 */
export function loadConfig(overrides?: Partial<VectraConfig>): VectraConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
