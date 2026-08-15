# OpenClaw trusted tool policy integration

Local runtime inspection proves `api.registerTrustedToolPolicy` awaits each async `evaluate` before ordinary hooks and before tool execution. Exceptions and unreadable decisions fail closed. The installed plugin must declare its policy id in `contracts.trustedToolPolicies`.

The Vectra plugin adapter calls `/v1/tool-policy/authorize` from the trusted policy with `ctx.runId`, `event.toolCallId`, exact tool name, and params. It returns `allow: false` on any Vectra error. `agentToolResultMiddleware` then awaits `/v1/tool-policy/result` with the same identity, exact args, result, and error flag. This preserves native OpenClaw tools while Vectra owns authorization and receipts. Wrapper invocation is fallback only.

The provider interceptor registers expected calls before releasing the intermediate response. Provider replay is correlated by the prior tool-call id. A terminal response is released only when every expected call has one canonical result receipt.

## Execution ownership and leases

OpenClaw 2026.7.1 has no distinct hook between the final trusted-policy
decision and native tool invocation. Vectra therefore treats successful
`/authorize` as the atomic execution start: the call moves directly from
`expected` to `executing` and receives a lease. The plugin heartbeats that lease
while the native call runs and stops only when awaited result middleware begins.

If the plugin process crashes, heartbeat fails, or the lease expires, the call
becomes `indeterminate` and the run becomes `violated`. It is never returned to
`expected`, never re-authorized, and late results cannot restore success. This
prefers manual reconciliation over potentially repeating an external mutation.

The gateway's stable call nonce is the server-side idempotency key. OpenClaw can
rewrite policy params, but adding hidden metadata would alter the native tool's
schema-visible arguments and break exact argument binding. The plugin therefore
does not inject the nonce into tool params; it retains the nonce in its lease
coordinator and sends it only to `/v1/tool-policy/heartbeat`. A future native
post-policy/pre-execute metadata seam should replace this limitation when the
host provides one.
