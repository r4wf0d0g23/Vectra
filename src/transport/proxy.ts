/**
 * Vectra Transport Proxy
 *
 * HTTP reverse proxy that sits between OpenClaw's gateway and the upstream
 * model API. This is Vectra's integration point — OpenClaw sends model
 * requests here, Vectra applies its gate/dispatch/context pipeline, then
 * forwards the enriched request to the actual LLM provider.
 *
 * Architecture:
 *   OpenClaw gateway → Vectra proxy (this) → Upstream model API
 *
 * OpenClaw is configured with `agents.defaults.baseURL` pointing at
 * Vectra's proxy port. Vectra is NOT an OpenClaw plugin — it is a
 * standalone process that intercepts the model API path.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { VectraConfig } from '../../config/vectra.config.js';
import type { IntakeGate } from '../gates/intake.js';
import type { Dispatcher } from '../core/dispatcher.js';
import type { ContextEngine } from '../core/context.js';
import type { ReceiptGate } from '../gates/receipt.js';
import type { TelemetryEmitter } from '../telemetry/emitter.js';
import type { AtpDispatchMatcher } from '../atp/matcher.js';
import type { JobEnvelope, JobSource } from '../core/job.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ProxyDependencies {
  config: VectraConfig;
  intakeGate: IntakeGate;
  dispatcher: Dispatcher;
  contextEngine: ContextEngine;
  matcher: AtpDispatchMatcher;
  receiptGate: ReceiptGate;
  telemetry: TelemetryEmitter;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  [key: string]: unknown;
}

// ─── Request Body Parsing ───────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Proxy Server ───────────────────────────────────────────────────

export class VectraProxy {
  private server: ReturnType<typeof createServer> | null = null;
  private deps: ProxyDependencies;

  constructor(deps: ProxyDependencies) {
    this.deps = deps;
  }

  /**
   * Start the proxy server.
   */
  async start(): Promise<void> {
    const { config } = this.deps;

    this.server = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        console.error('[vectra-proxy] unhandled error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal Vectra proxy error', type: 'proxy_error' } }));
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(config.proxyPort, '127.0.0.1', () => {
        console.log(`[vectra-proxy] listening on 127.0.0.1:${config.proxyPort}`);
        resolve();
      });
    });
  }

  /**
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Route incoming requests.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // Health check
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', component: 'vectra-proxy' }));
      return;
    }

    // Model listing passthrough
    if (url.startsWith('/v1/models') && req.method === 'GET') {
      await this.passthrough(req, res);
      return;
    }

    // Chat completions — the main interception point
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      await this.handleChatCompletions(req, res);
      return;
    }

    // Everything else passes through unchanged
    await this.passthrough(req, res);
  }

  /**
   * Main interception: chat completions flow through Vectra's pipeline.
   *
   * Flow:
   * 1. Parse the incoming request body
   * 2. Extract task description from the last user message
   * 3. Run intake gate (pattern match → admit or hold)
   * 4. Run dispatcher (protocol binding, model class, tool scope)
   * 5. Run context engine (compose enriched message array)
   * 6. Forward enriched request to upstream model API
   * 7. Run receipt gate on the response
   * 8. Return response to OpenClaw
   */
  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, matcher, dispatcher, telemetry } = this.deps;

    // 1. Parse request body
    const rawBody = await readBody(req);
    let body: ChatCompletionRequest;
    try {
      body = JSON.parse(rawBody.toString('utf-8')) as ChatCompletionRequest;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }));
      return;
    }

    // 2. Extract task description from last user message
    const messages = body.messages ?? [];
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const taskDescription = lastUserMsg?.content ?? '';

    // 3. Intake — pattern match against ATP routing table
    const matches = matcher.match(taskDescription);

    // 4. Dispatch — bind the best-matching protocol
    const jobStub: Partial<JobEnvelope> = {
      id: `vectra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: this.inferSource(req) as JobSource,
      description: taskDescription,
      createdAt: new Date().toISOString(),
    };

    const dispatchResult = dispatcher.dispatch(jobStub as JobEnvelope, matches);

    // Emit telemetry for the dispatch decision
    telemetry.emit(
      'job.admitted',
      jobStub.id!,
      dispatchResult.protocolId,
      {
        matched: dispatchResult.matched,
        taskClass: dispatchResult.taskClass,
        modelClass: dispatchResult.modelClass,
      },
    );

    // 5. Context enrichment (future: inject composed context layers into messages)
    // TODO: Wire context engine to enrich messages with protocol context, var data,
    // and guardrails. For now, pass through with dispatch metadata as a system prefix.
    if (dispatchResult.matched && dispatchResult.guardrails.length > 0) {
      const guardrailBlock = [
        `[Vectra] Protocol: ${dispatchResult.protocolId} | Task class: ${dispatchResult.taskClass}`,
        `[Vectra] Guardrails: ${dispatchResult.guardrails.join('; ')}`,
        `[Vectra] Tool allowlist: ${dispatchResult.toolAllowlist.join(', ') || 'unrestricted'}`,
      ].join('\n');

      // Prepend guardrails to the system message or add one
      const systemIdx = messages.findIndex((m) => m.role === 'system');
      if (systemIdx >= 0) {
        messages[systemIdx].content = guardrailBlock + '\n\n' + messages[systemIdx].content;
      } else {
        messages.unshift({ role: 'system', content: guardrailBlock });
      }
      body.messages = messages;
    }

    // 6. Forward to upstream model API
    const upstreamUrl = `${config.upstreamBaseUrl}/v1/chat/completions`;
    const upstreamHeaders: Record<string, string> = {};

    // Copy auth headers through to upstream
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'authorization' && typeof value === 'string') {
        upstreamHeaders['authorization'] = value;
      }
      if (key.toLowerCase() === 'content-type' && typeof value === 'string') {
        upstreamHeaders['content-type'] = value;
      }
      // Pass through anthropic-specific headers
      if (key.toLowerCase().startsWith('x-') && typeof value === 'string') {
        upstreamHeaders[key.toLowerCase()] = value;
      }
    }

    const enrichedBody = JSON.stringify(body);
    upstreamHeaders['content-length'] = Buffer.byteLength(enrichedBody).toString();

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: enrichedBody,
      });

      // 7. Receipt gate (future: validate model response before returning)
      // TODO: Wire receipt gate to validate completion response artifacts

      // 8. Return upstream response to OpenClaw
      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
      });

      // Stream the response body through
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          res.write(value);
          return pump();
        };
        await pump();
      } else {
        const responseText = await upstreamRes.text();
        res.end(responseText);
      }

      telemetry.emit(
        'job.completed',
        jobStub.id!,
        dispatchResult.protocolId,
        { upstreamStatus: upstreamRes.status },
      );
    } catch (err) {
      console.error('[vectra-proxy] upstream request failed:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Upstream model API request failed',
          type: 'proxy_error',
        },
      }));

      telemetry.emit(
        'job.failed',
        jobStub.id!,
        dispatchResult.protocolId,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  /**
   * Passthrough: forward request to upstream without interception.
   */
  private async passthrough(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config } = this.deps;
    const url = `${config.upstreamBaseUrl}${req.url ?? '/'}`;
    const body = req.method !== 'GET' && req.method !== 'HEAD' ? await readBody(req) : undefined;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }

    try {
      const upstream = await fetch(url, {
        method: req.method ?? 'GET',
        headers,
        body,
      });

      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });

      const responseBody = await upstream.text();
      res.end(responseBody);
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream unavailable', type: 'proxy_error' } }));
    }
  }

  /**
   * Infer job source from request metadata.
   */
  private inferSource(req: IncomingMessage): string {
    // OpenClaw sets x-openclaw-* headers on requests
    const sessionHeader = req.headers['x-openclaw-session'] as string | undefined;
    if (sessionHeader?.includes('cron')) return 'cron';
    if (sessionHeader?.includes('subagent')) return 'subagent-completion';
    if (sessionHeader?.includes('webhook')) return 'webhook';
    return 'human';
  }
}
