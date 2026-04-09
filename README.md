# Vectra — ATP-Native Agentic Execution Harness

**Version:** 0.1.1 (genericization pass)  
**Status:** Compiles, core types + state machine implemented, gates stubbed  
**Repo:** [github.com/r4wf0d0g23/Vectra](https://github.com/r4wf0d0g23/Vectra)

## What Is Vectra?

Vectra is a **generic execution harness for ATP-governed agents**. It enforces ATP protocol compliance structurally rather than advisorily — any agent with an ATP instance can deploy Vectra to enforce dispatch, context injection, verification, and receipt validation.

**Reality Anchor is Vectra's first instance.** The design pattern is: harness is generic, instance is specific. A second operator with a completely different protocol set would create their own `vectra.instance.json` and ATP directory — no harness source code changes required.

Where ATP (Agent Task Protocol) defines *what* protocols govern agent behavior, Vectra *enforces* those protocols structurally. The difference:

| Aspect | ATP alone | ATP + Vectra |
|--------|-----------|-------------|
| Protocol compliance | Prompt-injected, advisory | Code-enforced, structural |
| Task routing | Agent reads dispatch table, routes itself | Harness matches, validates, routes |
| Context assembly | Agent loads vars it thinks it needs | Harness composes exact context layers |
| Verification | Agent writes receipt, hopes T2 checks | Receipt gate blocks completion without valid artifact |
| Approval gates | Model decides if it needs permission | Policy predicates evaluate automatically |
| State machine | Implicit (in agent's head) | Explicit, logged, with illegal-transition halts |
| Failover | None | Captain-2 active/standby via checkpoints |

## Architecture

Vectra is a **transport interceptor** — a standalone process that sits between a gateway and the model. The gateway handles transport (Discord/Signal in/out). Vectra owns everything in between.

```
Inbound message (Discord / Signal / HTTP)
  ↓
Gateway Transport (receive only — wire layer)
  ↓
┌─────────────────────────────────────────────┐
│            VECTRA HARNESS (proxy)            │
│                                             │
│  ┌─────────────────────┐                    │
│  │   Intake Gate       │  Pattern match     │
│  ├─────────────────────┤                    │
│  │   Dispatcher        │  Protocol binding  │
│  ├─────────────────────┤                    │
│  │   Context Engine    │  5-layer compose   │
│  ├─────────────────────┤                    │
│  │   Bundle Validator  │  6-rule validation │
│  ├─────────────────────┤                    │
│  │   Approval Gate     │  Policy predicates │
│  ├─────────────────────┤                    │
│  │   State Machine     │  Job lifecycle     │
│  └─────────────────────┘                    │
│              ↓                              │
│        Model (plans + executes)             │
│              ↓                              │
│  ┌─────────────────────┐                    │
│  │   Receipt Gate      │  Artifact verify   │
│  ├─────────────────────┤                    │
│  │   Telemetry         │  JSONL events      │
│  └─────────────────────┘                    │
└─────────────────────────────────────────────┘
  ↓
Gateway Transport (send response — wire layer)
```

### Integration Point

Vectra runs as an HTTP reverse proxy on a local port. The gateway is configured to route model requests through Vectra instead of directly to the LLM provider:

1. Gateway receives a message via transport (Discord, Signal, etc.)
2. Gateway sends the chat completion request to Vectra's proxy endpoint (instead of the LLM API directly)
3. Vectra's intake gate evaluates the request, dispatcher binds a protocol, context engine composes the bundle
4. Vectra forwards the enriched request to the actual model endpoint
5. Vectra's receipt gate validates the response before returning it to the gateway
6. Gateway sends the response back through transport

This is achieved by pointing the gateway's `agents.defaults.baseURL` at Vectra's proxy port. Vectra is **not** a gateway plugin — it is a separate process that intercepts the model API path.

## Instance Configuration

Vectra is configured by two things:

1. **`vectra.instance.json`** — instance metadata, model assignments, transport config, operational tuning
2. **ATP instance directory** — protocols, vars, routing tables (the bulk of behavioral config)

The instance config schema is at `schema/instance.schema.json`. The Reality Anchor instance config is at `instances/reality-anchor.instance.json`.

To configure Vectra for a new instance, create a `vectra.instance.json` matching the schema and point `atpPath` at your ATP instance directory. No harness source code changes are required.

### Environment Variables

Minimal configuration via environment variables (for when instance config is not used):

| Variable | Purpose |
|----------|---------|
| `VECTRA_ATP_PATH` | Path to ATP instance directory |
| `VECTRA_CHECKPOINT_PATH` | Path to checkpoint storage |
| `VECTRA_TELEMETRY_PATH` | Path for telemetry JSONL output |
| `VECTRA_OPS_CHANNEL` | Transport channel ID for escalations |
| `VECTRA_UPSTREAM_URL` | Upstream LLM provider base URL |
| `VECTRA_OPENCLAW_URL` | OpenClaw gateway URL (default: localhost:18789) |
| `VECTRA_OPENCLAW_TOKEN` | OpenClaw gateway auth token |
| `VECTRA_INSTANCE` | Path to vectra.instance.json |

## Relationship to ATP

Vectra is the runtime enforcement layer for an ATP instance. It:

1. **Loads** the ATP instance (protocols, vars, routing table) at startup
2. **Watches** for changes and hot-reloads
3. **Matches** incoming tasks against the dispatch table
4. **Assembles** context bundles from var files with staleness-aware loading
5. **Validates** bundles against the 6-rule schema
6. **Enforces** approval gates as code predicates
7. **Manages** job state through an explicit state machine
8. **Verifies** completion via receipt gate
9. **Emits** telemetry for every lifecycle event

ATP covers ~60% of instance configuration (task routing, guardrails, tool allowlists, model class per task, verification policies, operational state). The remaining 40% — transport config, model provider credentials, agent identity, operational tuning, and agent topology — is covered by `vectra.instance.json`.

## Task Classes

Task classes are defined by each instance's ATP configuration. The harness dispatches to whatever task classes the loaded ATP data defines. The `protocolTaskClassMap` (mapping protocol IDs to task class strings) is loaded from instance config at boot, not compiled into the harness.

**Example (Reality Anchor instance):**

| Task Class | ATP Protocol | Description |
|------------|-------------|-------------|
| `orchestration` | `orchestration-main` | Route tasks, spawn sub-agents |
| `config-ops` | `openclaw-config-change` | OpenClaw configuration |
| `inference-ops` | `dgx-inference-ops` | DGX/vLLM management |
| `crew-comms` | `crew-ops` / `crew-peering` | Inter-agent messaging |
| `deploy-ops` | `cradleos-deploy` | CradleOS deployments |
| `memory-ops` | `memory-maintenance` | Daily logs, MEMORY.md |
| `conversational` | `conversational` | Context preload, fallback |

See `docs/instance-example-reality-anchor.md` for full Reality Anchor instance contract.

## Transport Abstraction

Every transport connector implements `TransportConnector` from `src/transport/interface.ts`. The harness core never imports Discord, Signal, or any platform-specific code — it only depends on `InboundMessage` and `OutboundMessage` types.

**First connector:** Discord (`src/transport/discord.ts`) — v0.2.0 milestone.

## Directory Structure

```
vectra/
  CONTRACT.md           # Generic harness contract (mission, trust model, stop conditions)
  README.md             # This file
  instances/
    reality-anchor.instance.json  # Reality Anchor instance config
  schema/
    instance.schema.json  # vectra.instance.json schema
    job.schema.json       # Job envelope JSON Schema
    receipt.schema.json   # Handoff artifact JSON Schema
    telemetry.schema.json # Telemetry record JSON Schema
  src/
    core/
      job.ts            # Job envelope type definitions (generic string types)
      state-machine.ts  # State machine with legal transitions
      dispatcher.ts     # Protocol matching → job binding (runtime-loaded map)
      context.ts        # 5-layer context composition engine
      checkpoint.ts     # Durable checkpoint persistence
      registry.ts       # Agent capability registry
    gates/
      intake.ts         # Task admission + protocol match
      bundle.ts         # 6-rule bundle validation
      approval.ts       # Policy predicate approval gate
      receipt.ts        # Handoff artifact validation
    transport/
      interface.ts      # TransportConnector + TransportFactory interfaces
      proxy.ts          # HTTP reverse proxy (gateway ↔ model interception point)
    telemetry/
      emitter.ts        # JSONL structured event emitter
      counters.ts       # Session-level aggregate counters
    workers/
      t1-scanner.ts     # Periodic drift scanner
      t2-watcher.ts     # Event-driven correction applier
      t3-validator.ts   # Deep reasoning validator
    atp/
      loader.ts         # ATP instance loader + hot-reload
      matcher.ts        # Dispatch table pattern matcher
      bundle-assembler.ts # Var file → context source assembler
  config/
    vectra.config.ts    # Central configuration (no hardcoded instance specifics)
  docs/
    atp-integration.md  # ATP integration specification
    instance-example-reality-anchor.md  # Reality Anchor instance contract
```

## Quick Start

```bash
# Install dependencies
npm install

# Type-check
npm run check

# Build
npm run build
```

## Version History

- **v0.1.0** — Initial scaffold: core types, state machine, dispatcher, gates stubbed
- **v0.1.1** — Genericization pass: ProtocolId/TaskClass/ToolName/ModelClass → `string`; PROTOCOL_TASK_CLASS runtime-loaded; hardcoded paths/channels/providers removed; CONTRACT.md split; instance schema + transport interface added

## Next Milestones

1. **v0.2.0 — Discord connector** — Implement `DiscordTransport` against `TransportConnector` interface
2. **v0.3.0 — Session persistence** — Wire gate layer to state machine transitions
3. **v0.4.0 — Model dispatch** — Wire dispatcher to actual model API calls
4. **v0.5.0 — Scheduler** — T1/T2/T3 workers running against live job lifecycle
5. **v0.8.0+ — Captain-2** — Active/standby failover via checkpoint replication

## License

MIT
