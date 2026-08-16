# Isolated OpenClaw plugin canary

Run the host canary from the Vectra repository root:

```bash
node tests/host-canary/openclaw-plugin-registry-canary.mjs
```

The executable creates a temporary HOME, state directory, workspace, and
OpenClaw configuration beneath `/tmp`. It never installs the plugin and never
reads or writes the Captain profile. It then:

1. loads the plugin through `openclaw plugins inspect --runtime` using the
   isolated profile;
2. loads the same config through the installed OpenClaw runtime registry;
3. verifies the trusted policy and OpenClaw result middleware registrations;
4. sends an unexpected core `exec` through OpenClaw's real awaited pre-tool
   runtime and proves the sentinel execution counter remains zero;
5. authorizes one exact `exec`, increments the sentinel once, and passes the
   exact result through OpenClaw's real result-middleware runner;
6. proves one receipt, plus gateway URL, plugin config, and environment-secret
   propagation; and
7. removes the temporary profile.

This is a host/version canary because it deliberately exercises the installed
OpenClaw runtime modules. Run it after every OpenClaw upgrade before promoting
the Vectra plugin. A module-contract change fails the canary rather than silently
falling back to a direct plugin call.
