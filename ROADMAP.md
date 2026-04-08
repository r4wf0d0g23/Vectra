# Vectra Roadmap — Full OpenClaw Replacement

> Last updated: 2026-04-08
> Status: Design phase — no implementation this cycle

---

## Current State Assessment

### What OpenClaw Does for This Deployment

Audit of `openclaw.json` and runtime state on `agent-raw-jetson1`:

| # | OpenClaw Capability | Config Details | Vectra Replacement | Complexity | Dependencies |
|---|---|---|---|---|---|
| 1 | **Discord transport** | Gateway WS + REST. 1 guild, 10 channels, DMs, allowlist group policy, partial streaming, voice enabled, ack reactions (👀), requireMention per-channel, bot-to-bot allowed | Discord connector: WS gateway client + REST sender | **High** | Bot token management, reconnection logic |
| 2 | **Model dispatch** | 6 providers (Anthropic, OpenAI, xAI, vLLM local, + merged models). Primary: claude-sonnet-4-6. Fallback chains. OpenAI-completions + Anthropic-messages API styles | Multi-provider model router | **Medium** | Provider auth, API normalization layer |
| 3 | **Session persistence** | 60,793-line sessions.json (80MB). Per-channel-peer DM scoping. 3 agent dirs (main, agent-raw, agent-nav). 2d prune, 500 max entries | Session store (SQLite or append-log) | **Medium** | Schema design, migration script |
| 4 | **Context pruning** | cache-ttl mode, 30m TTL, keep last 20 assistant messages | Context window manager | **Medium** | Token counting, message scoring |
| 5 | **Compaction** | Safeguard mode, 30K reserve floor, memory flush at 100K tokens. Custom flush prompt writes to `memory/YYYY-MM-DD.md` | Compaction engine with memory flush | **High** | Token counting, model call for summarization, memory file I/O |
| 6 | **Heartbeat** | Every 30m, model: grok-4-1-fast. Reads HEARTBEAT.md, runs proactive checks | Scheduler: periodic task runner | **Medium** | Cron engine, session injection |
| 7 | **Cron** | Enabled (currently no scheduled tasks, but infrastructure exists) | Scheduler: cron expressions | **Low** | Timer/scheduler core |
| 8 | **Memory search** | QMD backend. Hybrid search (vector 0.7 + text 0.3, MMR λ=0.7). Indexes workspace + ~/notes. 5m update interval, 6 max results | Vector + text search engine | **High** | Embedding model, index build, incremental update |
| 9 | **Subagent orchestration** | Max 8 concurrent. Model routing per subagent. Session spawning, result collection, depth tracking | Subagent lifecycle manager | **High** | Session multiplexing, model dispatch, result routing |
| 10 | **Gateway API** | Port 18789, loopback + Tailscale. Token auth. HTTP chat completions endpoint. Tool allowlist (sessions_send). Node management | HTTP API server | **Medium** | Auth, tool dispatch, Tailscale integration |
| 11 | **Workspace bootstrap** | 80K max chars per file, 200K total. AGENTS.md, SOUL.md, USER.md, TOOLS.md injection into system prompt | System prompt assembler | **Low** | File reader, token budget |
| 12 | **Hooks** | command-logger, session-memory, ATP enforcement (custom plugin from local path) | Hook/middleware pipeline | **Medium** | Plugin architecture |
| 13 | **Skills system** | Auto-discovery of SKILL.md files. Install preferences (preferBrew). Skill loading into context | Skill loader | **Low** | File discovery, context injection |
| 14 | **Tool execution** | exec (full security, no ask, 1800s timeout), web search/fetch, browser, sessions visibility:all | Tool runtime + sandboxing | **High** | Process management, security model |
| 15 | **Streaming** | Partial streaming mode to Discord | SSE/chunked response to Discord REST | **Medium** | Discord message edit cadence, rate limiting |
| 16 | **Voice** | Enabled in Discord config, no auto-join | Discord voice gateway client | **High** | Opus codec, voice WS, not currently critical |
| 17 | **Agent-to-agent comms** | Max 3 ping-pong turns. Cross-agent session sending via gateway | Inter-agent message bus | **Medium** | Session routing, loop detection |
| 18 | **Broadcast** | Parallel strategy | Multi-channel fan-out | **Low** | Channel abstraction |
| 19 | **ATP enforcement plugin** | Custom plugin at `atp-enforcement-plugin/`, loaded from local path | Native ATP integration (already in Vectra scaffold) | **Low** | Already scaffolded |

### Data Volumes

- **Sessions:** 80MB, 60K+ lines (main agent alone)
- **Memory files:** 67 markdown files spanning 2026-02-25 to present
- **Agents:** 3 directories (main, agent-raw, agent-nav)
- **QMD index:** Covers workspace + ~/notes, updates every 5 minutes

---

## Migration Phases

### Phase 1 — Build Alongside (OpenClaw still runs, zero downtime)

Build these Vectra components while OpenClaw handles all production traffic:

1. **v0.2.0 — Discord connector** (see [discord-connector.md](docs/discord-connector.md))
   - Gateway WS client with resume/reconnect
   - REST message sender with rate limiting
   - Message routing to Vectra intake gate
   - Shadow mode: receives Discord events, logs them, does NOT respond (OpenClaw still responds)

2. **v0.3.0 — Session persistence**
   - SQLite-backed session store
   - Migration script to import OpenClaw's sessions.json
   - Per-channel-peer scoping
   - Prune/maintenance logic

3. **v0.4.0 — Model dispatch**
   - Multi-provider router (Anthropic, OpenAI, xAI, vLLM)
   - API normalization (openai-completions ↔ anthropic-messages)
   - Streaming support
   - Fallback chain logic

4. **v0.5.0 — Scheduler + heartbeat**
   - Cron expression parser
   - Heartbeat timer with configurable interval
   - Task injection into session context

5. **v0.6.0 — Context management**
   - Token counter (tiktoken or provider-native)
   - Context pruning (cache-ttl equivalent)
   - Compaction with memory flush
   - System prompt assembly (workspace bootstrap)

6. **v0.7.0 — Memory search**
   - QMD-equivalent: embed markdown files, build vector index
   - Hybrid search (vector + text)
   - Incremental update on file change

### Phase 2 — Cutover (switch traffic, OpenClaw on standby)

Order matters. Each step is independently reversible:

1. **Discord traffic → Vectra** (v0.2.0 exits shadow mode)
   - OpenClaw's Discord plugin disabled
   - Vectra's Discord connector goes live
   - Rollback: re-enable OpenClaw Discord plugin, disable Vectra connector
   - **Risk window:** ~5 seconds of no response during bot token handoff

2. **Model dispatch → Vectra** (v0.4.0 goes live)
   - Vectra calls providers directly instead of proxying through OpenClaw
   - OpenClaw's chat completions endpoint unused

3. **Sessions → Vectra** (v0.3.0 goes live)
   - Final session sync from OpenClaw → Vectra SQLite
   - Vectra owns read/write of conversation history

4. **Scheduler → Vectra** (v0.5.0 goes live)
   - OpenClaw heartbeat disabled
   - Vectra heartbeat enabled

5. **Memory → Vectra** (v0.7.0 goes live)
   - QMD indexing transferred
   - OpenClaw memory search disabled

### Phase 3 — OpenClaw Removal

1. Stop OpenClaw daemon (`openclaw gateway stop`)
2. Archive `~/.openclaw/` to `~/.openclaw-archive-YYYYMMDD/`
3. Remove OpenClaw npm package
4. Remove systemd service (if configured)
5. Clean up `.env` references to OpenClaw-specific vars
6. Update AGENTS.md, TOOLS.md to remove OpenClaw references

---

## Version Milestones

### v0.1.0 — HTTP Proxy Scaffold ✅ (Current)

**What exists:** ATP-native job system, intake/receipt/approval gates, T1/T2/T3 worker tiers, dispatcher, state machine, telemetry, transport proxy layer.

**What it enables:** Task classification and routing framework. No production traffic.

**Replaces:** Nothing yet.

---

### v0.2.0 — Discord Connector

**What it builds:**
- Discord Gateway WebSocket client (v10, zlib-stream compression)
- Intents: GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, DIRECT_MESSAGES, MESSAGE_CONTENT
- REST client for sending messages, reactions, embeds, files
- Channel/guild configuration (allowlist, requireMention, per-channel settings)
- Message → Job conversion at intake gate
- Shadow mode for parallel testing
- Reconnection with session resume (opcode 6) and full reconnect fallback
- Rate limiter (global 50/s, per-route buckets)

**What it enables:** Vectra can receive and send Discord messages independently.

**Replaces:** OpenClaw's `discord` plugin.

**Key risk:** Discord Gateway reconnection under network instability. See Hard Problems #1.

---

### v0.3.0 — Session Persistence

**What it builds:**
- SQLite session store with WAL mode
- Schema: sessions, messages, metadata tables
- Per-channel-peer DM scoping
- Session prune (configurable TTL, max entries)
- Migration tool: OpenClaw sessions.json → SQLite
- Agent-scoped session directories (main, agent-raw, agent-nav)

**What it enables:** Conversation history survives restarts. Context can be rebuilt.

**Replaces:** OpenClaw's `sessions.json` file-based persistence.

---

### v0.4.0 — Model Dispatch

**What it builds:**
- Provider registry (Anthropic, OpenAI, xAI, vLLM)
- API normalizer: translates between openai-completions and anthropic-messages formats
- Streaming adapter (SSE → chunk → Discord message edits)
- Model selection: primary + fallback chains
- Cost tracking per call
- Provider health checks and circuit breaker

**What it enables:** Vectra calls LLM providers directly. No proxy needed.

**Replaces:** OpenClaw's model dispatch and the Vectra→OpenClaw proxy path.

---

### v0.5.0 — Scheduler

**What it builds:**
- Cron expression parser (standard 5-field + extensions)
- Heartbeat timer (configurable interval, default 30m)
- Task injection: scheduler creates Jobs and submits to intake gate
- Model override per scheduled task (e.g., heartbeat uses grok-4-1-fast)
- Missed-fire policy (run-once on wake if missed)

**What it enables:** Autonomous periodic operations without OpenClaw.

**Replaces:** OpenClaw's `cron` system and `heartbeat` config.

---

### v0.6.0 — Context Management

**What it builds:**
- Token counter (cl100k_base for OpenAI/xAI, claude tokenizer for Anthropic)
- Context pruning: cache-TTL mode with configurable TTL and keep-last-N
- Compaction engine: safeguard mode with reserve floor
- Memory flush: triggers model call to summarize context → writes to `memory/YYYY-MM-DD.md`
- System prompt assembler: reads AGENTS.md, SOUL.md, USER.md, TOOLS.md, IDENTITY.md with token budget (80K per file, 200K total)
- Workspace file injection

**What it enables:** Long conversations don't OOM. Context stays relevant.

**Replaces:** OpenClaw's `contextPruning`, `compaction`, and workspace bootstrap.

---

### v0.7.0 — Memory & Search

**What it builds:**
- Markdown file indexer (workspace + ~/notes paths)
- Embedding generator (local or API-based)
- Vector store (SQLite with vec extension, or FAISS)
- Hybrid search: vector (0.7 weight) + text (0.3 weight)
- MMR re-ranking (λ=0.7)
- Incremental index update (5m interval, 15s debounce)
- memory_search / memory_get tool equivalents

**What it enables:** Semantic memory retrieval without OpenClaw.

**Replaces:** OpenClaw's QMD memory backend.

---

### v0.8.0 — Subagent Orchestration

**What it builds:**
- Subagent spawner: creates child sessions with isolated context
- Model routing per subagent (cost optimization table)
- Concurrency limiter (max 8)
- Result collection and auto-announcement to parent
- Depth tracking (max depth enforcement)
- Timeout management (default 1800s)

**What it enables:** Complex multi-step tasks with parallel workers.

**Replaces:** OpenClaw's subagent system.

---

### v0.9.0 — Tool Runtime & Gateway

**What it builds:**
- Tool executor: exec (process management, security modes), web search/fetch, browser control
- Gateway HTTP server (replaces OpenClaw gateway on port 18789)
- Token auth + Tailscale allowance
- Tool allowlist enforcement
- sessions_send for cross-agent comms
- Hook pipeline (command-logger, session-memory, ATP)

**What it enables:** Full tool access without OpenClaw. External integrations preserved.

**Replaces:** OpenClaw's tool system, gateway, and hooks.

---

### v1.0.0 — OpenClaw Removal Complete

**What it does:**
- All traffic flows through Vectra
- OpenClaw daemon stopped and archived
- npm package removed
- Config migrated to Vectra's native format
- All tests pass against production Discord guild
- 72-hour burn-in period with no OpenClaw fallback

**What it enables:** Vectra is the sole runtime. No dependencies on OpenClaw.

---

## Captain-2 Milestone — Active/Standby Failover

**Target version: v0.8.0+**

Captain-2 (active/standby failover) becomes operational when these are complete:

1. ✅ Discord connector (v0.2.0) — can receive/send messages
2. ✅ Session persistence (v0.3.0) — shared session state
3. ✅ Model dispatch (v0.4.0) — can call providers independently
4. ✅ Scheduler (v0.5.0) — can run heartbeats autonomously
5. ✅ Context management (v0.6.0) — can maintain conversation coherence
6. ✅ Subagent orchestration (v0.8.0) — can handle complex tasks

**Failover mechanism:**
- Primary Vectra instance runs on `agent-raw-jetson1`
- Standby instance runs on DGX or second node
- Shared session store (SQLite replicated via Litestream or similar)
- Leader election via simple lock file on shared storage or Tailscale coordination
- Heartbeat between instances: if primary misses 3 consecutive heartbeats (90s), standby promotes
- Discord bot token can only be used by one gateway connection — standby must wait for primary's session to invalidate (Discord enforces this)

**Critical constraint:** Discord allows only ONE active gateway connection per bot token. Failover requires the standby to establish a new connection after the primary's session expires or is explicitly invalidated. This means a **5-15 second gap** during failover is unavoidable unless using a shared gateway proxy approach.

**Alternative: Gateway proxy pattern**
- Single always-on Discord WS connection (lightweight relay process)
- Routes messages to active Vectra instance
- Failover switches the routing target, not the Discord connection
- Adds a component but eliminates the Discord reconnection gap

**Recommendation:** Use the gateway proxy pattern. The additional complexity is justified by zero-gap failover.

---

## Hard Problems

### 1. Discord Gateway WebSocket Reconnection

**Why it's hard:** Discord's Gateway v10 uses a stateful WebSocket with session resume (opcode 6). The client must maintain a session ID, sequence number, and resume URL across reconnections. If the session expires (>30s disconnect, or server-side invalidation), a full re-identify is required, which replays missed events only within a limited window. Under network instability (common on Jetson with WiFi), rapid disconnect/reconnect cycles can trigger Discord's rate limiting or session invalidation.

**Solution approach:**
- Implement robust reconnection state machine: CONNECTED → DISCONNECTING → RESUMING → RE-IDENTIFYING → CONNECTED
- Persist session_id + sequence + resume_gateway_url to disk on every event
- Use zlib-stream for bandwidth efficiency
- Implement jittered exponential backoff (2s → 120s, 1.4x factor, 0.2 jitter — matching OpenClaw's web reconnect config)
- Monitor heartbeat ACK timing to detect zombie connections before Discord closes them

**Failure mode if done wrong:** Silent message loss. Agent appears online but receives no events. Users send messages that vanish. Worst case: bot appears to "ignore" the crew for hours until someone manually restarts.

### 2. Session State Migration (60K+ lines, 80MB)

**Why it's hard:** OpenClaw's sessions.json is a monolithic append-log with 60,793 lines. It contains interleaved sessions across multiple channels, DMs, and agents. The format is undocumented (OpenClaw internal). Migration must preserve conversation continuity — if a user references "what we discussed yesterday," the migrated session must contain that context.

**Solution approach:**
- Write a migration script that reads sessions.json line-by-line (streaming, not full load)
- Map OpenClaw's session keys to Vectra's schema
- Validate message ordering and channel attribution
- Run migration in parallel with OpenClaw (dual-write period)
- Checksum validation: compare session counts and message counts pre/post migration

**Failure mode if done wrong:** Lost conversation history. Agent wakes up with amnesia. Memory flush references (dates, decisions) become orphaned.

### 3. Context Window Management Parity

**Why it's hard:** OpenClaw's compaction system is deeply integrated with its session management, model dispatch, and memory subsystem. It counts tokens per-provider (different tokenizers), triggers memory flush at a soft threshold, and maintains a reserve floor. Getting this wrong means either:
- Context overflow → API errors, truncated responses
- Over-aggressive pruning → agent loses important context mid-conversation

**Solution approach:**
- Use provider-specific tokenizers (tiktoken for OpenAI/xAI, Anthropic's tokenizer for Claude)
- Implement the same safeguard mode: monitor token count, flush at soft threshold, hard-stop at reserve floor
- Reuse OpenClaw's memory flush prompt verbatim (it's well-tuned)
- Add a token budget dashboard in telemetry for debugging

**Failure mode if done wrong:** Random API 400 errors during long conversations. Memory flush triggers too early (loses context) or too late (hits hard limit and crashes).

### 4. Memory Search Quality Parity

**Why it's hard:** OpenClaw uses QMD with hybrid search (vector 0.7 + text 0.3) and MMR re-ranking. This gives surprisingly good results for the crew's use cases (referencing past decisions, finding project context, recalling tool configs). Replacing this means either:
- Replicating QMD's exact behavior (undocumented internals)
- Building a new search system that's at least as good

The embedding model choice, chunking strategy, and MMR lambda all affect result quality in subtle ways that are hard to test automatically.

**Solution approach:**
- Use the same embedding model as QMD (inspect QMD config to determine which)
- Build a test harness: 50 representative queries with known-good results from current QMD
- A/B test Vectra's search against QMD during Phase 1
- Start with sqlite-vec for simplicity, graduate to FAISS if performance demands

**Failure mode if done wrong:** Agent can't find its own memories. `memory_search` returns irrelevant results. The "continuity of self" that the crew depends on degrades silently.

### 5. Tool Runtime Security Model

**Why it's hard:** OpenClaw's tool system runs with `security: "full"` and `ask: "off"` — meaning the agent can execute arbitrary shell commands without approval. This is a deliberate trust decision for this deployment. Vectra must replicate this exact security posture without introducing new attack surface. The tool system also includes browser control, web fetch, file I/O, and process management — each with their own security considerations.

**Solution approach:**
- Port OpenClaw's exec security model directly (full/allowlist/deny modes)
- Implement process management (background processes, session tracking, timeout enforcement)
- Browser control can delegate to the existing OpenClaw browser server initially
- Web search/fetch are stateless HTTP calls — straightforward to port

**Failure mode if done wrong:** Either too permissive (security regression) or too restrictive (agent can't do its job). The "ask" mode is particularly tricky — if accidentally enabled, every `exec` call blocks waiting for human approval.

---

## Capabilities With No Clean Replacement Path

### ⚠️ Skills System Auto-Discovery

OpenClaw's skills system auto-discovers SKILL.md files from npm-installed packages and presents them in the system prompt. Vectra has no npm package ecosystem. **Mitigation:** Hard-code skill paths or implement a simple directory scanner. Skills are just markdown files — the discovery mechanism is simple, but the integration with the system prompt assembler needs careful design.

### ⚠️ Plugin Architecture (Extensibility)

OpenClaw supports runtime plugins (e.g., `atp-enforcement` loaded from local path). Vectra doesn't have a plugin system yet. **Mitigation:** ATP enforcement is already native to Vectra's scaffold. Other plugins (provider-specific) become native modules. The general extensibility story is deferred — build what's needed, not a framework.

### ⚠️ Node Management

OpenClaw's gateway manages connected nodes (companion apps, remote agents) with pairing, command deny lists, and tool routing. **Mitigation:** Not currently critical for the crew's operations. Defer to post-v1.0. If needed before then, keep OpenClaw's gateway running solely for node management (partial removal).

---

## Timeline Estimates

| Version | Estimated Effort | Cumulative |
|---|---|---|
| v0.2.0 Discord connector | 2-3 weeks | 2-3 weeks |
| v0.3.0 Session persistence | 1-2 weeks | 4-5 weeks |
| v0.4.0 Model dispatch | 1-2 weeks | 6-7 weeks |
| v0.5.0 Scheduler | 1 week | 7-8 weeks |
| v0.6.0 Context management | 2-3 weeks | 10-11 weeks |
| v0.7.0 Memory search | 2-3 weeks | 12-14 weeks |
| v0.8.0 Subagent orchestration | 2-3 weeks | 14-17 weeks |
| v0.9.0 Tool runtime + gateway | 2-3 weeks | 16-20 weeks |
| v1.0.0 Removal + burn-in | 1-2 weeks | 17-22 weeks |

**Total: ~4-5 months** from design approval to full OpenClaw removal.

**Captain-2 milestone: ~v0.8.0, approximately month 3-4.**

These are honest estimates assuming one agent working full-time. Parallelization (multiple agents on different modules) could compress the timeline but increases integration risk.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-08 | Design-only this cycle, no implementation | Need full audit before building |
| 2026-04-08 | SQLite for sessions (not file-based) | OpenClaw's 80MB JSON is a scaling problem |
| 2026-04-08 | Gateway proxy pattern for Captain-2 | Zero-gap failover worth the extra component |
| 2026-04-08 | Discord connector is v0.2.0 (first build) | Transport must exist before anything else matters |
| 2026-04-08 | Defer node management to post-v1.0 | Not critical for current crew operations |
