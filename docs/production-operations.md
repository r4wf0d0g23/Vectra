# Production operations

Vectra becomes ready only after ATP parsing, atomic snapshot storage, atomic ledger
storage, validator reconciliation, and authenticated upstream access all pass.
The startup path runs the same probes before binding the proxy listener. Liveness
at `/health` means only that the process responds; authenticated `/ready` is the
traffic gate.

## Local authentication and provider custody

Generate independent credentials for the loopback Vectra hop and upstream
provider. OpenClaw receives only the local `x-vectra-token`; the upstream secret
stays in Vectra's mode-0600 environment/credential store. Rotate both separately.
The proxy rejects every route except `/health` without local authentication.

Use a dedicated canary service identity. Deny that identity direct DNS/IP egress
to wrapped provider endpoints while allowing the Vectra service identity. Host
firewall rules are deployment-specific and must be snapshot, reviewed, and
tested from the actual OpenClaw process context. Curl from an operator shell is
not evidence that bypass prevention works.

## Canary and promotion

Start with `deploy/canary.instance.example.json` on an isolated agent. Progress
from observe to warn to enforce. Run provider-dialect, streaming, tool, stale-var,
forged-receipt, restart, graceful-drain, and direct-bypass tests. Captain traffic
remains excluded until seven healthy days, independent review, Raw approval, and
the OpenClaw config-change SOP are complete.

## Shutdown and restart

SIGTERM stops admission, drains active connections for the configured grace
period, force-closes lingering sockets, stops ATP watchers, and flushes telemetry.
systemd requires the validator first and gives Vectra 20 seconds to drain. On
restart, startup reconciliation refuses to listen if any required component is
unhealthy or config-drifted.

## Rollback drill

Run `node deploy/rollback-drill.mjs` against the canary. It verifies liveness,
full readiness, and unauthenticated denial, then prints the manual rollback
sequence. The script deliberately does not mutate OpenClaw, firewall, systemd,
or provider configuration. A real drill must restore the validated baseline,
perform an end-to-end completion, and prove direct-provider denial from the
canary identity. Retain ledgers, snapshots, artifacts, and violations.
