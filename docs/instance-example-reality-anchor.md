# Reality Anchor — Instance Contract

> This document is the Reality Anchor deployment-specific contract for Vectra.
> It supplements the generic harness contract in `CONTRACT.md` with instance-specific
> task classes, protocol bindings, trust boundaries, and execution environment details.

## Instance Identity

- **Instance ID:** `reality-anchor`
- **Instance config:** `instances/reality-anchor.instance.json`
- **ATP path:** `/home/agent-raw/.openclaw/workspace/atp-instance`
- **Transport:** Discord (guild `1474992745004142822`)
- **Autonomy level:** 4 (bounded autonomous)

## Mission

Vectra is the execution harness for Reality Anchor. It makes ATP protocol compliance structural — not advisory. Every task that enters the system travels through Vectra's dispatch, context injection, verification, and receipt gate before any execution occurs.

Vectra answers one question: **what kinds of work should Reality Anchor be trusted to execute autonomously, and under what constraints?**

## Integration Architecture (Reality Anchor Deployment)

```
OpenClaw Gateway (receives message from Discord/Signal)
  → POST /v1/chat/completions to Vectra proxy (localhost:VECTRA_PORT)
    → Vectra intake gate → dispatcher → context engine → approval gate
    → POST /v1/chat/completions to actual model API (OpenAI/Anthropic/xAI)
    → Vectra receipt gate → telemetry
  ← Response returned to OpenClaw gateway
← OpenClaw sends response via transport
```

OpenClaw exposes an OpenAI-compatible HTTP API (`/v1/chat/completions`). Vectra proxies that same interface:

- **Vectra listens** on a local port, exposing `/v1/chat/completions`
- **OpenClaw is configured** to use Vectra's port as its model `baseURL`
- **Vectra forwards** enriched requests to the actual model provider
- **The `atp-enforcement` plugin becomes obsolete** once Vectra is wired — it is removed, not layered on top

## Task Classes

| # | Task Class | ATP Protocol | Description |
|---|------------|-------------|-------------|
| 1 | `orchestration` | `orchestration-main` | Route tasks, assemble context bundles, spawn sub-agents |
| 2 | `config-ops` | `openclaw-config-change` | OpenClaw config, gateway, plugin management |
| 3 | `inference-ops` | `dgx-inference-ops` | DGX/vLLM container management, serve parameter changes |
| 4 | `crew-comms` | `crew-ops` / `crew-peering` | Inter-agent messaging, Nav coordination, agent onboarding |
| 5 | `deploy-ops` | `cradleos-deploy` | CradleOS Sui package publish, GitHub Pages deploys |
| 6 | `memory-ops` | `memory-maintenance` | Daily logs, MEMORY.md promotion, soul review |
| 7 | `conversational` | `conversational` | Context preload for Captain responses, fallback routing |

Any task that does not match one of these classes is held at intake and routed to T3 analysis. No unclassified task executes.

### Protocol-to-TaskClass Map (for Dispatcher)

This is the `protocolTaskClassMap` passed to the Dispatcher at instance boot:

```json
{
  "orchestration-main":    "orchestration",
  "openclaw-config-change": "config-ops",
  "dgx-inference-ops":     "inference-ops",
  "crew-ops":              "crew-comms",
  "crew-peering":          "crew-comms",
  "cradleos-deploy":       "deploy-ops",
  "memory-maintenance":    "memory-ops",
  "atp-protocol-review":   "orchestration",
  "conversational":        "conversational"
}
```

## Trust Model

### Identity Boundary

Tasks arrive from four source types, each with a defined trust level:

| Source | Trust Level | Admission Policy |
|--------|-------------|-----------------|
| Raw (human) | Highest | Direct admission, no policy gate |
| Scheduled cron | High | Must reference a registered protocol |
| Sub-agent completion event | Medium | Must carry a valid bundle_id tracing to a spawned job |
| Webhook / external event | Lowest | Requires policy match before admission; unmatched webhooks are dropped |

### Capability Boundary (Reality Anchor Tool Classifications)

| Classification | Tools | Policy |
|---------------|-------|--------|
| Read-only | `read`, `memory_search`, `memory_get`, `web_search`, `web_fetch` | Auto-approve in all contexts |
| Write-capable | `write`, `edit`, `exec` (non-destructive) | Auto-approve within matched protocol scope |
| Destructive | `exec` (rm, restart, deploy), `message` (external send) | Require approval gate unless protocol explicitly authorizes |
| Privileged | SSH to DGX, gateway restart, credential rotation | Never auto-execute; require T3 analysis or human confirmation |

### Execution Boundary

| Environment | Access | Constraints |
|------------|--------|-------------|
| Local Jetson1 shell | Direct | All protocol-scoped commands permitted |
| DGX SSH (`rawdata@100.78.161.126`) | Via SSH key | Only `inference-ops` and `deploy-ops` protocols |
| GitHub API (`gh` CLI) | Via auth token | PR/issue/deploy operations per protocol |
| OpenClaw gateway API | Local or Tailscale | Config reads always; writes require `config-change` protocol |
| Nav gateway (`$NAV_GATEWAY_URL`) | Via bearer token | `crew-ops` and `crew-peering` protocols only |

No arbitrary network egress without policy match. All outbound connections must trace to a protocol's execution boundary.

### Approval Boundary

**Auto-execute (no gate):**
- In-boundary T2 auto-corrections (single var field, deterministic, idempotent)
- Memory writes (daily logs, MEMORY.md updates)
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
- Gateway restart without confirming no active conversation turn
- Any action targeting external messaging surfaces (emails, tweets, Discord sends to non-ops channels)

## Stop Conditions (Reality Anchor)

In addition to harness-level stop conditions, Reality Anchor adds:

1. Credential exposure detected in any tool output (regex scan on all exec/read results)
2. Recursion depth exceeds 3 sub-agents in a single job chain
3. Cumulative cost exceeds $5 in a single task chain without an intermediate receipt
4. Any tool call targeting production without a verified standby state

On halt: checkpoint current state, emit `job.halted` telemetry event, surface to Raw via ops channel (`1475311507418910843`).
