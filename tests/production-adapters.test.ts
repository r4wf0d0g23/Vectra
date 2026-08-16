import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtpProductionRouteResolver } from '../src/atp/production-adapters.js';
import { terminalLifecycleProbe } from '../src/operations/readiness.js';

async function instance() {
  const root = await mkdtemp(join(tmpdir(), 'vectra-atp-'));
  await mkdir(join(root, 'protocols')); await mkdir(join(root, 'vars'));
  await writeFile(join(root, 'protocols', 'orchestration-main.md'), `---
id: orchestration-main
name: Orchestration
version: 1.0.0
status: active
classification: private
routing:
  - task_pattern: "deploy / publish"
    execution_protocol: deploy
    var_ids: [live-state]
    model_class: fast
  - task_pattern: "*"
    execution_protocol: conversational
    var_ids: []
    model_class: fast
---
body
`);
  await writeFile(join(root, 'protocols', 'deploy.md'), `---
id: deploy
name: Deploy
version: 1.2.3
status: active
classification: private
tool_allowlist: [read, apply_patch]
---
deploy
`);
  await writeFile(join(root, 'protocols', 'conversational.md'), `---
id: conversational
name: Conversation
version: 1.0.0
status: active
classification: private
tool_allowlist: [read]
---
chat
`);
  await writeFile(join(root, 'vars', 'live-state.md'), `---
id: live-state
name: State
version: 2.0.0
status: active
classification: private
validator: endpoint
staleness_policy: always-verify
source: live
---
state
`);
  return root;
}

test('real ATP resolver binds raw definitions, validators and mutation impact', async () => {
  const root = await instance();
  const resolver = new AtpProductionRouteResolver(root, { 'live-state': 'live-state-adapter' });
  const mutation = await resolver.resolve('please deploy this');
  assert.equal(mutation.kind, 'single');
  assert.equal(mutation.protocolId, 'deploy');
  assert.deepEqual(mutation.toolImpacts, ['write-capable', 'write-capable']);
  assert.equal(mutation.requiredVariables[0].adapterId, 'live-state-adapter');
  assert.match(Buffer.from(mutation.protocolBytes!).toString(), /tool_allowlist/);
  const chat = await resolver.resolve('hello there');
  assert.deepEqual(chat.toolImpacts, ['read-only']);
  assert.equal(chat.allowReadOnlyDegradation, true);
});

test('resolver preserves last-known-good routing after malformed reload', async () => {
  const root = await instance();
  const resolver = new AtpProductionRouteResolver(root, {});
  assert.equal((await resolver.resolve('hello')).protocolId, 'conversational');
  await writeFile(join(root, 'protocols', 'orchestration-main.md'), 'broken');
  assert.equal((await resolver.resolve('hello')).protocolId, 'conversational');
});

test('readiness refuses claimed terminal enforcement without agent-loop authority', async () => {
  await assert.rejects(terminalLifecycleProbe(false, false).run(new AbortController().signal), /agent-loop adapter required/);
  assert.match(await terminalLifecycleProbe(false, true).run(new AbortController().signal), /pre-execution-only/);
});
