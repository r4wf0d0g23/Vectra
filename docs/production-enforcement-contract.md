# Vectra Production ATP Enforcement Contract

Vectra is the owning enforcement boundary between OpenClaw and every model provider. OpenClaw hooks remain observability inputs; they are not trusted as veto points.

## Lifecycle

`intake → classify → route → validate vars → snapshot/pin → ledger pending → upstream → executing → verifying → terminal`

No model request is forwarded until route, freshness, and immutable-pin gates pass. Unknown impact is treated as state-changing. Read-only degradation is allowed only when the governing protocol explicitly opts in. Telemetry may fail open; authorization gates do not.

State-changing output remains provisional until a correlated receipt matches the run, bundle, protocol, and pin hashes. Only then may the append-only ledger transition `verifying → completed`. Crashes leave active runs `violated`; reconciliation never invents success. Terminal ledger states are immutable.

## Immutable pins

Every run pins raw-byte SHA-256 and version for its protocol and variables, validator hashes and attestation IDs where applicable, bundle hash, plugin version, and enforcement-contract version. Hot reload affects new runs only. A critical revocation produces a violation; it never silently substitutes new definitions into an active run.

## Emergency bypass

A bypass is a signed, narrow, expiring grant containing operator identity, reason, protocol scope, and optionally one run ID. Its issue and use are immutable ledger events. Bypass never suppresses receipt requirements, audit events, or terminal semantics. Expired, unsigned, unscoped, or retroactive grants are rejected.

## Provider-boundary requirements

- Both Chat Completions and Responses APIs, including streaming, use the same gate.
- State-changing streaming is buffered until terminal verification; unverified success text is never released.
- Direct-provider egress is denied for governed agents outside Vectra.
- Health failure denies state-changing work and permits only explicitly degradable read-only work.
- The validator executes in a separate constrained service with fixed adapters, environment allowlist, timeout, output cap, and redaction.
