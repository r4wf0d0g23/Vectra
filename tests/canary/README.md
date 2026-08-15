# Agent-loop canary contract harness

This real-process harness is the executable integration seam for
`docs/agent-loop-lifecycle-adapter.md` until the OpenClaw-owned adapter lands.

It starts isolated provider, Vectra tool-gateway, and mock OpenClaw tool-invoke
processes. The test driver acts as the awaited agent-loop adapter and proves:

- run identity is preserved across provider turns and tool execution;
- mutations are durably recorded before acknowledgement;
- terminal model output cannot be released before receipt validation;
- restart reconciliation keeps mutated/unreceipted work pending;
- forged/replayed tokens and direct provider/tool bypasses fail closed;
- OpenAI Responses, Chat Completions, and Anthropic Messages streaming dialects
  all complete the same lifecycle contract.

Run after build with:

```sh
node --test tests/canary/agent-loop-canary.test.mjs
```

The harness uses only loopback listeners, temporary ledgers, and test-only
secrets. It never reads or changes production configuration.
