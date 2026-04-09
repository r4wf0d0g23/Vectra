# Vectra — ATP-Native Agentic Execution Harness

## Quickstart

```bash
# Install
git clone https://github.com/r4wf0d0g23/Vectra
cd Vectra
npm install
npm run build
npm link  # makes 'vectra' command available globally

# Create your agent
vectra init

# Start
vectra start
```

Requirements:
- Node.js 18+
- A Discord bot token (create at https://discord.com/developers)
- At least one AI provider API key, or a vLLM endpoint


**Version:** 0.1.0 (scaffold)  
**Status:** Compiles, core types + state machine implemented, gates stubbed  
**Repo:** [github.com/r4wf0d0g23/Vectra](https://github.com/r4wf0d0g23/Vectra)

## What Is Vectra?

Vectra is the execution harness for Reality Anchor. It exists to answer one question: **what kinds of work should Reality Anchor be trusted to execute autonomously, and under what constraints?**

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

Vectra is a **transport interceptor** — a standalone process that sits between OpenClaw's wire layer and the model. OpenClaw handles transport (Discord/Signal in/out). Vectra owns everything in between.

```
Inbound message (Discord / Signal / HTTP)
  ↓
OpenClaw Transport (receive only — wire layer)
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
OpenClaw Transport (send response — wire layer)
```

### Integration Point

Vectra runs as an HTTP reverse proxy on a local port. OpenClaw's gateway is configured to route model requests through Vectra instead of directly to the LLM provider:

1. OpenClaw receives a message via transport (Discord, Signal, etc.)
2. OpenClaw's gateway sends the chat completion request to Vectra's proxy endpoint (instead of the LLM API directly)
3. Vectra's intake gate evaluates the request, dispatcher binds a protocol, context engine composes the bundle
4. Vectra forwards the enriched request to the actual model endpoint
5. Vectra's receipt gate validates the response before returning it to OpenClaw
6. OpenClaw sends the response back through transport

This is achieved by pointing OpenClaw's `agents.defaults.baseURL` (or per-model `baseURL`) at Vectra's proxy port. Vectra is **not** an OpenClaw plugin — it is a separate process that intercepts the model API path.

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

The ATP instance at `/home/agent-raw/.openclaw/workspace/atp-instance/` is Vectra's configuration source. Vectra never modifies ATP files — it reads and enforces them.

## Task Classes

| Task Class | ATP Protocol | Description |
|------------|-------------|-------------|
| Orchestration | `orchestration-main` | Route tasks, spawn sub-agents |
| Config Ops | `openclaw-config-change` | OpenClaw configuration |
| Inference Ops | `dgx-inference-ops` | DGX/vLLM management |
| Crew Comms | `crew-ops` / `crew-peering` | Inter-agent messaging |
| Deploy Ops | `cradleos-deploy` | CradleOS deployments |
| Memory Ops | `memory-maintenance` | Daily logs, MEMORY.md |
| Conversational | `conversational` | Context preload, fallback |

## Directory Structure

```
vectra/
  CONTRACT.md           # Mission document, trust model, stop conditions
  README.md             # This file
  src/
    core/
      job.ts            # Job envelope type definitions
      state-machine.ts  # State machine with legal transitions
      dispatcher.ts     # Protocol matching → job binding
      context.ts        # 5-layer context composition engine
      checkpoint.ts     # Durable checkpoint persistence
      registry.ts       # Agent capability registry
    gates/
      intake.ts         # Task admission + protocol match
      bundle.ts         # 6-rule bundle validation
      approval.ts       # Policy predicate approval gate
      receipt.ts        # Handoff artifact validation
    transport/
      proxy.ts          # HTTP reverse proxy (OpenClaw ↔ model interception point)
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
  schema/
    job.schema.json     # Job envelope JSON Schema
    receipt.schema.json # Handoff artifact JSON Schema
    telemetry.schema.json # Telemetry record JSON Schema
  config/
    vectra.config.ts    # Central configuration
  docs/
    atp-integration.md  # ATP integration specification
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

## Next Milestones

1. **Dispatcher + Context Engine** — Wire dispatch flow end-to-end
2. **Gate Layer** — Connect gates to state machine transitions
3. **Transport Proxy** — Wire Vectra as HTTP interceptor between OpenClaw gateway and model API (replaces atp-enforcement plugin)
4. **Captain-2 Failover** — Implement checkpoint-based active/standby
5. **Worker Integration** — Wire T1/T2/T3 to Vectra job lifecycle

## License

MIT
