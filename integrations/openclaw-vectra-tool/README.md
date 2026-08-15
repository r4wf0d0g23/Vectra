# OpenClaw Vectra tool wrapper

This canary plugin registers exactly one tool: `vectra_execute`. It never calls
OpenClaw's native mutation tools. It forwards an opaque signed run token, a
configured tool name, and structured JSON arguments to the authenticated
loopback Vectra tool gateway. Vectra verifies authorization, performs the
operation through a fixed adapter, records lifecycle evidence, and returns the
result plus receipt token.

The plugin accepts only HTTP loopback gateway URLs, reads its gateway credential
from an environment variable, bounds responses, and fails closed on denial,
timeout, malformed output, or a missing receipt token. It does not decode the
run token because signature, expiry, scope, replay, and bundle correlation are
owned by Vectra.

As defense in depth, the plugin also registers the manifest-gated trusted policy
`vectra-only`. For configured canary agent IDs it blocks every tool except
`vectra_execute`, including core tools. In OpenClaw 2026.7.1 this policy tier is
awaited by the pre-tool runtime before ordinary `before_tool_call` hooks; a
policy exception becomes a fail-closed policy failure, and `{allow:false}`
becomes a veto. The installed runtime contract is documented in
`docs/plugins/hooks.md` and implemented by `runTrustedToolPolicies` in the
before-tool-call runtime. The manifest declaration is mandatory for installed
plugins and registration is rejected unless the plugin is explicitly enabled.

## Canary policy template

The fragment below is documentation, not a command. Validate it against the
installed OpenClaw schema before use. Do not hand-edit a live configuration.

```json
{
  "plugins": {
    "entries": {
      "vectra-tool-wrapper": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://127.0.0.1:18801",
          "authTokenEnv": "VECTRA_TOOL_GATEWAY_TOKEN",
          "allowedTools": ["config.patch"],
          "protectedAgentIds": ["vectra-canary"]
        }
      }
    }
  },
  "agents": {
    "entries": [
      {
        "id": "vectra-canary",
        "tools": {
          "allow": ["vectra_execute"],
          "deny": [
            "exec", "process", "write", "edit", "apply_patch", "gateway",
            "browser", "nodes", "cron", "message", "sessions_send"
          ]
        }
      }
    ]
  }
}
```

The canary agent must use an explicit `allow` list containing only
`vectra_execute`; the deny list is defense in depth and must include every native
mutation surface enabled by the installed build. Before promotion, inspect the
effective tool catalog from the actual canary session and prove that attempts to
call `exec`, filesystem mutation, gateway/config mutation, browser automation,
node operations, scheduling, messaging, and session sends are denied.

OpenClaw holds only the loopback gateway credential. Any downstream credentials
and tool authority remain in Vectra. Enforce service-identity egress rules so the
canary cannot bypass Vectra and reach mutation targets directly.

## Development verification

```bash
cd integrations/openclaw-vectra-tool
npm test
```

Installation and live configuration are intentionally outside this package.
