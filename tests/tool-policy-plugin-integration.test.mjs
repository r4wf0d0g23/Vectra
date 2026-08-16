import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AtpToolGateway } from '../dist/src/atp/tool-gateway.js';
import { handleToolGatewayApi } from '../dist/src/transport/tool-gateway-api.js';
import { createVectraNativeEnforcement, resolveConfig } from '../integrations/openclaw-vectra-tool/lib.js';

test('plugin heartbeats a real gateway lease and exact middleware receipt completes', async () => {
  const claims = { runId: `run_${'e'.repeat(32)}`, bundleId: 'bundle', protocolId: 'protocol', pinsSha256: 'f'.repeat(64), impact: 'state-changing', receiptRequired: true };
  const gateway = new AtpToolGateway(await mkdtemp(join(tmpdir(), 'vectra-policy-integration-')), Buffer.alloc(32, 7), 500);
  const token = await gateway.createRun(claims);
  const args = { path: '/tmp/sentinel', content: 'value' };
  await gateway.registerExpected(token, [{ callId: 'native-call', tool: 'write', args }]);
  const secret = 'integration-secret-'.padEnd(48, 'z');
  let heartbeats = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    if (req.url === '/v1/tool-policy/heartbeat') heartbeats++;
    if (!await handleToolGatewayApi(gateway, req, res)) { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const config = resolveConfig({ gatewayUrl: `http://127.0.0.1:${address.port}`, protectedAgentIds: ['canary'], heartbeatIntervalMs: 100 }, { VECTRA_TOOL_GATEWAY_TOKEN: secret });
  const native = createVectraNativeEnforcement(config);
  const ctx = { agentId: 'canary', runId: 'openclaw-run' };
  try {
    assert.deepEqual(await native.policy.evaluate({ toolCallId: 'native-call', toolName: 'write', params: args }, ctx), { allow: true });
    await new Promise((resolve) => setTimeout(resolve, 240));
    const result = { content: [{ type: 'text', text: 'ok' }], details: { ok: true } };
    assert.deepEqual(await native.middleware({ toolCallId: 'native-call', toolName: 'write', args, result, isError: false }, ctx), { result });
    assert.ok(heartbeats >= 2);
    assert.equal((await gateway.finalEligibility(token)).eligible, true);
  } finally {
    native.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
