/**
 * Vectra Harness Entry Point — v0.4.0
 *
 * Initializes session persistence, model client, transport, and scheduler.
 * Wires the message loop: inbound → session history → model call → response → outbound.
 * Scheduler injects cron/heartbeat messages with senderTrust: 'cron'.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionStore, defaultDbPath } from './session/store.js';
import { ContextWindowManager } from './session/context.js';
import { ModelClient, type ProviderConfig } from './model/client.js';
import { Scheduler, type CronJobSpec, type HeartbeatSpec } from './scheduler/index.js';
import type { TransportConnector, InboundMessage } from './transport/interface.js';
import { loadConfig } from '../config/vectra.config.js';

// ─── Configuration ──────────────────────────────────────────────────

const config = loadConfig();

// Instance ID — from env or default
const INSTANCE_ID = process.env['VECTRA_INSTANCE_ID'] ?? 'default';

// Session database path — configurable via env, falls back to ~/.vectra/{instanceId}/sessions.db
const DB_PATH = process.env['VECTRA_SESSION_DB'] ?? defaultDbPath(INSTANCE_ID);

// Load instance JSON early (used for providers and scheduler config)
// Auto-discover instance: VECTRA_INSTANCE env > single file in instances/ > error
import { readdirSync } from 'node:fs';
function resolveInstancePath(): string {
  if (process.env['VECTRA_INSTANCE']) return process.env['VECTRA_INSTANCE'];
  const instancesDir = resolve(process.cwd(), 'instances');
  try {
    const files = readdirSync(instancesDir).map(f => f.trim()).filter(f => f.endsWith('.instance.json'));
    if (files.length === 1) return resolve(instancesDir, files[0]!);
    if (files.length > 1) {
      console.error(`[Vectra] Multiple instances found. Set VECTRA_INSTANCE env var to specify one:\n  ${files.join('\n  ')}`);
      process.exit(1);
    }
  } catch { /* instances dir missing */ }
  console.error('[Vectra] No instance config found. Run: vectra init');
  process.exit(1);
}
const _INSTANCE_PATH = resolveInstancePath();

interface _BootInstanceShape {
  models?: { mainAgent?: string };
  providers?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

let _bootInstance: _BootInstanceShape = {};
try {
  _bootInstance = JSON.parse(readFileSync(_INSTANCE_PATH, 'utf-8')) as _BootInstanceShape;
} catch (e) {
  process.stderr.write(`[vectra] Could not load instance config from ${_INSTANCE_PATH}\n`);
  process.stderr.write(`[vectra] Parse error: ${e}\n`);
}

// Model name — env var overrides instance config, falls back to config default
const MODEL_NAME = process.env['VECTRA_MODEL_NAME']
  ?? _bootInstance.models?.mainAgent
  ?? config.modelClassAssignments[config.defaultModelClass]
  ?? 'anthropic/claude-sonnet-4-6';

// Context window settings
const SOFT_THRESHOLD = Number(process.env['VECTRA_CONTEXT_SOFT_THRESHOLD'] ?? '80000');
const HARD_LIMIT = Number(process.env['VECTRA_CONTEXT_HARD_LIMIT'] ?? '120000');
const COMPACTION_KEEP_LAST = Number(process.env['VECTRA_COMPACTION_KEEP_LAST'] ?? '20');

// System prompt
const SYSTEM_PROMPT = process.env['VECTRA_SYSTEM_PROMPT'] ??
  'You are a helpful assistant. Be concise and direct.';

// ─── Core Components ────────────────────────────────────────────────

const store = new SessionStore(DB_PATH);
const contextMgr = new ContextWindowManager(store, SOFT_THRESHOLD, HARD_LIMIT);
// Build ModelClient with per-provider config from instance JSON
const modelClient = new ModelClient(
  _bootInstance.providers ?? {},
  MODEL_NAME,
);

// ─── Message Handler ────────────────────────────────────────────────

/**
 * Wire message handling onto a transport connector.
 * This is the core loop: receive message → build context → call model → respond.
 */
export function wireMessageHandler(transport: TransportConnector): void {
  transport.onMessage(async (message: InboundMessage) => {
    const sessionId = `${message.channelId}:${message.senderId}`;

    try {
      // Ensure session exists
      store.getOrCreate(sessionId, INSTANCE_ID);

      // Append user message
      const userTokens = contextMgr.estimateTokens(message.text);
      store.append({
        id: crypto.randomUUID(),
        sessionId,
        role: 'user',
        content: message.text,
        timestamp: new Date(),
        tokenCount: userTokens,
      });

      // Check if compaction is needed before building context
      if (contextMgr.needsCompaction(sessionId)) {
        await contextMgr.compact(sessionId, modelClient, COMPACTION_KEEP_LAST);
      }

      // Build context window
      const messages = contextMgr.buildContext(sessionId, SYSTEM_PROMPT, message.text);

      // Call model
      const response = await modelClient.complete(MODEL_NAME, messages);

      // Append assistant response
      const assistantTokens = response.tokenUsage.completion || contextMgr.estimateTokens(response.content);
      store.append({
        id: crypto.randomUUID(),
        sessionId,
        role: 'assistant',
        content: response.content,
        timestamp: new Date(),
        tokenCount: assistantTokens,
      });

      // Update session total tokens
      store.update(sessionId, {
        totalTokens: response.tokenUsage.total,
      });

      // Send response via transport
      await transport.send({
        channelId: message.channelId,
        text: response.content,
        replyToId: message.id,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        JSON.stringify({
          type: 'vectra.message_handler_error',
          sessionId,
          error: errMsg,
          timestamp: new Date().toISOString(),
        }) + '\n'
      );

      // Send error response to user
      await transport.send({
        channelId: message.channelId,
        text: `⚠️ Error processing message: ${errMsg}`,
        replyToId: message.id,
      });
    }
  });
}

// ─── Scheduler ──────────────────────────────────────────────────────

interface InstanceSchedulerConfig {
  heartbeat?: {
    intervalMs: number;
    prompt: string;
    channelId: string;
    model: string;
    quietHoursStart?: number;
    quietHoursEnd?: number;
  };
  cronJobs?: Array<{
    id: string;
    schedule: string;
    task: string;
    channelId: string;
    model?: string;
    enabled: boolean;
  }>;
}

interface InstanceConfig {
  scheduler?: InstanceSchedulerConfig;
  [key: string]: unknown;
}

let scheduler: Scheduler | null = null;

/**
 * Initialize the scheduler from instance config.
 * Call after core components are ready.
 */
export function initScheduler(): void {
  // Reuse the boot instance JSON already loaded at module startup
  const instanceConfig: InstanceConfig = _bootInstance;
  if (Object.keys(instanceConfig).length === 0) {
    process.stderr.write(`[vectra-scheduler] Could not load instance config from ${_INSTANCE_PATH}\n`);
    return;
  }

  const schedulerConfig = instanceConfig.scheduler;
  if (!schedulerConfig) {
    process.stderr.write('[vectra-scheduler] No scheduler config found — disabled\n');
    return;
  }

  const cronJobs: CronJobSpec[] = (schedulerConfig.cronJobs ?? []).map((j) => ({
    id: j.id,
    schedule: j.schedule,
    task: j.task,
    channelId: j.channelId,
    model: j.model,
    enabled: j.enabled,
  }));

  const heartbeat: HeartbeatSpec | undefined = schedulerConfig.heartbeat
    ? { ...schedulerConfig.heartbeat }
    : undefined;

  scheduler = new Scheduler(cronJobs, heartbeat);

  // Wire the cron message handler — injects with senderTrust: 'cron'
  scheduler.onCronMessage(async (channelId: string, text: string, role: 'cron') => {
    process.stderr.write(`[vectra-cron] Injecting ${role} message to channel ${channelId}\n`);

    const gatewayUrl = config.openclawGatewayUrl;
    const gatewayToken = config.openclawGatewayToken;

    if (!gatewayUrl || !gatewayToken) {
      process.stderr.write('[vectra-cron] Cannot inject — gateway URL or token not configured\n');
      return;
    }

    try {
      const response = await fetch(`${gatewayUrl}/tools/invoke`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gatewayToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'sessions_send',
          args: {
            sessionKey: `agent:main:discord:channel:${channelId}`,
            message: text,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        process.stderr.write(`[vectra-cron] Gateway ${response.status}: ${body}\n`);
      }
    } catch (err) {
      process.stderr.write(`[vectra-cron] Inject failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  });

  scheduler.start();
  process.stderr.write(`[vectra-scheduler] Started (${cronJobs.length} cron jobs, heartbeat: ${heartbeat ? 'on' : 'off'})\n`);
}

// ─── Lifecycle ──────────────────────────────────────────────────────

/**
 * Graceful shutdown — stop scheduler and close the session store.
 */
export function shutdown(): void {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
  store.close();
  process.stderr.write(
    JSON.stringify({
      type: 'vectra.shutdown',
      timestamp: new Date().toISOString(),
    }) + '\n'
  );
}

// Register shutdown handlers
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

// ─── Exports ────────────────────────────────────────────────────────

export { store, contextMgr, modelClient, config };
export { SessionStore, defaultDbPath } from './session/store.js';
export { ContextWindowManager } from './session/context.js';
export { ModelClient } from './model/client.js';
export type { Message, Session } from './session/store.js';
export type { ModelResponse, ModelClientConfig, ProviderConfig } from './model/client.js';
export { Scheduler } from './scheduler/index.js';
export type { CronJobSpec, HeartbeatSpec } from './scheduler/index.js';
