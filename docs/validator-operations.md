# Constrained validator operations

Vectra delegates ATP validators to a local Unix-socket daemon. Clients select a
predeclared adapter ID and correlation ID only. They cannot supply executables,
arguments, working directories, environment variables, stdin, or shell text.

## Security boundary

- Adapter configuration is loaded once at boot and fails closed.
- Executables and working directories are canonicalized through `realpath` and
  must remain beneath explicit allowlisted roots.
- `spawn` uses `shell: false`, a fixed minimal environment, ignored stdin,
  timeouts, concurrency limits, and bounded stdout/stderr.
- The daemon listens only on an owner/group-controlled Unix socket.
- The systemd unit drops all capabilities, blocks networking and namespaces,
  makes the host filesystem read-only, and allows writes only to its runtime
  directory.

This is a narrow service boundary, not a general command runner. Validators that
need untrusted inputs must expose a new typed adapter and receive a dedicated
security review; interpolating request data into `args` is prohibited.

## Staged deployment

1. Build and test an immutable release directory.
2. Install `validator.json` mode `0640`, owned by the service user/group.
3. Run `systemd-analyze security deploy/systemd/vectra-validator.service` and
   review host-specific warnings.
4. Install the unit, then start the validator before Vectra.
5. Run `node deploy/reconcile-validator.mjs`; success requires the live daemon's
   config hash to equal the on-disk config hash.
6. Exercise every production adapter with a canary correlation ID. A validator
   failure must block ATP-governed mutation; it must never trigger passthrough.

The service file is a template: package paths, user/group, and read-only paths
must be adjusted to the release layout before installation. No deployment step
is performed automatically by this repository.

## Restart reconciliation

`reconcile-validator.mjs` fails if the socket is absent, health is degraded, or
the running process loaded a different configuration. Run it after every
restart and before Vectra becomes ready. Counters and `lastCompletionAt` help
distinguish a fresh restart from an idle or wedged daemon.

## Rollback

Stop Vectra first so no ATP-governed request can bypass validation. Stop the
validator, repoint `/opt/vectra/current` and `/etc/vectra/validator.json` to the
last verified pair, start the validator, run reconciliation plus all canaries,
then start Vectra. If reconciliation fails, keep both services stopped. Never
route OpenClaw directly to the provider as a rollback.
