import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const serviceScript = new URL('./mock-process.mjs', import.meta.url);
const secret = 'e2e-secret-not-production';
const boundary = 'e2e-boundary';

async function spawnService(role, extra = {}) {
  const child = spawn(process.execPath, [serviceScript.pathname], { env: { ...process.env, CANARY_ROLE: role, CANARY_SECRET: secret, CANARY_BOUNDARY: boundary, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`${role} readiness timeout`)), 2000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.once('exit', (code) => reject(new Error(`${role} exited ${code}`)));
  });
  return { child, url: `http://127.0.0.1:${ready.port}` };
}
async function stop(service) {
  if (!service || service.child.exitCode !== null) return;
  service.child.kill('SIGTERM');
  await new Promise((resolve) => service.child.once('exit', resolve));
}
async function post(url, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
function parseProviderOutput(dialect, text, streamed) {
  if (!streamed) return JSON.parse(text);
  const records = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).filter((line) => line !== '[DONE]').map(JSON.parse);
  if (dialect === 'responses') {
    const record = records[0];
    return record.item ? { phase: 'tool', id: record.item.call_id, name: record.item.name, input: JSON.parse(record.item.arguments) } : { phase: 'final', text: record.text };
  }
  if (dialect === 'chat') {
    const delta = records[0].choices[0].delta;
    return delta.tool_calls ? { phase: 'tool', id: delta.tool_calls[0].id, name: delta.tool_calls[0].function.name, input: JSON.parse(delta.tool_calls[0].function.arguments) } : { phase: 'final', text: delta.content };
  }
  const record = records.find((item) => item.type !== 'message_stop');
  return record.content_block ? { phase: 'tool', id: record.content_block.id, name: record.content_block.name, input: record.content_block.input } : { phase: 'final', text: record.delta.text };
}
function providerRequest(dialect, stream, toolResult, retry = false) {
  const common = { model: 'canary', stream, canary_retry: retry };
  if (dialect === 'responses') return { path: '/v1/responses', body: { ...common, input: toolResult ? [{ type: 'function_call_output', call_id: 'call-1', output: JSON.stringify(toolResult) }] : 'mutate' } };
  if (dialect === 'chat') return { path: '/v1/chat/completions', body: { ...common, messages: toolResult ? [{ role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(toolResult) }] : [{ role: 'user', content: 'mutate' }] } };
  return { path: '/v1/messages', body: { ...common, max_tokens: 64, messages: toolResult ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: JSON.stringify(toolResult) }] }] : [{ role: 'user', content: 'mutate' }] } };
}
async function providerTurn(provider, runId, dialect, stream, toolResult, retry = false) {
  const { path, body } = providerRequest(dialect, stream, toolResult, retry);
  let response = await post(provider.url + path, body, { 'x-vectra-boundary': boundary, 'x-canary-run': runId });
  if (response.status === 503) response = await post(provider.url + path, body, { 'x-vectra-boundary': boundary, 'x-canary-run': runId });
  assert.equal(response.status, 200);
  return parseProviderOutput(dialect, response.text, stream);
}

test('real-process lifecycle gates terminal success for all provider dialects and streaming', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vectra-canary-'));
  const ledger = join(dir, 'ledger.json');
  const provider = await spawnService('provider');
  const tool = await spawnService('tool');
  const gateway = await spawnService('gateway', { CANARY_LEDGER: ledger, CANARY_TOOL_URL: tool.url });
  t.after(async () => { await stop(gateway); await stop(tool); await stop(provider); });

  for (const [index, dialect] of ['responses', 'chat', 'anthropic'].entries()) {
    const runId = `run-${dialect}`;
    const start = await post(gateway.url + '/runs/start', { runId, bundleId: `bundle-${dialect}`, pinHash: `pin-${dialect}` });
    assert.equal(start.status, 201); const identity = JSON.parse(start.text); const auth = { 'x-vectra-run-token': identity.runToken };
    const toolCall = await providerTurn(provider, runId, dialect, true, null, index === 0);
    assert.equal(toolCall.phase, 'tool');
    const invoked = await post(gateway.url + '/tools/invoke', { name: toolCall.name, arguments: toolCall.input }, auth);
    assert.equal(invoked.status, 200, invoked.text); const toolResult = JSON.parse(invoked.text);
    const terminal = await providerTurn(provider, runId, dialect, true, toolResult);
    assert.equal(terminal.phase, 'final');
    const premature = await post(gateway.url + '/runs/finalize', {}, auth);
    assert.equal(premature.status, 409);
    const receipt = await post(gateway.url + '/runs/receipt', { runId, bundleId: identity.bundleId, pinHash: identity.pinHash, evidenceHash: toolResult.evidenceHash }, auth);
    assert.equal(receipt.status, 200);
    const final = await post(gateway.url + '/runs/finalize', {}, auth);
    assert.equal(final.status, 200); assert.equal(JSON.parse(final.text).release, true);
    assert.match(terminal.text, new RegExp(dialect));
    const replay = await post(gateway.url + '/tools/invoke', { name: 'mutate_state', arguments: {} }, auth);
    assert.equal(replay.status, 401);
  }
});

test('crash after mutation resumes pending and requires the durable receipt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vectra-crash-')); const ledger = join(dir, 'ledger.json');
  const tool = await spawnService('tool');
  let gateway = await spawnService('gateway', { CANARY_LEDGER: ledger, CANARY_TOOL_URL: tool.url });
  t.after(async () => { await stop(gateway); await stop(tool); });
  const identity = JSON.parse((await post(gateway.url + '/runs/start', { runId: 'crash-run', bundleId: 'bundle', pinHash: 'pin' })).text);
  const auth = { 'x-vectra-run-token': identity.runToken };
  const mutationResponse = await post(gateway.url + '/tools/invoke', { name: 'mutate_state', arguments: { value: 1 } }, auth);
  assert.equal(mutationResponse.status, 200, mutationResponse.text);
  const mutation = JSON.parse(mutationResponse.text);
  await stop(gateway);
  gateway = await spawnService('gateway', { CANARY_LEDGER: ledger, CANARY_TOOL_URL: tool.url });
  assert.equal((await post(gateway.url + '/runs/finalize', {}, auth)).status, 409);
  assert.equal((await post(gateway.url + '/runs/receipt', { runId: 'crash-run', bundleId: 'bundle', pinHash: 'pin', evidenceHash: mutation.evidenceHash }, auth)).status, 200);
  assert.equal((await post(gateway.url + '/runs/finalize', {}, auth)).status, 200);
  const persisted = JSON.parse(await readFile(ledger, 'utf8'));
  assert.equal(persisted.runs['crash-run'].status, 'completed');
});

test('rejects forged token, mismatched receipt, and direct provider/tool bypass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vectra-adversary-')); const ledger = join(dir, 'ledger.json');
  const provider = await spawnService('provider'); const tool = await spawnService('tool');
  const gateway = await spawnService('gateway', { CANARY_LEDGER: ledger, CANARY_TOOL_URL: tool.url });
  t.after(async () => { await stop(gateway); await stop(tool); await stop(provider); });
  const identity = JSON.parse((await post(gateway.url + '/runs/start', { runId: 'secure-run', bundleId: 'bundle', pinHash: 'pin' })).text);
  const forged = identity.runToken.slice(0, -1) + (identity.runToken.endsWith('a') ? 'b' : 'a');
  assert.equal((await post(gateway.url + '/tools/invoke', { name: 'mutate_state' }, { 'x-vectra-run-token': forged })).status, 401);
  assert.equal((await post(provider.url + '/v1/responses', { input: 'bypass' })).status, 403);
  assert.equal((await post(tool.url + '/invoke', { name: 'mutate_state' })).status, 403);
  const auth = { 'x-vectra-run-token': identity.runToken };
  const mutationResponse = await post(gateway.url + '/tools/invoke', { name: 'mutate_state', arguments: { value: 1 } }, auth);
  assert.equal(mutationResponse.status, 200, mutationResponse.text);
  const mutation = JSON.parse(mutationResponse.text);
  assert.ok(mutation.evidenceHash);
  assert.equal((await post(gateway.url + '/runs/receipt', { runId: 'secure-run', bundleId: 'wrong', pinHash: 'pin', evidenceHash: mutation.evidenceHash }, auth)).status, 409);
  assert.equal((await post(gateway.url + '/runs/finalize', {}, auth)).status, 401);
});
