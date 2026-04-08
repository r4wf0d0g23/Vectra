# Scope Review — 2026-04-08

> T3 Validator: Claude Opus | Reviewed against: CONTRACT.md, ROADMAP.md, vectra.config.ts, job.ts, loader.ts, dispatcher.ts, registry.ts

---

## Framing Validation

### "Vectra is a general-purpose agentic harness. Reality Anchor is the first instance."

**NEEDS CORRECTION.** The framing is directionally correct but the current scaffold contradicts it in concrete ways. The *architecture* is generic — JobEnvelope, state machine, dispatcher, gates, telemetry — these are protocol-agnostic patterns that would work for any agent. But the *implementation* has Reality Anchor baked into type definitions, hardcoded protocol mappings, and default configurations. The scaffold is ~70% generic, ~30% instance-specific. The gap is closable but must be addressed deliberately before the framing becomes true.

### "Core harness is protocol-agnostic"

**INCOMPLETE.** The core *abstractions* are agnostic. The core *types* are not. `ProtocolId` in `job.ts` is a union literal type enumerating exactly 9 Reality Anchor protocols (`orchestration-main`, `openclaw-config-change`, `dgx-inference-ops`, `crew-ops`, `crew-peering`, `cradleos-deploy`, `memory-maintenance`, `atp-protocol-review`, `conversational`). Similarly, `TaskClass` is a fixed union of 7 Reality Anchor task families. A second operator would have to modify these type definitions to add their own protocols. This is the opposite of generic — it's a compiled-in protocol registry.

**Fix:** `ProtocolId` and `TaskClass` must become `string` (or `string & Brand`) at the harness level. The instance config (loaded from ATP) defines what protocol IDs and task classes exist. The harness validates against loaded data, not compiled types.

### "Build order: core → first instance boot → tune → Captain-2"

**VALID.** This sequence is sound and aligns with the ROADMAP's phased approach. No dependency inversion detected. One nuance: the ROADMAP's v0.2.0 (Discord connector) is transport-specific. The reframing should acknowledge that the core harness includes a *transport abstraction layer*, and Discord is the first *transport implementation* — same pattern as harness/instance.

### "Instance config = ATP protocols + var files + model assignments + channel credentials"

**INCOMPLETE.** ATP covers task routing, guardrails, tool allowlists, and verification policies. It does *not* cover:
- Transport configuration (Discord bot token, guild ID, channel mappings, requireMention settings)
- Infrastructure credentials (SSH keys, API tokens for model providers)
- Agent identity (SOUL.md, USER.md, IDENTITY.md — the persona layer)
- Operational parameters (heartbeat interval, compaction thresholds, cost ceiling)
- Agent topology (which agents exist, their capabilities, execution environments)

Instance config is: **ATP instance + transport config + identity files + secrets + operational tuning**. ATP is the largest piece, but not the whole picture.

### "`vectra init` scaffolds new instances"

**VALID as concept, INCOMPLETE as spec.** The command is the right abstraction. See detailed spec below.

---

## Hardcoded Reality Anchor Specifics (must be genericized)

### In `src/core/job.ts`

1. **`ProtocolId` type** — Union literal of 9 hardcoded protocol IDs (`orchestration-main`, `openclaw-config-change`, `dgx-inference-ops`, `crew-ops`, `crew-peering`, `cradleos-deploy`, `memory-maintenance`, `atp-protocol-review`, `conversational`). Must become `string`.

2. **`TaskClass` type** — Union literal of 7 hardcoded task families (`orchestration`, `config-ops`, `inference-ops`, `crew-comms`, `deploy-ops`, `memory-ops`, `conversational`). Must become `string`.

3. **`ToolName` type** — Union literal of 12 tools. Partially generic (read, write, exec are universal) but the fixed set prevents operators from registering custom tools. Should be `string` at the harness level with validation against a loaded tool registry.

### In `src/core/dispatcher.ts`

4. **`PROTOCOL_TASK_CLASS` mapping** — Hardcoded `Record<string, TaskClass>` mapping 9 Reality Anchor protocols to task classes. Must be loaded from ATP instance data, not compiled in.

### In `config/vectra.config.ts`

5. **`atpInstancePath`** — Default: `/home/agent-raw/.openclaw/workspace/atp-instance`. Absolute path to a specific machine.

6. **`checkpointPath`** — Default: `/home/agent-raw/.openclaw/workspace/vectra/checkpoints`. Same.

7. **`telemetryPath`** — Default: `/home/agent-raw/.openclaw/workspace/vectra/telemetry/events.jsonl`. Same.

8. **`opsChannel`** — Default: `agent:main:discord:channel:1475311507418910843`. Specific Discord channel ID.

9. **`upstreamBaseUrl`** — Default: `https://api.anthropic.com`. Assumes Anthropic as primary provider.

10. **`openclawGatewayUrl`** — Default: `http://localhost:18789`. Assumes local OpenClaw (acceptable as a default, but documents an OpenClaw dependency the harness is supposed to replace).

### In `CONTRACT.md`

11. **Mission statement** — "Vectra is the execution harness for Reality Anchor." Must be reframed to "Vectra is an execution harness. Reality Anchor is its first deployment."

12. **Task Classes table** — Lists 7 specific task families with specific ATP protocol bindings. Should be documented as "example task class configuration" rather than canonical harness specification.

13. **Execution Boundary table** — References specific infrastructure (Jetson1, DGX, Nav gateway URL, Tailscale). This is deployment documentation, not harness specification.

14. **Trust Model → Capability Boundary** — The tool classification (read-only, write-capable, destructive, privileged) is generic, but the specific tool→classification mapping is instance-specific.

### In `ROADMAP.md`

15. **Entire document** — Written as a migration plan from OpenClaw for the Reality Anchor deployment. This is valid as a *deployment roadmap* but should not be the *harness roadmap*. Recommend splitting: `ROADMAP.md` = generic harness milestones; `docs/reality-anchor-migration.md` = instance-specific migration plan.

**Total: 15 items requiring genericization.** Of these, items 1-4 are structural (require code changes), items 5-10 are configuration (require making defaults relative or removing them), and items 11-15 are documentation (require reframing).

---

## Build Order Assessment

The proposed sequence is correct. No reordering needed.

**Core harness → First instance boot → Tune → Captain-2** maps cleanly to:

| Reframing Phase | ROADMAP Versions | Status |
|---|---|---|
| Core harness | v0.1.0 (scaffold) + genericization fixes | v0.1.0 done, fixes needed |
| First instance boot | v0.2.0–v0.5.0 (Discord, sessions, model dispatch, scheduler) | Not started |
| Tune from live behavior | v0.6.0–v0.7.0 (context mgmt, memory search) | Not started |
| Captain-2 | v0.8.0+ (subagent orchestration + failover) | Not started |

**One dependency the reframing omits:** The core harness must include a *transport abstraction interface* before v0.2.0. Discord is a transport implementation. If the transport interface isn't designed first, the Discord connector will become tightly coupled to the harness internals — same mistake as baking Reality Anchor protocols into type definitions. Design the `Transport` interface as part of core harness; implement `DiscordTransport` as the first connector.

**Recommended addition to Phase 1:**

- v0.1.1 — Genericize types (ProtocolId → string, TaskClass → string, ToolName → string)
- v0.1.2 — Define Transport interface, Connector lifecycle (connect/disconnect/send/receive)
- v0.1.3 — Make config relative-path-aware, add `vectra init`
- v0.2.0 — Discord connector (implements Transport interface)

This prevents technical debt from compounding.

---

## Model Assignment Config Gap

The current `vectra.config.ts` has:

```typescript
modelClassAssignments: Record<ModelClass, string> = {
  fast: 'xai/grok-4-1-fast',
  agent: 'openai/gpt-5.4-mini',
  balanced: 'anthropic/claude-sonnet-4-6',
  capable: 'anthropic/claude-opus-4-6',
};
```

This maps *model classes* to *provider/model strings*. It does **not** map *roles* to model classes. The reframing asks for per-role assignment (`main-agent=Sonnet, T1=grok-4-1-fast, T2=Sonnet, T3=Opus`).

**What's needed:**

1. **Role→ModelClass mapping** (instance config, not harness):
```typescript
roleAssignments: Record<string, ModelClass> = {
  'main-agent': 'balanced',
  't1-scanner': 'fast',
  't2-watcher': 'balanced',
  't3-validator': 'capable',
  'heartbeat': 'fast',
  'subagent-default': 'fast',
};
```

2. **ModelClass→Provider mapping** (stays in harness config):
```typescript
modelClassAssignments: Record<ModelClass, string> // already exists
```

3. **Per-protocol model class override** (already exists in ATP routing entries via `model_class` field — this is correct).

The two-level indirection (role → class → provider) is the right design. The harness defines model classes as abstract tiers. The instance config maps roles to tiers. The operator maps tiers to concrete models. This is already *almost* right — just needs the role→class mapping added to the instance config layer.

**`ModelClass` itself should also become extensible** — the fixed `fast | agent | balanced | capable` enum works for Reality Anchor but other operators might want different tier names or counts. Recommend making it `string` with validation against a loaded config, same as ProtocolId.

---

## vectra init Spec

### What it scaffolds

```
my-instance/
├── vectra.instance.json      # Instance metadata + operational config
├── atp-instance/
│   ├── protocols/
│   │   └── conversational.md # Minimal default protocol
│   └── vars/
│       └── .gitkeep
├── identity/
│   ├── SOUL.md               # Agent persona (blank template)
│   ├── USER.md               # Operator profile (blank template)
│   └── IDENTITY.md           # Agent identity (blank template)
├── transports/
│   └── discord.json          # Transport config (empty, with schema comments)
├── secrets/
│   └── .env.example          # Template for required secrets
└── README.md                 # Getting started guide
```

### What it asks

Interactive prompts (all skippable with `--defaults`):

1. **Instance name** — Human-readable label (e.g., "Reality Anchor", "My Agent")
2. **Primary transport** — `discord` | `slack` | `none` (determines which transport config is scaffolded)
3. **Primary model provider** — `anthropic` | `openai` | `xai` | `vllm` | `other` (seeds model class assignments)
4. **ATP instance path** — Where to read/write protocols and vars (default: `./atp-instance`)
5. **Enable Captain-2 failover?** — y/n (adds checkpoint config if yes)

### What it produces

- A `vectra.instance.json` that Vectra reads at boot to locate all instance-specific resources
- Template files that the operator fills in
- A `.env.example` listing required secrets for the chosen transport and model provider
- A README explaining next steps

### What it does NOT do

- Does not create ATP protocols (operator writes those based on their workflows)
- Does not configure model provider auth (operator provides API keys)
- Does not start Vectra (operator runs `vectra start` after configuring)

---

## ATP as Instance Config — Assessment

**ATP covers ~60% of instance config.** Specifically:

| Config Domain | Covered by ATP? | Notes |
|---|---|---|
| Task routing (what triggers what) | ✅ Yes | Protocol routing entries |
| Guardrails per task | ✅ Yes | Protocol guardrails field |
| Tool allowlists per task | ✅ Yes | Protocol tool_allowlist field |
| Model class per task | ✅ Yes | Routing entry model_class field |
| Verification policies | ✅ Yes | Protocol checkpoint_policy / post_update |
| Operational state (last run, etc.) | ✅ Yes | Var files |
| **Transport config** | ❌ No | Bot tokens, channel mappings, guild settings |
| **Agent identity** | ❌ No | SOUL.md, USER.md, persona |
| **Model provider credentials** | ❌ No | API keys, base URLs |
| **Infrastructure access** | ❌ No | SSH keys, hostnames, Tailscale |
| **Operational tuning** | ❌ No | Heartbeat interval, compaction thresholds, cost ceiling |
| **Agent topology** | ❌ No | Which agents exist, their capabilities |
| **Role→ModelClass mapping** | ❌ No | Which roles use which tier |

**Recommendation:** Don't force non-ATP config into ATP's format. ATP is a protocol/workflow system — stretching it to cover transport config or credentials would be awkward. The instance config should be a *superset*: `vectra.instance.json` (operational + transport + identity pointers) + ATP instance (protocols + vars) + secrets (`.env`). Three layers, each in its natural format.

---

## Pre-v0.2.0 Decisions Required

### 1. Type genericization strategy
**Decision:** Do `ProtocolId`, `TaskClass`, `ToolName`, and `ModelClass` become plain `string`, or branded strings, or validated-at-load strings?

**Recommendation:** Plain `string` at the harness level. Type safety comes from runtime validation against loaded ATP data, not compiled types. Branded strings add complexity without benefit when the valid set is dynamic.

**Must decide before v0.2.0** because the Discord connector will create Jobs and bind protocols — if the types are still hardcoded, the connector will import and depend on them.

### 2. Transport interface contract
**Decision:** What does the `Transport` interface look like? What lifecycle methods does it expose? How does it interact with the intake gate?

**Recommendation:** Minimal interface:
```typescript
interface Transport {
  id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(channel: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
}
```

**Must decide before v0.2.0** because the Discord connector *is* a Transport implementation.

### 3. Instance config format and loading
**Decision:** How does Vectra discover and load instance config at boot? Single file? Multiple files? Environment variables?

**Recommendation:** `vectra.instance.json` as the root pointer (or `VECTRA_INSTANCE` env var pointing to a directory). Everything else is referenced from there. Vectra boot sequence: load instance config → load ATP data → load transport config → initialize.

**Must decide before v0.2.0** because the Discord connector needs transport config, and that config must come from *somewhere*.

### 4. CONTRACT.md split
**Decision:** Is CONTRACT.md the harness contract or the Reality Anchor deployment contract?

**Recommendation:** Split into:
- `CONTRACT.md` — Generic harness contract (job lifecycle, gate semantics, trust model framework, verification model)
- `instances/reality-anchor/CONTRACT.md` — Reality Anchor-specific contract (task classes, protocol bindings, execution boundaries, specific trust policies)

**Should decide before v0.2.0** for documentation clarity. Not a hard blocker.

### 5. OpenClaw dependency during build phase
**Decision:** The current scaffold has `openclawGatewayUrl` and `openclawGatewayToken` in config. When does Vectra stop depending on OpenClaw for tool execution?

**Recommendation:** Already addressed in ROADMAP (v0.9.0 replaces tool runtime). But the config interface should make this explicit: `toolRuntime: 'openclaw-proxy' | 'native'` so the transition point is a config change, not a code change.

**Must decide before v0.2.0** — the Discord connector needs to invoke tools (at minimum `exec` for some operations). Clarify whether tools still route through OpenClaw during early phases.

### 6. Checkpoint/state storage for Captain-2
**Decision:** Filesystem checkpoints (current design) vs. SQLite vs. replicated store?

**Recommendation:** Defer detailed design until v0.3.0 (session persistence). But the *interface* for checkpoint storage should be abstract from day one — `CheckpointStore` interface with a filesystem implementation initially. This prevents rework when Captain-2 needs replication.

**Should decide before v0.2.0** for interface design. Implementation can wait.

---

## Recommendation

**PROCEED — with a v0.1.x genericization pass before v0.2.0 begins.**

The reframing is architecturally sound. The separation of harness from instance is the correct design principle and already partially reflected in the scaffold. The build order is valid. The gaps identified (15 hardcoded specifics, missing transport interface, incomplete instance config model) are all fixable without architectural changes — they're refinements, not redesigns.

**Critical path:**
1. v0.1.1 — Genericize types (ProtocolId, TaskClass, ToolName, ModelClass → string)
2. v0.1.2 — Define Transport interface + instance config format
3. v0.1.3 — Implement `vectra init`, split CONTRACT.md
4. v0.2.0 — Discord connector (now building against clean abstractions)

**Risk if skipped:** If v0.2.0 starts without genericization, the Discord connector will depend on Reality Anchor-specific types. Every subsequent instance will require modifying harness source code to add their protocols — defeating the entire premise of the reframing. Do the genericization pass first. It's ~1-2 days of work that saves weeks of rework later.

**The framing is right. The scaffold needs to catch up to it.**
