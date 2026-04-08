# Discord Connector Specification — Vectra v0.2.0

> Status: Design spec — not yet implemented
> Date: 2026-04-08

---

## Overview

The Discord connector is Vectra's first channel integration. It replaces OpenClaw's `discord` plugin, handling bidirectional message transport between Discord and Vectra's intake gate.

The connector has two roles:
1. **Inbound:** Receive Discord events via Gateway WebSocket → convert to Vectra Jobs
2. **Outbound:** Accept Vectra responses → send via Discord REST API

---

## Discord API Endpoints Required

### Gateway WebSocket (Inbound)

- **URL:** `wss://gateway.discord.gg/?v=10&encoding=json&compress=zlib-stream`
- **Protocol:** Discord Gateway v10
- **Transport:** WebSocket with zlib-stream compression

**Required Opcodes:**
| Opcode | Name | Direction | Purpose |
|---|---|---|---|
| 0 | Dispatch | Receive | All events (MESSAGE_CREATE, etc.) |
| 1 | Heartbeat | Send | Keep connection alive |
| 2 | Identify | Send | Initial authentication |
| 6 | Resume | Send | Reconnect with session replay |
| 7 | Reconnect | Receive | Server requests reconnect |
| 9 | Invalid Session | Receive | Session expired, re-identify |
| 10 | Hello | Receive | Heartbeat interval |
| 11 | Heartbeat ACK | Receive | Confirms heartbeat received |

**Required Intents (bitmask):**
| Intent | Bit | Purpose |
|---|---|---|
| GUILDS | 1 << 0 | Guild metadata, channel info |
| GUILD_MESSAGES | 1 << 9 | Messages in guild channels |
| GUILD_MESSAGE_REACTIONS | 1 << 10 | Reaction events |
| DIRECT_MESSAGES | 1 << 12 | DM messages |
| MESSAGE_CONTENT | 1 << 15 | Privileged: message text access |

**Required Gateway Events:**
- `READY` — session established, receive session_id + resume_gateway_url
- `RESUMED` — session resume successful
- `MESSAGE_CREATE` — new message in guild or DM
- `MESSAGE_UPDATE` — edited message (for reaction tracking)
- `MESSAGE_REACTION_ADD` — reaction added
- `INTERACTION_CREATE` — slash command invoked

### REST API (Outbound)

**Base URL:** `https://discord.com/api/v10`

**Endpoints needed:**

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/channels/{id}/messages` | Send message |
| PATCH | `/channels/{id}/messages/{id}` | Edit message (streaming) |
| DELETE | `/channels/{id}/messages/{id}` | Delete message |
| PUT | `/channels/{id}/messages/{id}/reactions/{emoji}/@me` | Add reaction |
| POST | `/channels/{id}/typing` | Typing indicator |
| GET | `/channels/{id}/messages` | Fetch message history |
| GET | `/channels/{id}` | Channel metadata |
| GET | `/guilds/{id}` | Guild metadata |
| GET | `/guilds/{id}/members/{id}` | Member info |
| POST | `/channels/{id}/threads` | Create thread |
| POST | `/channels/{id}/messages/{id}/threads` | Create thread from message |
| GET | `/channels/{id}/threads/archived/public` | List archived threads |
| POST | `/interactions/{id}/{token}/callback` | Respond to interaction |
| POST | `/webhooks/{id}/{token}` | Followup interaction response |

---

## Message Flow: Discord → Vectra

```
Discord Gateway WS
    │
    ▼
┌─────────────────┐
│  WS Client       │  Receives MESSAGE_CREATE dispatch
│  (zlib-stream)   │  Maintains heartbeat, sequence, session_id
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Event Router    │  Filters by guild/channel/user allowlist
│                  │  Checks requireMention per-channel
│                  │  Drops bot messages (unless allowBots: true)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Message Parser  │  Extracts: content, author, channel, guild,
│                  │  attachments, embeds, referenced message
│                  │  Resolves mentions to user IDs
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Job Factory     │  Creates JobEnvelope with:
│                  │  - source: 'human'
│                  │  - taskClass: 'conversational'
│                  │  - channel metadata
│                  │  - session key derivation
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Intake Gate     │  Standard Vectra intake (existing)
│  (existing)      │  Protocol matching, admission
└─────────────────┘
```

### Session Key Derivation

Must match OpenClaw's `dmScope: "per-channel-peer"`:
- **DMs:** `agent:main:discord:direct:{user_id}`
- **Guild channels:** `agent:main:discord:channel:{channel_id}`
- **Threads:** `agent:main:discord:channel:{thread_id}`

### Mention Detection

Per current config, most guild channels use `requireMention: true`. The connector must:
1. Check if message mentions the bot's user ID
2. Check if message starts with bot's name (case-insensitive)
3. If `requireMention: false` (DMs, specific channels like `1478022504579600416`), process all messages
4. Strip mention prefix before passing content to job factory

### Bot Message Handling

Current config: `allowBots: true`. The connector must:
- Accept messages from other bots (for agent-to-agent comms)
- Track `agentToAgent.maxPingPongTurns: 3` to prevent infinite loops
- Never respond to own messages

---

## Message Flow: Vectra → Discord

```
┌─────────────────┐
│  Vectra Response │  Model generates response text
│  Pipeline        │  
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Response        │  Applies Discord formatting rules:
│  Formatter       │  - Tables → code blocks (markdown.tables: "code")
│                  │  - Split messages >2000 chars
│                  │  - Embed links, attachments
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Streaming       │  Mode: "partial"
│  Manager         │  Creates initial message, then edits with chunks
│                  │  Rate-limited edits (~1/sec to avoid 429s)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  REST Client     │  POST /channels/{id}/messages (initial)
│                  │  PATCH /channels/{id}/messages/{id} (updates)
│                  │  Handles rate limit headers (X-RateLimit-*)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Ack Reaction    │  PUT reaction 👀 on user's message
│                  │  (ackReaction: "👀")
└─────────────────┘
```

### Streaming Implementation

Current OpenClaw mode: `"partial"` — sends initial message, then edits periodically with accumulated content.

Vectra implementation:
1. On first response chunk: POST new message, store message ID
2. Buffer subsequent chunks
3. Every ~1 second (or on significant content boundary): PATCH message with full accumulated text
4. On completion: final PATCH with complete response
5. If response exceeds 2000 chars mid-stream: stop editing current message, POST new continuation message

---

## Bot Token Management

**Requirement:** Token must NOT appear in config plaintext.

**Current OpenClaw approach:** Token stored via `--ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN` — references environment variable.

**Vectra approach:**
1. **Primary:** Read from environment variable `DISCORD_BOT_TOKEN`
2. **Fallback:** Read from `~/.openclaw/.env` file (existing location)
3. **Never:** Store in Vectra config files, git, or logs
4. **Rotation:** Support token refresh without restart (SIGHUP or config reload endpoint)

Token validation on startup:
- Call `GET /users/@me` with the token
- Verify bot user ID matches expected value
- Log bot username and discriminator (not the token)
- Fail fast if token is invalid

---

## Rate Limiting

Discord enforces rate limits at multiple levels. The connector must handle all of them.

### Global Rate Limit
- **50 requests per second** across all endpoints
- Response header: `X-RateLimit-Global: true`
- Response status: 429 with `Retry-After` header

### Per-Route Rate Limits
- Each endpoint has its own bucket
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Bucket`
- Pre-emptive rate limiting: track remaining quota, queue requests when exhausted

### Message Send Rate Limits (approximate)
- 5 messages per 5 seconds per channel
- Message edits: more lenient but still bucketed

### Implementation
```
┌─────────────────────────┐
│  Rate Limiter            │
│                          │
│  Global bucket: 50/s     │
│  Per-route buckets:      │
│    POST /messages → 5/5s │
│    PATCH /messages → ?   │
│    PUT /reactions → 1/s  │
│                          │
│  Queue: FIFO per bucket  │
│  Backoff: respect 429    │
│  Pre-empt: check before  │
└─────────────────────────┘
```

---

## Reconnection / Failover Behavior

This is the hardest part of the connector. See ROADMAP.md Hard Problem #1.

### Connection State Machine

```
     ┌──────────┐
     │ DISCONN  │ ◄──── initial state / unrecoverable error
     └────┬─────┘
          │ connect()
          ▼
     ┌──────────┐
     │ CONNECTING│ ◄──── opening WebSocket
     └────┬─────┘
          │ opcode 10 (Hello)
          ▼
     ┌──────────┐
     │ IDENTIFY │ ──── send opcode 2 (Identify) or opcode 6 (Resume)
     └────┬─────┘
          │ READY or RESUMED event
          ▼
     ┌──────────┐
     │ CONNECTED│ ◄──── normal operation
     └────┬─────┘
          │ connection lost / opcode 7 / heartbeat timeout
          ▼
     ┌──────────┐
     │ RESUMING │ ──── attempt resume with saved session
     └────┬─────┘
          │
          ├── resume succeeds → CONNECTED
          │
          └── opcode 9 (invalid session, d=false) → IDENTIFY (fresh)
              opcode 9 (d=true) → RESUMING (retry)
```

### Persisted Reconnection State

Saved to disk after every dispatch event:
```json
{
  "sessionId": "...",
  "sequence": 12345,
  "resumeGatewayUrl": "wss://gateway-us-east1-b.discord.gg"
}
```

File location: `~/.vectra/discord-session.json`

### Backoff Strategy

Matching OpenClaw's web reconnect config:
- Initial: 2000ms
- Max: 120000ms (2 minutes)
- Factor: 1.4x
- Jitter: 0.2 (±20%)
- Max attempts: unlimited (0 = infinite)

### Zombie Connection Detection

If heartbeat ACK is not received within `heartbeat_interval * 1.5`:
1. Close the WebSocket
2. Enter RESUMING state
3. Do NOT wait for Discord to close the connection — it may never come

### Network Instability (Jetson WiFi)

The Jetson's WiFi can drop briefly. Special handling:
- Keep reconnection state in memory AND on disk
- If connection drops and resumes within 30s, Discord usually allows resume
- If >30s, expect full re-identify
- Log all reconnection events with timestamps for debugging

---

## What OpenClaw's Discord Plugin Does (That Vectra Must Replicate)

Based on config audit and OpenClaw docs:

### Must Have (Day 1)
1. **Gateway WS connection** with heartbeat, identify, resume
2. **Message reception** with guild/channel/user filtering
3. **Message sending** with 2000-char splitting
4. **Mention detection** (requireMention per-channel)
5. **DM support** (per-channel-peer scoping)
6. **Ack reaction** (👀 on received messages)
7. **Partial streaming** (message create → edits)
8. **Rate limiting** (global + per-route)
9. **Bot message handling** (allowBots with ping-pong limit)
10. **Markdown table conversion** (tables → code blocks)

### Must Have (Day 2-7)
11. **Thread creation and replies**
12. **File/attachment sending**
13. **Embed construction**
14. **Typing indicator**
15. **Reaction management** (add/remove/list)
16. **Channel management** (create/edit/delete)
17. **Member info lookup**
18. **Message search**
19. **Pin management**

### Should Have (Later)
20. **Slash command registration and handling**
21. **Voice connection** (enabled in config but no auto-join)
22. **Poll creation**
23. **Sticker/emoji management**
24. **Event creation**

### Will Not Build (Deferred)
25. **Voice streaming** — complex, not critical
26. **Video/screen share** — not applicable

---

## Configuration Schema

Vectra's Discord config should mirror OpenClaw's structure for easy migration:

```typescript
interface DiscordConnectorConfig {
  enabled: boolean;
  // Token sourced from env, never stored here
  tokenEnvVar: string; // default: "DISCORD_BOT_TOKEN"
  
  markdown: {
    tables: 'code' | 'native' | 'none';
  };
  
  allowBots: boolean;
  groupPolicy: 'allowlist' | 'open';
  
  streaming: {
    mode: 'off' | 'partial' | 'full';
    editIntervalMs: number; // default: 1000
  };
  
  ackReaction: string | null; // "👀" or null to disable
  
  guilds: Record<string, GuildConfig>;
  
  heartbeat: {
    useIndicator: boolean; // typing indicator during heartbeat
  };
  
  voice: {
    enabled: boolean;
    autoJoin: string[]; // channel IDs
  };
  
  reconnect: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number; // 0 = unlimited
  };
}

interface GuildConfig {
  requireMention: boolean; // default for channels
  users: string[]; // allowed user IDs (if groupPolicy: allowlist)
  channels: Record<string, ChannelConfig>;
}

interface ChannelConfig {
  enabled: boolean;
  requireMention: boolean;
}
```

---

## Shadow Mode (Testing Phase)

Before cutover, the connector runs in shadow mode:

1. Connects to Discord Gateway (receives all events)
2. Logs events to `~/.vectra/discord-shadow.log`
3. Does NOT send any messages
4. Does NOT add reactions
5. Compares received events against OpenClaw's session log to verify parity
6. Reports: messages received, messages matched with OpenClaw, messages missed

Exit criteria for shadow mode:
- 24 hours with zero missed messages
- Reconnection tested (at least one resume + one full re-identify)
- All guild channels and DMs receiving correctly
- Event throughput matches OpenClaw's logged message rate

---

## Implementation Notes

### Library Choice

**Recommended: Build from scratch (no discord.js)**

Rationale:
- discord.js is 50MB+ of dependencies
- We need precise control over reconnection, rate limiting, and event handling
- The Gateway protocol is well-documented and not that complex
- Vectra's transport layer is already designed for raw WS connections
- Fewer dependencies = smaller attack surface = easier to audit

Required npm packages:
- `ws` — WebSocket client (lightweight, well-maintained)
- `zlib` — built-in Node.js, for zlib-stream decompression
- `undici` or built-in `fetch` — for REST API calls

### File Structure

```
src/transport/discord/
├── gateway.ts       — WS client, heartbeat, identify/resume
├── events.ts        — Event type definitions and dispatch
├── rest.ts          — REST API client with rate limiting
├── rate-limiter.ts  — Bucket-based rate limit tracker
├── formatter.ts     — Message formatting (markdown, splitting)
├── config.ts        — Config schema and validation
├── session.ts       — Reconnection state persistence
└── shadow.ts        — Shadow mode logging and comparison
```

---

## Testing Strategy

1. **Unit tests:** Event parsing, message formatting, rate limit bucket math
2. **Integration tests:** Against Discord staging bot (separate bot token for testing)
3. **Shadow mode:** Parallel run with OpenClaw for 24-72 hours
4. **Failover test:** Kill the WS connection during active conversation, verify resume
5. **Rate limit test:** Send burst of messages, verify graceful queuing
6. **Long-run test:** 7 days continuous operation, monitor for memory leaks and session drift
