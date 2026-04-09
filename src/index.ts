/**
 * Vectra Harness Entry Point — v0.3.0
 *
 * Initializes session persistence, model client, and transport.
 * Wires the message loop: inbound → session history → model call → response → outbound.
 */

import { SessionStore, defaultDbPath } from './session/store.js';
import { ContextWindowManager } from './session/context.js';
import { ModelClient } from './model/client.js';
import type { TransportConnector, InboundMessage } from './transport/interface.js';
import { loadConfig } from '../config/vectra.config.js';

// ─── Configuration ──────────────────────────────────────────────────

const config = loadConfig();

// Instance ID — from env or default
const INSTANCE_ID = process.env['VECTRA_INSTANCE_ID'] ?? 'default';

// Session database path — configurable via env, falls back to ~/.vectra/{instanceId}/sessions.db
const DB_PATH = process.env['VECTRA_SESSION_DB'] ?? defaultDbPath(INSTANCE_ID);

// Model configuration — API keys from env only
const MODEL_PROVIDER = process.env['VECTRA_MODEL_PROVIDER'] ?? 'openai';
const MODEL_NAME = process.env['VECTRA_MODEL_NAME'] ?? config.modelClassAssignments[config.defaultModelClass] ?? 'gpt-4o-mini';
const MODEL_API_KEY = process.env['VECTRA_MODEL_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '';
const MODEL_BASE_URL = process.env['VECTRA_MODEL_BASE_URL'] ?? undefined;

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
const modelClient = new ModelClient({
  provider: MODEL_PROVIDER,
  model: MODEL_NAME,
  apiKey: MODEL_API_KEY,
  baseUrl: MODEL_BASE_URL,
});

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
      const response = await modelClient.complete(messages);

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

// ─── Lifecycle ──────────────────────────────────────────────────────

/**
 * Graceful shutdown — close the session store.
 */
export function shutdown(): void {
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
export type { ModelResponse, ModelClientConfig } from './model/client.js';
