# OpenClaw Vectra tool-policy plugin

Production mode preserves OpenClaw's native tool schemas while making Vectra
the authorization and receipt boundary.

For each native tool call by a configured protected agent, the manifest-gated
trusted policy awaits `POST /v1/tool-policy/authorize` with the exact OpenClaw
run ID, call ID, tool name, and arguments. The tool executes only when Vectra
returns a valid authorization. Network errors, timeouts, malformed responses,
missing runtime identity, and denials all fail closed before execution.
Authorization atomically marks the call executing because OpenClaw exposes no
later pre-execute seam. The plugin heartbeats the resulting lease throughout
long-running native execution.

After execution, manifest-gated `agentToolResultMiddleware` awaits
`POST /v1/tool-policy/result` with the same identity, exact arguments, complete
OpenClaw result, and error flag. It requires a receipt matching the call ID and
tool name before the result reaches the model. Identical middleware retries are
idempotent in Vectra; divergent results violate the run.

OpenClaw 2026.7.1 awaits trusted policy evaluation before ordinary hooks and
tool execution. It also awaits tool-result middleware before returning native
results to the model. Installed plugins must be explicitly enabled and declare
`contracts.trustedToolPolicies` plus every targeted runtime in
`contracts.agentToolResultMiddleware`; this plugin targets `openclaw` and
`codex`.

The legacy `vectra_execute` bridge remains available only when
`wrapperEnabled:true`. It forwards an opaque signed run token and structured
arguments to `/v1/tools/execute`. Production native-policy mode defaults to the
wrapper being disabled.

## Canary configuration template

This fragment is documentation, not a command. Validate it against the
installed schema and apply it through the OpenClaw config-change protocol.

```json
{
  "plugins": {
    "entries": {
      "vectra-tool-wrapper": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://127.0.0.1:18800",
          "authTokenEnv": "VECTRA_TOOL_GATEWAY_TOKEN",
          "protectedAgentIds": ["vectra-canary"],
          "nativePolicyEnabled": true,
          "wrapperEnabled": false,
          "timeoutMs": 30000
        }
      }
    }
  },
  "agents": {
    "entries": [
      {
        "id": "vectra-canary",
        "tools": {
          "allow": ["read", "exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

The OpenClaw allowlist remains intentionally narrow, but authorization does not
come from that list: every listed native tool is still denied unless Vectra has
an exact expected call. Verify from the real canary runtime that an unexpected
`exec` is vetoed before process creation, an expected mutation executes once,
the result receipt completes, identical result retries remain idempotent, and
argument/call/result mismatches fail closed.

For a wrapper-only emergency compatibility canary, set
`nativePolicyEnabled:false`, `wrapperEnabled:true`, provide `allowedTools`, and
allow only `vectra_execute` at the agent layer. Do not run both modes unless a
specific migration test requires it.

The plugin accepts only HTTP loopback gateway URLs, reads its credential from an
environment variable, and bounds request and response bodies. OpenClaw holds
only this loopback credential. Downstream tool credentials remain in Vectra.

## Development verification

```bash
cd integrations/openclaw-vectra-tool
npm test
```

Installation and live configuration are intentionally outside this package.
