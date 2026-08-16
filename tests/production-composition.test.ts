import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolGatewayProbe } from '../src/operations/readiness.js';

test('tool gateway startup reconciliation runs once, not on every readiness poll', async () => {
  let calls=0;const probe=toolGatewayProbe(async()=>{calls++;return['interrupted']});
  assert.match(await probe.run(new AbortController().signal),/1 interrupted/);
  assert.match(await probe.run(new AbortController().signal),/1 interrupted/);
  assert.equal(calls,1);
});

test('production composition requires signing material and mounts authenticated policy routes', async () => {
  const source=await readFile(join(process.cwd(),'src/operations/production-main.ts'),'utf8');
  assert.match(source,/VECTRA_RUN_TOKEN_SIGNING_KEY/);
  assert.match(source,/signingKey\.length < 32/);
  assert.ok(source.indexOf('isLocallyAuthenticated') < source.indexOf('handleToolGatewayApi'));
  assert.match(source,/toolGateway: mode === 'enforce'/);
  assert.match(source,/VECTRA_ENFORCEMENT_MODE/);
  assert.doesNotMatch(source,/VECTRA_PREEXECUTION_ONLY/);
});
