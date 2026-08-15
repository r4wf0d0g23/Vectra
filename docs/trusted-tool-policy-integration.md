# OpenClaw trusted tool policy integration

Local runtime inspection proves `api.registerTrustedToolPolicy` awaits each async `evaluate` before ordinary hooks and before tool execution. Exceptions and unreadable decisions fail closed. The installed plugin must declare its policy id in `contracts.trustedToolPolicies`.

The Vectra plugin adapter calls `/v1/tool-policy/authorize` from the trusted policy with `ctx.runId`, `event.toolCallId`, exact tool name, and params. It returns `allow: false` on any Vectra error. `agentToolResultMiddleware` then awaits `/v1/tool-policy/result` with the same identity, exact args, result, and error flag. This preserves native OpenClaw tools while Vectra owns authorization and receipts. Wrapper invocation is fallback only.

The provider interceptor registers expected calls before releasing the intermediate response. Provider replay is correlated by the prior tool-call id. A terminal response is released only when every expected call has one canonical result receipt.
