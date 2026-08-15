#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const pluginPath = join(repo, 'integrations/openclaw-vectra-tool');
const openclawBin = process.env.OPENCLAW_BIN ?? 'openclaw';
const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
const openclawRoot = process.env.OPENCLAW_PACKAGE_ROOT ?? join(npmRoot, 'openclaw');
const dist = join(openclawRoot, 'dist');

async function moduleByPrefix(prefix, marker) {
  let name;
  for (const file of await readdir(dist)) {
    if (file.startsWith(prefix) && file.endsWith('.js') && (await readFile(join(dist, file), 'utf8')).includes(marker)) { name = file; break; }
  }
  if (!name) throw new Error(`installed OpenClaw module not found: ${prefix}`);
  return import(pathToFileURL(join(dist, name)).href);
}

const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const state = { expected: null, authorizations: [], results: [], receipts: new Map() };
const secret = 'isolated-canary-secret-'.padEnd(48, 's');

const gateway = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.headers.authorization, `Bearer ${secret}`);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/tool-policy/authorize') {
    state.authorizations.push(body);
    if (!state.expected || canonical(body) !== canonical(state.expected)) { res.statusCode = 409; return res.end(JSON.stringify({ authorized: false, error: 'not-authorized' })); }
    return res.end(JSON.stringify({ authorized: true, runId: 'run_canary', sequence: 0, nonce: 'nonce-canary' }));
  }
  if (req.url === '/v1/tool-policy/result') {
    state.results.push(body);
    const key = `${body.openClawRunId}:${body.toolCallId}`;
    const resultHash = sha({ result: body.result, isError: Boolean(body.isError) });
    const prior = state.receipts.get(key);
    if (prior && prior.resultSha256 !== resultHash) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'result-retry-diverged' })); }
    const receipt = prior ?? { callId: body.toolCallId, tool: body.tool, argsSha256: sha(body.args), resultSha256: resultHash, completedAt: new Date().toISOString() };
    state.receipts.set(key, receipt);
    return res.end(JSON.stringify(receipt));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((resolveListen) => gateway.listen(0, '127.0.0.1', resolveListen));
const gatewayAddress = gateway.address();
const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;

const temp = await mkdtemp(join(tmpdir(), 'vectra-openclaw-canary-'));
const workspace = join(temp, 'workspace');
await mkdir(workspace);
const configPath = join(temp, 'openclaw.json');
const pluginConfig = {
  gatewayUrl, authTokenEnv: 'VECTRA_TOOL_GATEWAY_TOKEN', protectedAgentIds: ['vectra-canary'],
  nativePolicyEnabled: true, wrapperEnabled: false, timeoutMs: 3000,
};
const config = {
  plugins: {
    allow: ['vectra-tool-wrapper'], bundledDiscovery: 'allowlist', load: { paths: [pluginPath] },
    entries: { 'vectra-tool-wrapper': { enabled: true, config: pluginConfig } },
  },
};
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const isolatedEnv = {
  ...process.env, HOME: temp, XDG_CONFIG_HOME: join(temp, '.config'),
  OPENCLAW_STATE_DIR: temp, OPENCLAW_CONFIG_PATH: configPath,
  VECTRA_TOOL_GATEWAY_TOKEN: secret,
};
process.env.VECTRA_TOOL_GATEWAY_TOKEN = secret;

const inspect = spawnSync(openclawBin, ['plugins', 'inspect', 'vectra-tool-wrapper', '--runtime', '--json'], {
  env: isolatedEnv, encoding: 'utf8', timeout: 30_000,
});
assert.equal(inspect.status, 0, `isolated plugin inspect failed: ${inspect.stderr || inspect.stdout}`);
assert.match(inspect.stdout, /vectra-tool-wrapper/);

const loader = await moduleByPrefix('loader-', 'function loadOpenClawPlugins');
const before = await moduleByPrefix('agent-tools.before-tool-call-', 'async function runBeforeToolCallHook');
const middlewareModule = await moduleByPrefix('tool-result-middleware-', 'function createAgentToolResultMiddlewareRunner');
const loadOpenClawPlugins = loader.s;
const runBeforeToolCallHook = before.f;
const createMiddlewareRunner = middlewareModule.t;
assert.equal(typeof loadOpenClawPlugins, 'function');
assert.equal(typeof runBeforeToolCallHook, 'function');
assert.equal(typeof createMiddlewareRunner, 'function');

const registry = loadOpenClawPlugins({
  config, activationSourceConfig: config, env: isolatedEnv, workspaceDir: workspace,
  onlyPluginIds: ['vectra-tool-wrapper'], cache: false, activate: true,
});
assert.equal(registry.plugins.find((plugin) => plugin.id === 'vectra-tool-wrapper')?.status, 'loaded');
assert.equal(registry.trustedToolPolicies.filter((item) => item.pluginId === 'vectra-tool-wrapper').length, 1);
assert.equal(registry.agentToolResultMiddlewares.filter((item) => item.pluginId === 'vectra-tool-wrapper').length, 1);

const ctx = { agentId: 'vectra-canary', runId: 'oc-canary-run', workspaceDir: workspace, config, loopDetection: { enabled: false } };
let sentinelExecutions = 0;
const blocked = await runBeforeToolCallHook({ toolName: 'exec', toolCallId: 'blocked-call', params: { command: 'sentinel' }, ctx });
if (!blocked.blocked) sentinelExecutions++;
assert.equal(blocked.blocked, true);
assert.equal(sentinelExecutions, 0);

const args = { command: 'sentinel' };
state.expected = { openClawRunId: ctx.runId, toolCallId: 'approved-call', tool: 'exec', args };
const approved = await runBeforeToolCallHook({ toolName: 'exec', toolCallId: 'approved-call', params: args, ctx });
assert.equal(approved.blocked, false);
sentinelExecutions++;
const nativeResult = { content: [{ type: 'text', text: 'sentinel-ok' }], details: { counter: sentinelExecutions } };
const runner = createMiddlewareRunner({ runtime: 'openclaw', agentId: ctx.agentId, runId: ctx.runId });
const released = await runner.applyToolResultMiddleware({ toolCallId: 'approved-call', toolName: 'exec', args, result: nativeResult, isError: false });
assert.deepEqual(released, nativeResult);
assert.equal(sentinelExecutions, 1);
assert.equal(state.receipts.size, 1);
assert.deepEqual(state.results[0], { openClawRunId: ctx.runId, toolCallId: 'approved-call', tool: 'exec', args, result: nativeResult, isError: false });

await new Promise((resolveClose) => gateway.close(resolveClose));
await rm(temp, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true, profileRoot: temp, pluginStatus: 'loaded', trustedPolicies: 1,
  resultMiddlewares: 1, preBlocked: true, approvedExecutions: sentinelExecutions,
  receipts: state.receipts.size, gatewayUrlPropagated: state.authorizations.length === 2,
  authEnvPropagated: true, profileRemoved: true,
}));
