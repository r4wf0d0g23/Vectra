# Production ATP Wrapper Architecture

Status: implementation target
Owner: Reality Anchor
Quality gate: independent Sol review before promotion

## Decision

Vectra is the enforcement boundary for both model admission and ATP-governed tool execution. ATP remains the authored policy and operational-state layer. OpenClaw hooks remain observability inputs only; they are not trusted for admission or terminal enforcement because their failures and completion callbacks cannot reliably veto execution.

A provider proxy by itself is insufficient: OpenClaw must receive intermediate model tool-call responses before a mutation can occur, so holding every response for a post-mutation receipt deadlocks the agent loop. Production enforcement therefore has two coordinated planes:

- the provider plane performs route selection, live-variable validation, immutable pinning, durable run creation, context injection, and final-response gating;
- the tool plane is the sole path for ATP-governed tools and performs pre-tool authorization, downstream invocation, evidence capture, receipt creation, and replay-safe run advancement.

## Request path

```text
OpenClaw provider client
  -> loopback Vectra listener
  -> request identity and provider-dialect adapter
  -> ATP route decision
  -> state-change classification
  -> required-variable validation
  -> immutable bundle snapshot + pending ledger event
  -> upstream provider
  -> buffered/stream-aware response classification
  -> release intermediate tool call OR gate final response
  -> OpenClaw

OpenClaw vectra_execute wrapper tool
  -> authenticated Vectra tool gateway
  -> signed run-token verification
  -> ATP tool allowlist + canonical argument authorization
  -> OpenClaw tool invoke worker
  -> evidence + per-tool receipt + ledger advancement
  -> wrapper tool result carrying signed continuation
```

Read-only conversational requests may degrade only when their protocol explicitly permits it. Any request classified as state-changing, mutation-capable, ambiguous with mutation indicators, or governed by a state-changing ATP protocol fails closed when routing, validation, pinning, ledger persistence, or receipt enforcement is unavailable.

## Trust boundaries

- OpenClaw owns channels, sessions, tools, and provider selection.
- Vectra owns ATP admission, validated context, immutable execution identity, upstream release, and terminal status.
- The validator service owns bounded live-state probes. It accepts validator IDs and typed parameters, never shell text from a prompt or request.
- ATP protocol and variable files are untrusted authored inputs until parsed, schema-checked, versioned, and pinned.
- Model output is untrusted until correlated with the pinned bundle and accepted by the receipt gate.
- Telemetry may fail open. Mutation safety gates fail closed.

## Provider compatibility

Vectra must preserve the upstream protocol rather than normalize every provider through Chat Completions. Required adapters are:

- OpenAI Responses, including SSE streaming and tool-call events.
- OpenAI Chat Completions for compatible local providers.
- Anthropic Messages, including event-stream responses.
- Opaque passthrough for explicitly non-governed endpoints such as model listing.

The existing OpenAI provider cannot be redirected during development: OpenClaw selects a dedicated Codex harness for the official endpoint, and a custom base URL changes that behavior. Canary deployment therefore uses an isolated provider/agent entry whose API dialect matches its upstream. Captain traffic is cut over only after equivalent tool, reasoning, streaming, error, and usage behavior is proven end to end.

## Completion semantics

Vectra distinguishes provider completion from ATP execution completion. A model response is not proof that external mutations completed safely.

- A pending ledger record is durable before the upstream request is sent.
- Tool/mutation evidence is correlated to the run when available.
- State-changing runs remain `pending` until a canonical receipt covers the pinned bundle and mutation evidence.
- Intermediate tool-call responses are released so OpenClaw can invoke the single Vectra wrapper tool. They are not terminal success.
- The canary agent denies direct mutation tools. The wrapper delegates through Vectra, which authorizes and records the actual downstream tool invocation before returning its result.
- Final natural-language responses are held until all authorized tool sequences have canonical receipts and the run is terminally eligible. They may never be presented as unqualified success while receipt enforcement is unresolved.
- Restart reconciliation can produce `pending`, `failed`, or `violated`; it cannot fabricate `completed`.

Each run uses a signed, expiring continuation token bound to the run, bundle hash, sequence, nonce, session scope, permitted tool, canonical argument hash, and previous ledger event. Reuse, reordering, argument substitution, or cross-run replay fails closed. Tool retries use an idempotency key and return the already-recorded outcome rather than repeating a mutation.

## Validator isolation

The production validator interface is allowlist-based:

- fixed executable or adapter per validator ID;
- fixed working directory and read-only path grants;
- sanitized environment with no inherited credentials;
- network disabled unless the validator capability explicitly permits a bounded destination;
- timeout, process-group termination, output caps, redaction, and concurrency limits;
- no user-controlled shell interpolation;
- attestations stored separately from authored variable files.

Bubblewrap is not a production dependency on this host because unprivileged user namespaces are disabled. The deployment must use a rootless container runtime when its isolation probes pass, or a narrow system service with equivalent filesystem, syscall, network, and credential restrictions. If neither passes, live-variable mutation routes remain disabled.

## Bypass prevention

- Vectra binds only to loopback and authenticates OpenClaw requests with a rotated local credential.
- Upstream credentials belong to Vectra for wrapped providers; the canary OpenClaw provider receives only the Vectra credential.
- The canary OpenClaw agent exposes only the `vectra_execute` wrapper for mutation-capable work; direct native mutation tools are denied.
- Direct egress to wrapped provider endpoints is denied for the canary service identity where host controls permit it.
- Emergency bypass is signed/attributed, reasoned, expiring, ledgered, and never deletes violations.
- Health means admission, validator, snapshot store, ledger, upstream, and reconciliation probes pass—not merely that the HTTP port accepts connections.

## Rollout

1. Offline replay and adversarial tests.
2. Local mock-provider integration tests for every supported dialect.
3. Shadow decisions with no request mutation.
4. Isolated canary agent/provider in `observe`, then `warn`, then `enforce`.
5. Tool-use, streaming, provider-error, restart, stale-variable, forged-receipt, and direct-bypass drills.
6. Seven consecutive days meeting routing, lifecycle, latency, and error-budget gates.
7. Independent Sol review and Raw approval.
8. Validated OpenClaw config patch with a written continuance and immediate end-to-end rollback probe.

Rollback restores the canary provider base URL and stops Vectra. Ledger, snapshots, attestations, and violations are retained. Captain's current provider path remains unchanged until the final approved cutover.
