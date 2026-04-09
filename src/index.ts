/**
 * Vectra Harness Entry Point — v0.4.0
 *
 * Initializes session persistence, model client, transport, and scheduler.
 * Wires the message loop: inbound → session history → model call → response → outbound.
 * Scheduler injects cron/heartbeat messages with senderTrust: 'cron'.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig(); // loads .env from cwd automatically

// ─── Startup Sanity Checks ──────────────────────────────────────────

// Warn if .env missing — common new user mistake
if (!existsSync(resolve(process.cwd(), '.env'))) {
  process.stderr.write('[vectra] Warning: no .env file found in current directory. Run vectra init to create one.\n');
}
import { SessionStore, defaultDbPath } from './session/store.js';
import { ContextWindowManager } from './session/context.js';
import { ModelClient, type ProviderConfig } from './model/client.js';
import { Scheduler, type CronJobSpec, type HeartbeatSpec } from './scheduler/index.js';
import type { TransportConnector, InboundMessage } from './transport/interface.js';
import { loadConfig } from '../config/vectra.config.js';
import { MemoryLoader } from './memory/loader.js';
import { processWriteBlocks } from './tools/file-writer.js';

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
    const files = readdirSync(instancesDir)
      .map(f => f.trim())
      .filter(f => f.endsWith('.instance.json'));
    if (files.length === 1) {
      const p = resolve(instancesDir, files[0]!).trimEnd();
      process.stderr.write(`[vectra] Auto-discovered instance: ${JSON.stringify(p)}\n`);
      return p;
    }
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

// Check DISCORD_BOT_TOKEN if transport is discord
const _transportType = (_bootInstance as { transport?: { type?: string } }).transport?.type;
if (_transportType === 'discord' && !process.env['DISCORD_BOT_TOKEN']) {
  process.stderr.write('[vectra] Error: DISCORD_BOT_TOKEN is not set. Add it to your .env file.\n');
  process.exit(1);
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

// System prompt — fallback when persona files are empty
const SYSTEM_PROMPT_FALLBACK = process.env['VECTRA_SYSTEM_PROMPT'] ??
  (_bootInstance as { systemPrompt?: string }).systemPrompt ??
  'You are a helpful assistant. Be concise and direct.';

// ATP instance path — needed for persona files and memory loader
const ATP_PATH = (() => {
  const fromInstance = (_bootInstance as { atpPath?: string }).atpPath;
  if (fromInstance) return resolve(fromInstance);
  // Default: atp-instances/{instanceId}
  return resolve('atp-instances', INSTANCE_ID);
})();

// Write protocol instructions appended to system prompt
const WRITE_PROTOCOL_SUFFIX = `

To update your memory files, include a write block BEFORE your response:
[VECTRA_WRITE:USER.md]
# USER.md — About Your User
[updated content]
[/VECTRA_WRITE]

Only use write blocks when you learn something genuinely new worth remembering.
Available files: SOUL.md (your identity), USER.md (about your user), AGENTS.md (operational rules).`;

// ─── Core Components ────────────────────────────────────────────────

const store = new SessionStore(DB_PATH);
const contextMgr = new ContextWindowManager(store, SOFT_THRESHOLD, HARD_LIMIT);
// Build ModelClient with per-provider config from instance JSON
const modelClient = new ModelClient(
  _bootInstance.providers ?? {},
  MODEL_NAME,
);
// Memory loader — hot-reloads persona files on every message
const memoryLoader = new MemoryLoader(
  ATP_PATH,
  resolve(process.cwd()),
  {
    timeWindowDays: 2,
    maxTokens: 8000,
    sources: ['SOUL.md', 'IDENTITY.md', 'USER.md'],
    mainSessionOnly: ['MEMORY.md'],
  },
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

      // Hot-reload persona files and assemble system prompt
      const isMainSession = true; // TODO: detect shared vs main session from transport metadata
      let systemPrompt: string;
      try {
        const memCtx = await memoryLoader.load(sessionId, isMainSession);
        systemPrompt = memCtx.systemPrompt || SYSTEM_PROMPT_FALLBACK;
      } catch {
        systemPrompt = SYSTEM_PROMPT_FALLBACK;
      }
      // Append write protocol instructions
      systemPrompt += WRITE_PROTOCOL_SUFFIX;

      // Build context window
      const messages = contextMgr.buildContext(sessionId, systemPrompt, message.text);

      // Call model
      const response = await modelClient.complete(MODEL_NAME, messages);

      // Process write blocks — extract persona file updates, strip from visible response
      const cleanedResponse = processWriteBlocks(ATP_PATH, response.content);

      // Append assistant response (cleaned version)
      const assistantTokens = response.tokenUsage.completion || contextMgr.estimateTokens(cleanedResponse);
      store.append({
        id: crypto.randomUUID(),
        sessionId,
        role: 'assistant',
        content: cleanedResponse,
        timestamp: new Date(),
        tokenCount: assistantTokens,
      });

      // Update session total tokens
      store.update(sessionId, {
        totalTokens: response.tokenUsage.total,
      });

      // Send response via transport (user never sees write blocks)
      await transport.send({
        channelId: message.channelId,
        text: cleanedResponse,
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
