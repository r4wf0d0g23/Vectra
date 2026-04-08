# Vectra — Agentic Harness Contract

## Mission

Vectra is an execution harness for ATP-governed agents. It makes ATP protocol compliance structural — not advisory. Every task that enters Vectra travels through intake, dispatch, context injection, verification, and receipt gate before any execution occurs.

Vectra answers one question: **what kinds of work should an agent be trusted to execute autonomously, and under what constraints?**

The harness owns job lifecycle, dispatch, context injection, verification, telemetry, and escalation. The model owns interpretation, planning, and choosing among allowed actions. This separation is absolute — the model never decides policy, and the harness never decides intent.

> **Instance vs. Harness:** This document describes the generic harness contract. For deployment-specific task classes, trust boundaries, protocol bindings, and execution environments, see the instance contract in `docs/instance-example-reality-anchor.md` (or your own `instances/<name>/CONTRACT.md`).

## Integration Architecture

Vectra is a **standalone transport interceptor**, not an OpenClaw plugin. It runs as a separate process that sits in the HTTP path between a gateway and the LLM provider.

```
Gateway (receives message from transport)
  → POST /v1/chat/completions to Vectra proxy (localhost:VECTRA_PORT)
    → Vectra intake gate → dispatcher → context engine → approval gate
    → POST /v1/chat/completions to actual model API (OpenAI/Anthropic/xAI/etc.)
    → Vectra receipt gate → telemetry
  ← Response returned to gateway
← Gateway sends response via transport
```

Vectra exposes an OpenAI-compatible HTTP API (`/v1/chat/completions`). The gateway is configured to use Vectra's port as its model `baseURL`. Vectra forwards enriched requests to the actual model provider.

This design means Vectra can be developed, tested, and deployed independently of any specific gateway or transport.

## Task Classes (Framework)

Task classes are defined by the instance's ATP configuration — not by the harness. The harness dispatches to whatever task classes the loaded ATP data defines.

At runtime, the dispatcher resolves an inbound protocol ID to a task class using the `protocolTaskClassMap` supplied from instance config (loaded from ATP routing entries or `vectra.instance.json`). Unknown protocol IDs fall back to `'conversational'`.

**Example task classes** (Reality Anchor instance):

| Task Class | Description |
|------------|-------------|
| `orchestration` | Route tasks, assemble context bundles, spawn sub-agents |
| `config-ops` | Config reads and writes |
| `crew-comms` | Inter-agent messaging and coordination |
| `deploy-ops` | Deployment operations |
| `memory-ops` | Memory and log maintenance |
| `conversational` | Context preload, fallback routing |

See `docs/instance-example-reality-anchor.md` for Reality Anchor's full task class and protocol binding table.

## Trust Model

### Identity Boundary

Tasks arrive from four source types, each with a defined trust level:

| Source | Trust Level | Admission Policy |
|--------|-------------|-----------------|
| Human operator | Highest | Direct admission, no policy gate |
| Scheduled cron | High | Must reference a registered protocol |
| Sub-agent completion event | Medium | Must carry a valid bundle_id tracing to a spawned job |
| Webhook / external event | Lowest | Requires policy match before admission; unmatched webhooks are dropped |

### Capability Boundary

Tools are classified by impact level, mapped from ATP protocol `tool_allowlist` fields. The specific tool-to-classification mapping is instance-defined; the policy semantics are harness-defined:

| Classification | Policy |
|---------------|--------|
| Read-only | Auto-approve in all contexts |
| Write-capable | Auto-approve within matched protocol scope |
| Destructive | Require approval gate unless protocol explicitly authorizes |
| Privileged | Never auto-execute; require T3 analysis or human confirmation |

### Approval Boundary

**Auto-execute (no gate):**
- In-boundary T2 auto-corrections (single var field, deterministic, idempotent)
- Memory writes (daily logs, log updates)
- Read-only operations (file reads, status checks, health probes)
- Conversational context preload

**Require T3 analysis:**
- Out-of-boundary values detected in var files
- Unmatched protocol patterns (task held at intake)
- Model class escalation beyond protocol spec
- Tool calls outside protocol's `tool_allowlist`

**Never auto-execute:**
- Credential changes (tokens, keys, passwords)
- Production deploys without a verified standby state
- Any action targeting external messaging surfaces without an explicit protocol authorizing it

### Recovery Boundary

| Failure Mode | Strategy |
|-------------|----------|
| Transient failure (network timeout, 5xx) | Retry once with same bundle |
| Verification failure (receipt invalid) | T3 analysis before retry |
| Auth failure (401/403) | Escalate immediately, do not retry |
| Partial side effect | Run compensation strategy before retry |
| Timeout (job exceeds budget) | Checkpoint current state, surface to T3 |
| Recursion depth exceeded | Hard stop, surface full job chain to human |

## Autonomy Levels

**Level 4** — Bounded autonomous execution within protocol-scoped constraints.

- Vectra dispatches jobs, injects context, and verifies results without human involvement for matched protocols
- The model plans and executes within the tool allowlist and guardrails defined by the matched protocol
- Escalation to human occurs on policy violation, unmatched patterns, or recovery boundary triggers

**Level 5** — Scheduled/event-driven execution for cron tasks.

- T1 scanner, T2 watcher, and scheduled tasks run autonomously
- Results are logged and violations surface through the escalation path
- No human prompt required to initiate

## Captain-2 Redundancy

Vectra supports active/standby failover as a first-class design concern:

- **Active Captain** holds the job state machine and dispatch authority
- **Standby Captain** receives checkpoint snapshots and can resume from last checkpoint
- **Failover trigger:** Active heartbeat missed for N consecutive intervals (configurable)
- **State transfer:** Via checkpoint files (shared filesystem or sync)
- **Split-brain prevention:** Only the node holding the dispatch lock can transition jobs past `admitted` state

## Stop Conditions

Vectra immediately halts job execution when any of these conditions are detected:

1. Credential exposure detected in any tool output (regex scan on all exec/read results)
2. Recursion depth exceeds the configured `maxRecursionDepth`
3. Cumulative cost exceeds `costCeiling` in a single task chain without an intermediate receipt
4. Job state machine enters an illegal transition (indicates harness corruption)
5. ATP instance directory becomes unreadable (filesystem failure)

Instance configs may add stop conditions via ATP guardrails. On halt: checkpoint current state, emit `job.halted` telemetry event, surface to operator via ops channel.

## Success Conditions

A job is considered successfully complete when ALL of the following are true:

1. Job state machine reaches `completed` state through legal transitions only
2. A handoff artifact exists in the configured artifacts path matching the job's `bundle_id`
3. The artifact passes receipt gate validation (all required fields present, schema-valid)
4. Any var files referenced in the protocol's `post_update` list are updated with post-task state
5. A telemetry record has been emitted for every state transition in the job's lifecycle
6. No stop conditions were triggered during execution
