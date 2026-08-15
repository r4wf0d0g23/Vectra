import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import plugin from '../index.js';
import { createVectraExecuteTool, createVectraOnlyPolicy, resolveConfig } from '../lib.js';

const RUN_TOKEN = 'signed-run-token.'.padEnd(48, 'x');
const AUTH_TOKEN = 'local-gateway-auth.'.padEnd(48, 'y');

async function fakeGateway(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('plugin registers exactly one vectra_execute tool', () => {
  const tools = [];
  const prior = process.env.VECTRA_TOOL_GATEWAY_TOKEN;
  process.env.VECTRA_TOOL_GATEWAY_TOKEN = AUTH_TOKEN;
  const policies = [];
  try { plugin.register({ pluginConfig: { allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'] }, registerTool: (tool) => tools.push(tool), registerTrustedToolPolicy: (policy) => policies.push(policy) }); }
  finally { if (prior === undefined) delete process.env.VECTRA_TOOL_GATEWAY_TOKEN; else process.env.VECTRA_TOOL_GATEWAY_TOKEN = prior; }
  assert.deepEqual(tools.map((tool) => tool.name), ['vectra_execute']);
  assert.deepEqual(policies.map((policy) => policy.id), ['vectra-only']);
});

test('manifest declares only the wrapper tool and strict plugin configuration', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.tools, ['vectra_execute']);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.contracts.trustedToolPolicies, ['vectra-only']);
  assert.deepEqual(manifest.configSchema.required, ['allowedTools', 'protectedAgentIds']);
});

test('trusted policy vetoes every non-wrapper tool for protected agents', () => {
  const policy = createVectraOnlyPolicy(new Set(['vectra-canary']));
  assert.deepEqual(policy.evaluate({ toolName: 'exec', params: {} }, { agentId: 'vectra-canary' }), { allow: false, reason: 'Agent vectra-canary must route tool execution through vectra_execute' });
  assert.deepEqual(policy.evaluate({ toolName: 'vectra_execute', params: {} }, { agentId: 'vectra-canary' }), { allow: true });
  assert.equal(policy.evaluate({ toolName: 'exec', params: {} }, { agentId: 'unrelated-agent' }), undefined);
});

test('forwards structured args and signed token to authenticated loopback gateway', async () => {
  let captured;
  const gateway = await fakeGateway(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { url: req.url, auth: req.headers['x-vectra-token'], body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, run_id: 'run-1', result: { applied: true }, receipt_token: 'receipt-token-1234567890' }));
  });
  try {
    const config = resolveConfig({ gatewayUrl: gateway.url, allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'] }, { VECTRA_TOOL_GATEWAY_TOKEN: AUTH_TOKEN });
    const result = await createVectraExecuteTool(config).execute('call-1', { run_token: RUN_TOKEN, requested_tool: 'config.patch', args: { patch: [{ op: 'test' }] } });
    assert.equal(captured.url, '/v1/tools/execute');
    assert.equal(captured.auth, AUTH_TOKEN);
    assert.deepEqual(captured.body.args, { patch: [{ op: 'test' }] });
    assert.equal(result.details.receipt_token, 'receipt-token-1234567890');
  } finally { await gateway.close(); }
});

test('rejects non-loopback gateways, weak secrets, malformed tokens, and tools outside allowlist', async () => {
  assert.throws(() => resolveConfig({ gatewayUrl: 'https://example.invalid', allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'] }, { VECTRA_TOOL_GATEWAY_TOKEN: AUTH_TOKEN }), /loopback/);
  assert.throws(() => resolveConfig({ allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'] }, { VECTRA_TOOL_GATEWAY_TOKEN: 'weak' }), /32 bytes/);
  const config = resolveConfig({ allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'] }, { VECTRA_TOOL_GATEWAY_TOKEN: AUTH_TOKEN });
  const tool = createVectraExecuteTool(config, async () => { throw new Error('must not fetch'); });
  await assert.rejects(tool.execute('call', { run_token: 'short', requested_tool: 'config.patch', args: {} }), /run_token/);
  await assert.rejects(tool.execute('call', { run_token: RUN_TOKEN, requested_tool: 'exec', args: {} }), /not enabled/);
});

test('fails closed when gateway denies or omits the receipt token', async () => {
  for (const response of [
    new Response(JSON.stringify({ ok: false }), { status: 403 }),
    new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
  ]) {
    const config = resolveConfig({ allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'] }, { VECTRA_TOOL_GATEWAY_TOKEN: AUTH_TOKEN });
    const tool = createVectraExecuteTool(config, async () => response);
    await assert.rejects(tool.execute('call', { run_token: RUN_TOKEN, requested_tool: 'config.patch', args: {} }), /denied|receipt/);
  }
});

test('bounds gateway response before parsing', async () => {
  const config = resolveConfig({ allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'], maxResponseBytes: 1024 }, { VECTRA_TOOL_GATEWAY_TOKEN: AUTH_TOKEN });
  const tool = createVectraExecuteTool(config, async () => new Response(JSON.stringify({ ok: true, result: 'x'.repeat(2048), receipt_token: 'receipt-token-1234567890' })));
  await assert.rejects(tool.execute('call', { run_token: RUN_TOKEN, requested_tool: 'config.patch', args: {} }), /exceeded/);
});

test('bounds and JSON-validates gateway requests before network access', async () => {
  let fetched = false;
  const config = resolveConfig({ allowedTools: ['config.patch'], protectedAgentIds: ['vectra-canary'], maxRequestBytes: 1024 }, { VECTRA_TOOL_GATEWAY_TOKEN: AUTH_TOKEN });
  const tool = createVectraExecuteTool(config, async () => { fetched = true; throw new Error('must not fetch'); });
  await assert.rejects(tool.execute('call', { run_token: RUN_TOKEN, requested_tool: 'config.patch', args: { value: 'x'.repeat(2048) } }), /request exceeded/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(tool.execute('call', { run_token: RUN_TOKEN, requested_tool: 'config.patch', args: cyclic }), /acyclic JSON/);
  assert.equal(fetched, false);
});
