# Vectra — Agentic Harness Contract

## Mission

Vectra is the execution harness for Reality Anchor. It makes ATP protocol compliance structural — not advisory. Every task that enters the system travels through Vectra's dispatch, context injection, verification, and receipt gate before any execution occurs.

Vectra answers one question: **what kinds of work should Reality Anchor be trusted to execute autonomously, and under what constraints?**

The harness owns job lifecycle, dispatch, context injection, verification, telemetry, and escalation. The model owns interpretation, planning, and choosing among allowed actions. This separation is absolute — the model never decides policy, and the harness never decides intent.

## Task Classes (Bounded Scope)

| # | Task Class | ATP Protocol | Description |
|---|------------|-------------|-------------|
| 1 | Orchestration | `orchestration-main` | Route tasks, assemble context bundles, spawn sub-agents |
| 2 | Config Ops | `openclaw-config-change` | OpenClaw config, gateway, plugin management |
| 3 | Inference Ops | `dgx-inference-ops` | DGX/vLLM container management, serve parameter changes |
| 4 | Crew Comms | `crew-ops` / `crew-peering` | Inter-agent messaging, Nav coordination, agent onboarding |
| 5 | Deploy Ops | `cradleos-deploy` | CradleOS Sui package publish, GitHub Pages deploys |
| 6 | Memory Ops | `memory-maintenance` | Daily logs, MEMORY.md promotion, soul review |
| 7 | Conversational | `conversational` | Context preload for Captain responses, fallback routing |

Any task that does not match one of these classes is held at intake and routed to T3 analysis. No unclassified task executes.

## Trust Model

### Identity Boundary

Tasks arrive from four source types, each with a defined trust level:

| Source | Trust Level | Admission Policy |
|--------|-------------|-----------------|
| Raw (human) | Highest | Direct admission, no policy gate |
| Scheduled cron | High | Must reference a registered protocol |
| Sub-agent completion event | Medium | Must carry a valid bundle_id tracing to a spawned job |
| Webhook / external event | Lowest | Requires policy match before admission; unmatched webhooks are dropped |

### Capability Boundary

Tools are classified by impact level, mapped from ATP protocol `tool_allowlist` fields:

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
| DGX SSH (`rawdata@100.78.161.126`) | Via SSH key | Only inference-ops and deploy-ops protocols |
| GitHub API (`gh` CLI) | Via auth token | PR/issue/deploy operations per protocol |
| OpenClaw gateway API | Local or Tailscale | Config reads always; writes require config-change protocol |
| Nav gateway (`$NAV_GATEWAY_URL`) | Via bearer token | Crew-ops and crew-peering protocols only |

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

### Recovery Boundary

| Failure Mode | Strategy |
|-------------|----------|
| Transient failure (network timeout, 5xx) | Retry once with same bundle |
| Verification failure (receipt invalid) | T3 analysis before retry |
| Auth failure (401/403, SSH denied) | Escalate immediately, do not retry |
| Partial side effect (deploy started, not completed) | Run compensation strategy before retry |
| Timeout (job exceeds budget) | Checkpoint current state, surface to T3 |
| Recursion depth exceeded | Hard stop, surface full job chain to human |

## Autonomy Level

**Level 4** — Bounded autonomous execution within protocol-scoped constraints.

- Vectra dispatches jobs, injects context, and verifies results without human involvement for matched protocols
- The model plans and executes within the tool allowlist and guardrails defined by the matched protocol
- Escalation to human occurs on policy violation, unmatched patterns, or recovery boundary triggers

**Level 5** — Scheduled/event-driven execution for cron tasks.

- T1 scanner, T2 watcher, and scheduled memory maintenance run autonomously
- Results are logged and violations surface through the escalation path
- No human prompt required to initiate

## Captain-2 Redundancy

Vectra supports active/standby failover as a first-class design concern:

- **Active Captain** holds the job state machine and dispatch authority
- **Standby Captain** receives checkpoint snapshots and can resume from last checkpoint
- **Failover trigger:** Active heartbeat missed for 3 consecutive intervals
- **State transfer:** Via checkpoint files in `vectra/checkpoints/` (shared filesystem or sync)
- **Split-brain prevention:** Only the node holding the dispatch lock can transition jobs past `admitted` state

## Stop Conditions

Vectra immediately halts job execution when any of these conditions are detected:

1. Credential exposure detected in any tool output (regex scan on all exec/read results)
2. Recursion depth exceeds 3 sub-agents in a single job chain
3. Cumulative cost exceeds $5 in a single task chain without an intermediate receipt
4. Any tool call targeting production without a verified standby state
5. Job state machine enters an illegal transition (indicates harness corruption)
6. ATP instance directory becomes unreadable (filesystem failure)

On halt: checkpoint current state, emit `job.halted` telemetry event, surface to human via ops channel.

## Success Conditions

A job is considered successfully complete when ALL of the following are true:

1. Job state machine reaches `completed` state through legal transitions only
2. A handoff artifact exists in `atp-instance/artifacts/` matching the job's `bundle_id`
3. The artifact passes receipt gate validation (all required fields present, schema-valid)
4. Any var files referenced in the protocol's `post_update` list are updated with post-task state
5. A telemetry record has been emitted for every state transition in the job's lifecycle
6. No stop conditions were triggered during execution
