# Vectra ↔ ATP Integration Specification

## Overview

Vectra reads the ATP instance at `/home/agent-raw/.openclaw/workspace/atp-instance/` as its configuration source. This document specifies exactly how each Vectra subsystem maps to ATP constructs.

## 1. Dispatcher → ATP Orchestration-Main Dispatch Table

### Source
The dispatch table lives in `protocols/orchestration-main.md` under the `routing:` frontmatter key. Each entry defines:
- `task_pattern` — substring patterns separated by ` / `
- `execution_protocol` — the ATP protocol ID to execute
- `var_ids` — var files to include in the context bundle
- `model_class` — compute tier (fast/agent/balanced/capable)
- `tool_allowlist` — tools the sub-agent may use
- `priority` — routing priority (higher wins on tie)

### Vectra's Matcher
`src/atp/matcher.ts` implements `AtpDispatchMatcher` which:

1. **Loads** the routing table from `AtpLoader.getData().routingTable`
2. **Normalizes** the task description (lowercase, strip punctuation, collapse whitespace)
3. **Splits** each `task_pattern` by ` / ` into individual terms
4. **Checks** each term as a multi-word substring match against the normalized task
5. **Scores** by priority (from frontmatter) × 1000 + specificity (matched term count)
6. **Returns** all matches sorted by score descending

The wildcard `*` pattern (used by `conversational`) matches everything with specificity 0 and priority 0, ensuring it's always the fallback.

### Differences from ATP_HOOK.md
The current ATP_HOOK.md dispatch is prompt-enforced — the agent reads the table and routes itself. Vectra's dispatcher is code — the agent never sees the table. The harness matches, validates, and binds the protocol before the model runs.

## 2. Context Engine → ATP Vars (Staleness Policies)

### Staleness Policies
Each ATP var file declares a `staleness_policy` in its frontmatter. Vectra's `BundleAssembler` maps these to freshness strategies:

| ATP Policy | Vectra Strategy | Behavior |
|-----------|----------------|----------|
| `always-verify` | JIT | Run `verify_cmd` at load time (future: exec integration) |
| `session-cache` | Session-cache | Load once per session, serve from cache |
| `ttl:Xd` | TTL | Load from file, rely on file watcher for refresh |
| `on-change-only` | Static | Load from file, no refresh |

### Loading Flow
1. Dispatcher determines `varIds` from the matched routing entry
2. `BundleAssembler.assembleVarSources(varIds)` creates `ContextSource` objects
3. `ContextEngine.compose(job, sources)` loads sources within budget limits
4. Content is placed in the `working` context layer
5. Protocol definition and guardrails go in the `static` layer
6. Task description goes in the `task` layer

### Budget Enforcement
The context engine enforces token budgets per layer:
- Static: 8,000 tokens (protocol + guardrails)
- Task: 4,000 tokens (description + objectives)
- Working: 12,000 tokens (var files)
- Persistent: 4,000 tokens (checkpoints)
- Retrieval: 4,000 tokens (memory/web results)

Sources that would exceed their layer budget are skipped with a truncation notice. This prevents context bloat that the current prompt-based system cannot guard against.

### Var Registry (from ATP_HOOK.md)
| Var ID | Staleness Policy | Validator | Used By Protocols |
|--------|-----------------|-----------|-------------------|
| `openclaw-config-state` | `session-cache` | `json-config` | openclaw-config-change |
| `dgx-serve` | `always-verify` | `ssh-command` | dgx-inference-ops |
| `model-registry` | `ttl:7d` | `json-config` | dgx-inference-ops, orchestration-main |
| `crew-state` | `session-cache` | `ssh-command` | crew-ops, crew-peering, orchestration-main, conversational |
| `cradleos-pkg` | `ttl:7d` | `package-id` | cradleos-deploy |
| `worker-config` | `on-change-only` | `json-config` | (internal to workers) |
| `conversational-context` | `session-cache` | — | conversational |

## 3. Receipt Gate → ATP Handoff Artifact Requirements

### Source
The receipt schema comes from ATP's `lib/execution-receipt/SPEC.md`. Required fields:
- `bundle_id` — links receipt to spawned job
- `protocol_id` — which protocol governed execution
- `completed_at` — ISO 8601 completion timestamp
- `changes` — non-empty array of change descriptions
- `var_updates` — array of var file modifications
- `next_action` — recommended follow-up
- `state_after` — post-execution state snapshot

### Vectra's Receipt Gate
`src/gates/receipt.ts` implements `ReceiptGate` which:

1. Scans `atp-instance/artifacts/` for a JSON file containing the matching `bundle_id`
2. Validates all 7 required fields are present and non-null
3. Validates `changes` is a non-empty array
4. Validates `completed_at` is a non-empty string
5. Returns a `ReceiptValidationResult` with severity:
   - `missing` — no artifact file found
   - `incomplete` — artifact exists but fields missing
   - `invalid` — fields present but wrong type/empty

### What Vectra Adds
The current T2 receipt scan is prompt-instructed. Vectra's receipt gate is a state machine transition guard — the job **cannot** transition from `verifying` to `completed` without a valid receipt. This is structural, not advisory.

### Manifest Tracking
Before any sub-agent spawn, Vectra writes to `atp-instance/artifacts/manifest.json`:
```json
{
  "spawned": [{
    "bundle_id": "...",
    "protocol_id": "...",
    "spawned_at": "...",
    "receipt_expected": true,
    "receipt_verified": false
  }]
}
```
T2 sets `receipt_verified: true` after the receipt gate passes.

## 4. T1/T2/T3 Workers → ATP Workers Lib

### ATP Worker Spec
`atp/lib/workers/SPEC.md` defines three tiers:

| ATP Tier | Vectra Worker | Model Class | Trigger | Primary Output |
|----------|--------------|-------------|---------|---------------|
| T1 — Scheduled Scanner | `t1-scanner.ts` | `agent` | Cron daily 3am CT | PRs + reports |
| T2 — Event Watcher | `t2-watcher.ts` | `fast` | Sub-agent complete / PR event | Receipt validation, auto-corrections |
| T3 — Deep Validator | `t3-validator.ts` | `capable` | PR opened, intake holds | PR reviews, cleansed reports |

### Authorization (from ATP workers SPEC)
| Action | T1 | T2 | T3 |
|--------|----|----|-----|
| Read any ATP file | ✅ | ✅ | ✅ |
| Write to `/reports` | ✅ | ✅ | ✅ |
| Update `last_verified` in vars | ✅ | ❌ | ✅ |
| Open GitHub PR | ✅ | ✅ | ❌ |
| Approve GitHub PR | ❌ | ❌ | ✅ |
| Direct commit to main | ❌ | ❌ | ❌ |

### Vectra Integration
In Vectra, workers become first-class jobs that flow through the same state machine:
1. Worker triggers create a `JobEnvelope` with `source: 'cron'` (T1/T3) or `source: 'subagent-completion'` (T2)
2. The job goes through intake (T1/T3 match `atp-protocol-review`, T2 matches the protocol of the completed job)
3. Workers have restricted `toolAllowlist` matching the authorization table
4. Worker output (PRs, reports, corrections) becomes the handoff artifact

This means workers are subject to the same gates, budget limits, and telemetry as any other job.

## 5. What Vectra Adds Beyond ATP Specs

### State Machine (not in ATP)
ATP defines what should happen. Vectra enforces the order with a state machine:
- Illegal transitions trigger immediate halt
- Every transition is logged to telemetry
- The model cannot skip states (e.g., jump from `queued` to `executing`)

### Approval Gates as Code (not in ATP)
ATP has guardrails as text strings. Vectra implements them as predicate functions:
- `webhookSourcePredicate` — webhooks always require T3 analysis
- `credentialPredicate` — credential tasks always require human approval
- `productionDeployPredicate` — production deploys require human approval
- `recursionDepthPredicate` — deep recursion requires T3 analysis
- `externalMessagePredicate` — external messages require human approval

These are not suggestions — they block the job at the `blocked` state until the approval policy is satisfied.

### Compensation Layer (not in ATP)
When a job fails with partial side effects, ATP says "escalate." Vectra implements a recovery boundary:
- Transient failures → retry once with same bundle
- Verification failures → T3 analysis before retry
- Auth failures → immediate escalation, no retry
- Partial side effects → compensation strategy before retry
- Timeouts → checkpoint state, surface to T3

### Captain-2 Redundancy (not in ATP)
ATP has no concept of agent failover. Vectra introduces:
- Active/standby Captain instances
- Checkpoint-based state transfer
- Dispatch lock to prevent split-brain
- Heartbeat-based failover detection

### Cost Ceiling (partially in ATP)
ATP's worker-config has cost tracking for T3 scheduling. Vectra extends this to all jobs:
- Per-job cost tracking in the envelope
- Hard ceiling ($5/chain) as a stop condition
- Telemetry aggregates for session-level cost visibility

### Credential Scanning (not in ATP)
Vectra's bundle validator scans all context content for credential patterns before any model sees the bundle. ATP has guardrails about credentials but doesn't scan for them programmatically.
