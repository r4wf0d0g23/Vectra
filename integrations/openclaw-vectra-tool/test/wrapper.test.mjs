import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import plugin from '../index.js';
import { createVectraExecuteTool, createVectraNativePolicy, createVectraResultMiddleware, resolveConfig } from '../lib.js';

const RUN_TOKEN = 'signed-run-token.'.padEnd(48, 'x');
const AUTH_TOKEN = 'local-gateway-auth.'.padEnd(48, 'y');
const baseConfig = (overrides = {}) => ({ protectedAgentIds: ['vectra-canary'], ...overrides });
const env = { VECTRA_TOOL_GATEWAY_TOKEN: AUTH_TOKEN };
const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha = (value) => createHash('sha256').update(canonical(value)).digest('hex');

async function fakeGateway(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function runNative(policy, middleware, event, ctx, execute) {
  const decision = await policy.evaluate(event, ctx);
  if (decision?.allow === false || decision?.block === true) throw new Error(decision.reason ?? decision.blockReason ?? 'blocked');
  const result = await execute();
  await middleware({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.params, result, isError: false }, ctx);
  return result;
}

test('production registration installs native policy and result middleware; wrapper is optional', () => {
  const prior = process.env.VECTRA_TOOL_GATEWAY_TOKEN;
  process.env.VECTRA_TOOL_GATEWAY_TOKEN = AUTH_TOKEN;
  try {
    for (const wrapperEnabled of [false, true]) {
      const tools = [], policies = [], middlewares = [];
      plugin.register({
        pluginConfig: baseConfig({ wrapperEnabled, ...(wrapperEnabled ? { allowedTools: ['config.patch'] } : {}) }),
        registerTool: (tool) => tools.push(tool),
        registerTrustedToolPolicy: (policy) => policies.push(policy),
        registerAgentToolResultMiddleware: (handler, options) => middlewares.push({ handler, options }),
      });
      assert.deepEqual(tools.map((tool) => tool.name), wrapperEnabled ? ['vectra_execute'] : []);
      assert.deepEqual(policies.map((policy) => policy.id), ['vectra-native-authorize']);
      assert.deepEqual(middlewares.map((item) => item.options.runtimes), [['openclaw', 'codex']]);
    }
  } finally { if (prior === undefined) delete process.env.VECTRA_TOOL_GATEWAY_TOKEN; else process.env.VECTRA_TOOL_GATEWAY_TOKEN = prior; }
});

test('manifest declares trusted policy and both result-middleware runtimes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.tools, ['vectra_execute']);
  assert.deepEqual(manifest.contracts.trustedToolPolicies, ['vectra-native-authorize']);
  assert.deepEqual(manifest.contracts.agentToolResultMiddleware, ['openclaw', 'codex']);
  assert.equal(manifest.configSchema.additionalProperties, false);
});

test('core exec is blocked before execution when Vectra is unavailable', async () => {
  const config = resolveConfig(baseConfig(), env);
  const policy = createVectraNativePolicy(config, async () => { throw new Error('offline'); });
  const middleware = createVectraResultMiddleware(config, async () => { throw new Error('must not run'); });
  let executions = 0;
  await assert.rejects(runNative(policy, middleware, { toolCallId: 'call-exec', toolName: 'exec', params: { command: 'id' } }, { agentId: 'vectra-canary', runId: 'oc-run-1' }, async () => { executions++; return { ok: true }; }), /unavailable|denied/);
  assert.equal(executions, 0);
});

test('authorization argument mismatch is denied before native execution', async () => {
  const config = resolveConfig(baseConfig(), env);
  const policy = createVectraNativePolicy(config, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.args, { command: 'unexpected' });
    return new Response(JSON.stringify({ authorized: false, error: 'not-authorized' }), { status: 409 });
  });
  const middleware = createVectraResultMiddleware(config, async () => { throw new Error('must not run'); });
  let executions = 0;
  await assert.rejects(runNative(policy, middleware, { toolCallId: 'call-exec', toolName: 'exec', params: { command: 'unexpected' } }, { agentId: 'vectra-canary', runId: 'oc-run-mismatch' }, async () => { executions++; return {}; }), /unavailable|denied/);
  assert.equal(executions, 0);
});

test('approved native call executes once, exact result receipt completes, and retry is idempotent', async () => {
  const requests = [];
  let priorResult;
  const gateway = await fakeGateway(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/tool-policy/authorize') return res.end(JSON.stringify({ authorized: true, runId: 'run_123', sequence: 0, nonce: 'nonce', leaseExpiresAt: new Date(Date.now() + 30000).toISOString() }));
    const hash = sha({ result: body.result, isError: body.isError });
    priorResult ??= hash;
    if (hash !== priorResult) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'result-retry-diverged' })); }
    return res.end(JSON.stringify({ callId: body.toolCallId, tool: body.tool, argsSha256: sha(body.args), resultSha256: hash, completedAt: new Date().toISOString() }));
  });
  try {
    const config = resolveConfig(baseConfig({ gatewayUrl: gateway.url }), env);
    const policy = createVectraNativePolicy(config);
    const middleware = createVectraResultMiddleware(config);
    const event = { toolCallId: 'call-write', toolName: 'write', params: { path: '/tmp/x', content: 'v' } };
    const ctx = { agentId: 'vectra-canary', runId: 'oc-run-2' };
    let executions = 0;
    const result = await runNative(policy, middleware, event, ctx, async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; });
    await middleware({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.params, result, isError: false }, ctx);
    assert.equal(executions, 1);
    assert.deepEqual(requests.map((request) => request.url), ['/v1/tool-policy/authorize', '/v1/tool-policy/result', '/v1/tool-policy/result']);
    assert.ok(requests.every((request) => request.auth === `Bearer ${AUTH_TOKEN}`));
    assert.deepEqual(requests[1].body, { openClawRunId: 'oc-run-2', toolCallId: 'call-write', tool: 'write', args: event.params, result, isError: false });
  } finally { await gateway.close(); }
});

test('result receipt identity mismatch fails closed after one native execution', async () => {
  const config = resolveConfig(baseConfig(), env);
  const policy = createVectraNativePolicy(config, async () => new Response(JSON.stringify({ authorized: true, runId: 'run', sequence: 0, nonce: 'n', leaseExpiresAt: new Date(Date.now() + 30000).toISOString() }), { status: 200 }));
  const middleware = createVectraResultMiddleware(config, async () => new Response(JSON.stringify({ callId: 'wrong-call', tool: 'write', argsSha256: 'a', resultSha256: 'b', completedAt: new Date().toISOString() }), { status: 200 }));
  let executions = 0;
  await assert.rejects(runNative(policy, middleware, { toolCallId: 'expected-call', toolName: 'write', params: {} }, { agentId: 'vectra-canary', runId: 'oc-run-3' }, async () => { executions++; return { ok: true }; }), /identity mismatch/);
  assert.equal(executions, 1);
});

test('wrapper fallback forwards signed token and structured args when explicitly enabled', async () => {
  let captured;
  const gateway = await fakeGateway(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured = { url: req.url, auth: req.headers['x-vectra-token'], body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, run_id: 'run-1', result: { applied: true }, receipt_token: 'receipt-token-1234567890' }));
  });
  try {
    const config = resolveConfig(baseConfig({ gatewayUrl: gateway.url, wrapperEnabled: true, allowedTools: ['config.patch'] }), env);
    const result = await createVectraExecuteTool(config).execute('call-1', { run_token: RUN_TOKEN, requested_tool: 'config.patch', args: { patch: [{ op: 'test' }] } });
    assert.equal(captured.url, '/v1/tools/execute');
    assert.equal(captured.auth, AUTH_TOKEN);
    assert.equal(result.details.receipt_token, 'receipt-token-1234567890');
  } finally { await gateway.close(); }
});

test('configuration and wrapper fail closed on unsafe input or receipt-less gateway output', async () => {
  assert.throws(() => resolveConfig(baseConfig({ gatewayUrl: 'https://example.invalid' }), env), /loopback/);
  assert.throws(() => resolveConfig(baseConfig(), { VECTRA_TOOL_GATEWAY_TOKEN: 'weak' }), /32 bytes/);
  assert.throws(() => resolveConfig(baseConfig({ nativePolicyEnabled: false, wrapperEnabled: false }), env), /one enforcement mode/);
  const config = resolveConfig(baseConfig({ wrapperEnabled: true, allowedTools: ['config.patch'] }), env);
  const tool = createVectraExecuteTool(config, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await assert.rejects(tool.execute('call', { run_token: RUN_TOKEN, requested_tool: 'config.patch', args: {} }), /receipt/);
});
