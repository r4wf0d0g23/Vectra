# Required Agent-Loop Lifecycle Adapter

Vectra's provider boundary can enforce routing, variable freshness, immutable snapshots, and durable pending creation before a model request reaches its provider. It cannot alone enforce terminal receipts.

The first model response may contain tool calls. Holding that response until a receipt exists deadlocks execution: OpenClaw cannot execute the tools that produce mutation evidence or the receipt until it receives the held response. Releasing tool-call responses but holding presumed terminal responses is still not authoritative across streaming dialects, retries, parallel tools, and OpenClaw's own completion semantics. The provider request also lacks Vectra's generated run and bundle IDs.

Production terminal enforcement therefore requires an adapter at the agent loop that owns tool execution. It must:

1. Accept Vectra's `runId`, `bundleId`, and pin hash before the first model call and preserve them through every turn.
2. Notify Vectra before and after each tool call with a canonical mutation classification and evidence hash.
3. Distinguish intermediate model output from the terminal assistant response using OpenClaw lifecycle state, not provider payload inference.
4. Submit the canonical receipt and wait for ledger validation before terminal success is committed or delivered.
5. Expose awaited veto semantics: a missing, forged, mismatched, or invalid receipt keeps the run pending/violated and prevents terminal completion.
6. Reconcile interrupted runs after restart without fabricating success.

Until that authority exists, `production-main` starts only with the explicit `VECTRA_PREEXECUTION_ONLY=true` acknowledgement. Readiness reports terminal enforcement as unavailable, and the provider path deliberately releases intermediate responses after pre-execution gates to avoid deadlock.
