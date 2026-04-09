/**
 * Discord Gateway WebSocket Transport Connector — Vectra v0.2.0
 *
 * Implements TransportConnector over Discord's Gateway v10 protocol.
 * Handles the full lifecycle: HELLO → IDENTIFY → HEARTBEAT loop,
 * session resume on disconnect, exponential backoff reconnection,
 * and inbound MESSAGE_CREATE → InboundMessage conversion.
 *
 * Outbound messages go through Discord REST API with rate limiting.
 *
 * Bot token sourced exclusively from DISCORD_BOT_TOKEN env var.
 */

import WebSocket from 'ws';
import type {
  TransportConnector,
  InboundMessage,
  OutboundMessage,
} from './interface.js';

// ─── Discord Gateway Constants ──────────────────────────────────────

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const REST_BASE = 'https://discord.com/api/v10';

/** Discord Gateway opcodes */
const enum GatewayOp {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  PresenceUpdate = 3,
  VoiceStateUpdate = 4,
  Resume = 6,
  Reconnect = 7,
  RequestGuildMembers = 8,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatAck = 11,
}

/**
 * Gateway intents bitmask.
 * GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | MESSAGE_CONTENT
 */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 15);

/** Discord close codes that are fatal (do not reconnect) */
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4003, 4004, 4005, 4007, 4008, 4009]);

// ─── Rate Limiter ───────────────────────────────────────────────────

interface RateBucket {
  remaining: number;
  resetAt: number; // epoch ms
}

class RestRateLimiter {
  private buckets = new Map<string, RateBucket>();
  private globalResetAt = 0;

  /**
   * Wait until the route is clear to send, then return.
   */
  async acquire(route: string): Promise<void> {
    // Global rate limit
    const now = Date.now();
    if (this.globalResetAt > now) {
      await this.sleep(this.globalResetAt - now);
    }

    const bucket = this.buckets.get(route);
    if (bucket && bucket.remaining <= 0 && bucket.resetAt > Date.now()) {
      await this.sleep(bucket.resetAt - Date.now());
    }
  }

  /**
   * Update rate limit state from response headers.
   */
  update(route: string, headers: Headers, status: number): number {
    if (status === 429) {
      const retryAfter = parseFloat(headers.get('retry-after') ?? '1') * 1000;
      const isGlobal = headers.get('x-ratelimit-global') === 'true';
      if (isGlobal) {
        this.globalResetAt = Date.now() + retryAfter;
      } else {
        this.buckets.set(route, { remaining: 0, resetAt: Date.now() + retryAfter });
      }
      return retryAfter;
    }

    const remaining = parseInt(headers.get('x-ratelimit-remaining') ?? '99', 10);
    const resetAfter = parseFloat(headers.get('x-ratelimit-reset-after') ?? '0') * 1000;

    this.buckets.set(route, {
      remaining,
      resetAt: Date.now() + resetAfter,
    });

    return 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}

// ─── Discord Connector ─────────────────────────────────────────────

export class DiscordConnector implements TransportConnector {
  // Config
  private readonly token: string;
  private readonly guildId: string;
  private readonly channelIds: Set<string>;

  // WebSocket state
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private sequence: number | null = null;
  private botUserId: string | null = null;

  // Heartbeat state
  private heartbeatIntervalMs = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAck = 0;
  private lastHeartbeatSent = 0;
  private heartbeatAckReceived = true;

  // Reconnection state
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;
  private reconnecting = false;

  // Rate limiter
  private rateLimiter = new RestRateLimiter();

  // Event handlers
  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
  private connectHandler: (() => void) | null = null;
  private disconnectHandler: ((reason: string) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  constructor(config: Record<string, unknown>) {
    // Token from env var — NEVER from config
    const tokenEnvVar = (config['tokenEnvVar'] as string) ?? 'DISCORD_BOT_TOKEN';
    const token = process.env[tokenEnvVar];
    if (!token) {
      throw new Error(
        `Discord bot token not found. Set the ${tokenEnvVar} environment variable.`
      );
    }
    this.token = token;

    this.guildId = (config['guildId'] as string) ?? '';
    const channels = (config['channels'] as Record<string, string>) ?? {};
    this.channelIds = new Set(Object.values(channels));
  }

  // ─── TransportConnector interface ─────────────────────────────────

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    // Validate token by fetching bot user info
    const me = await this.restGet('/users/@me');
    this.botUserId = me.id;
    console.log(`[discord] Authenticated as ${me.username}#${me.discriminator ?? '0'} (${me.id})`);

    await this.openGateway(GATEWAY_URL);
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Vectra shutdown');
      this.ws = null;
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    const route = `POST /channels/${message.channelId}/messages`;
    const body: Record<string, unknown> = { content: message.text };

    if (message.replyToId) {
      body['message_reference'] = { message_id: message.replyToId };
      body['allowed_mentions'] = { replied_user: false };
    }

    // Split messages exceeding 2000 chars
    const text = message.text;
    if (text.length <= 2000) {
      await this.restPost(`/channels/${message.channelId}/messages`, body, route);
    } else {
      const chunks = this.splitMessage(text, 2000);
      for (let i = 0; i < chunks.length; i++) {
        const chunkBody: Record<string, unknown> = { content: chunks[i] };
        // Only first chunk gets the reply reference
        if (i === 0 && message.replyToId) {
          chunkBody['message_reference'] = { message_id: message.replyToId };
          chunkBody['allowed_mentions'] = { replied_user: false };
        }
        await this.restPost(`/channels/${message.channelId}/messages`, chunkBody, route);
      }
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  isConnected(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // Check heartbeat health: ACK must have been received within 2× heartbeat interval
    if (this.heartbeatIntervalMs > 0 && this.lastHeartbeatSent > 0) {
      const deadline = this.lastHeartbeatSent + this.heartbeatIntervalMs * 2;
      if (this.lastHeartbeatAck < this.lastHeartbeatSent && Date.now() > deadline) {
        return false;
      }
    }
    return true;
  }

  // ─── Gateway Connection ───────────────────────────────────────────

  private openGateway(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      let resolved = false;
      const resolveOnce = (): void => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      ws.on('open', () => {
        console.log('[discord] WebSocket opened');
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const payload = JSON.parse(data.toString());
          this.handleGatewayMessage(payload, resolveOnce);
        } catch (err) {
          this.emitError(new Error(`Failed to parse gateway message: ${err}`));
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || `code ${code}`;
        console.log(`[discord] WebSocket closed: ${code} — ${reasonStr}`);
        this.stopHeartbeat();
        this.disconnectHandler?.(reasonStr);

        if (!resolved) {
          resolved = true;
          reject(new Error(`Gateway closed during connect: ${code} ${reasonStr}`));
          return;
        }

        if (this.intentionalDisconnect) return;

        if (FATAL_CLOSE_CODES.has(code)) {
          console.error(`[discord] Fatal close code ${code} — will not reconnect`);
          this.emitError(new Error(`Fatal Discord close code: ${code}`));
          return;
        }

        // Attempt reconnect
        this.scheduleReconnect();
      });

      ws.on('error', (err: Error) => {
        console.error('[discord] WebSocket error:', err.message);
        this.emitError(err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  // ─── Gateway Message Handling ─────────────────────────────────────

  private handleGatewayMessage(
    payload: { op: number; d: unknown; s: number | null; t: string | null },
    onReady: () => void
  ): void {
    // Track sequence number
    if (payload.s !== null) {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case GatewayOp.Hello:
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;

      case GatewayOp.HeartbeatAck:
        this.lastHeartbeatAck = Date.now();
        this.heartbeatAckReceived = true;
        break;

      case GatewayOp.Heartbeat:
        // Server requested immediate heartbeat
        this.sendHeartbeat();
        break;

      case GatewayOp.Reconnect:
        console.log('[discord] Server requested reconnect (op 7)');
        this.ws?.close(4000, 'Server reconnect request');
        break;

      case GatewayOp.InvalidSession:
        this.handleInvalidSession(payload.d as boolean);
        break;

      case GatewayOp.Dispatch:
        this.handleDispatch(payload.t!, payload.d, onReady);
        break;

      default:
        // Ignore unknown opcodes
        break;
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    this.heartbeatIntervalMs = data.heartbeat_interval;
    console.log(`[discord] Hello received, heartbeat interval: ${this.heartbeatIntervalMs}ms`);

    // Start heartbeat loop
    this.startHeartbeat();

    // Send IDENTIFY or RESUME
    if (this.sessionId && this.sequence !== null) {
      console.log('[discord] Resuming session...');
      this.sendPayload(GatewayOp.Resume, {
        token: this.token,
        session_id: this.sessionId,
        seq: this.sequence,
      });
    } else {
      console.log('[discord] Identifying...');
      this.sendPayload(GatewayOp.Identify, {
        token: this.token,
        intents: INTENTS,
        properties: {
          os: 'linux',
          browser: 'vectra',
          device: 'vectra',
        },
      });
    }
  }

  private handleInvalidSession(resumable: boolean): void {
    console.log(`[discord] Invalid session (resumable: ${resumable})`);
    if (!resumable) {
      // Clear session state — must do fresh identify
      this.sessionId = null;
      this.sequence = null;
      this.resumeGatewayUrl = null;
    }
    // Close and reconnect — the reconnect logic will decide identify vs resume
    setTimeout(() => {
      this.ws?.close(4000, 'Invalid session');
    }, 1000 + Math.random() * 4000); // 1-5s random delay per Discord docs
  }

  private handleDispatch(event: string, data: unknown, onReady: () => void): void {
    switch (event) {
      case 'READY': {
        const ready = data as {
          session_id: string;
          resume_gateway_url: string;
          user: { id: string; username: string };
        };
        this.sessionId = ready.session_id;
        this.resumeGatewayUrl = ready.resume_gateway_url;
        this.botUserId = ready.user.id;
        this.reconnectAttempts = 0;
        console.log(`[discord] READY — session: ${this.sessionId}`);
        this.connectHandler?.();
        onReady();
        break;
      }

      case 'RESUMED':
        this.reconnectAttempts = 0;
        console.log('[discord] RESUMED — session restored');
        this.connectHandler?.();
        onReady();
        break;

      case 'MESSAGE_CREATE':
        this.handleMessageCreate(data as DiscordMessagePayload);
        break;

      default:
        // We receive many events; only process what we need
        break;
    }
  }

  // ─── Message Handling ─────────────────────────────────────────────

  private handleMessageCreate(msg: DiscordMessagePayload): void {
    // Never respond to our own messages
    if (msg.author.id === this.botUserId) return;

    // Convert to InboundMessage
    const inbound: InboundMessage = {
      id: msg.id,
      channelId: msg.channel_id,
      senderId: msg.author.id,
      senderTrust: msg.author.bot ? 'webhook' : 'human',
      text: msg.content,
      timestamp: new Date(msg.timestamp),
      replyToId: msg.message_reference?.message_id,
      attachments: msg.attachments?.map((a) => ({
        type: a.content_type ?? 'unknown',
        url: a.url,
      })),
      raw: msg,
    };

    // Dispatch to handler (fire and forget — handler manages its own errors)
    this.messageHandler?.(inbound).catch((err) => {
      console.error('[discord] Message handler error:', err);
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  // ─── Heartbeat ────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatAckReceived = true;
    this.lastHeartbeatAck = Date.now();

    // Send first heartbeat after a jittered interval
    const jitter = Math.random() * this.heartbeatIntervalMs;
    setTimeout(() => this.sendHeartbeat(), jitter);

    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAckReceived) {
        // Zombie connection — no ACK received for last heartbeat
        console.warn('[discord] Heartbeat ACK missed — closing connection');
        this.ws?.close(4000, 'Heartbeat ACK timeout');
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    this.heartbeatAckReceived = false;
    this.lastHeartbeatSent = Date.now();
    this.sendPayload(GatewayOp.Heartbeat, this.sequence);
  }

  // ─── Reconnection ────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;

    const backoff = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      30000
    );
    // Add jitter ±20%
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    this.reconnectAttempts++;

    console.log(
      `[discord] Reconnecting in ${Math.round(jitter)}ms (attempt ${this.reconnectAttempts})`
    );

    setTimeout(async () => {
      this.reconnecting = false;
      try {
        // Use resume_gateway_url if we have a session to resume
        const url =
          this.sessionId && this.resumeGatewayUrl
            ? `${this.resumeGatewayUrl}/?v=10&encoding=json`
            : GATEWAY_URL;
        await this.openGateway(url);
      } catch (err) {
        console.error('[discord] Reconnection failed:', err);
        this.emitError(err instanceof Error ? err : new Error(String(err)));
        // Schedule another attempt
        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      }
    }, jitter);
  }

  // ─── REST API ─────────────────────────────────────────────────────

  private async restPost(
    path: string,
    body: Record<string, unknown>,
    route: string
  ): Promise<unknown> {
    return this.restRequest('POST', path, body, route);
  }

  private async restGet(path: string): Promise<Record<string, unknown> & { id: string; username: string; discriminator?: string }> {
    return this.restRequest('GET', path, undefined, `GET ${path}`) as Promise<Record<string, unknown> & { id: string; username: string; discriminator?: string }>;
  }

  private async restRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    route?: string
  ): Promise<unknown> {
    const routeKey = route ?? `${method} ${path}`;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.rateLimiter.acquire(routeKey);

      const res = await fetch(`${REST_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Vectra (https://github.com/vectra, 0.2.0)',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const retryAfter = this.rateLimiter.update(routeKey, res.headers, res.status);

      if (res.status === 429) {
        console.warn(
          `[discord] Rate limited on ${routeKey}, retrying in ${Math.round(retryAfter)}ms`
        );
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => 'unknown');
        throw new Error(`Discord REST ${method} ${path} failed: ${res.status} — ${errBody}`);
      }

      // 204 No Content
      if (res.status === 204) return {};

      return res.json();
    }

    throw new Error(`Discord REST ${method} ${path}: rate limit retries exhausted`);
  }

  // ─── Utilities ────────────────────────────────────────────────────

  private sendPayload(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d }));
    }
  }

  private emitError(err: Error): void {
    this.errorHandler?.(err);
  }

  private splitMessage(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline near the boundary
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.5) {
        // No good newline — split at space
        splitAt = remaining.lastIndexOf(' ', maxLen);
      }
      if (splitAt < maxLen * 0.3) {
        // No good boundary — hard split
        splitAt = maxLen;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}

// ─── Discord Payload Types (minimal) ───────────────────────────────

interface DiscordMessagePayload {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  message_reference?: {
    message_id?: string;
  };
  attachments?: Array<{
    id: string;
    url: string;
    content_type?: string;
    filename: string;
    size: number;
  }>;
}
