import { appendFile, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';

const env = Object.fromEntries((await readFile(process.env.VECTRA_CANARY_ENV, 'utf8'))
  .split(/\r?\n/).filter(Boolean).map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
const socketPath = process.env.VECTRA_CANARY_SOCKET;
if (!socketPath) throw new Error('VECTRA_CANARY_SOCKET is required');
const headers = { 'content-type': 'application/json', 'x-vectra-token': env.VECTRA_PROXY_TOKEN };
const started = Date.now();
const checks = [];

async function check(name, fn) {
  const begin = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, ok: true, duration_ms: Date.now() - begin, detail });
  } catch (error) {
    checks.push({ name, ok: false, duration_ms: Date.now() - begin, error: error instanceof Error ? error.message : String(error) });
  }
}

function socketRequest(path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('socket request timed out')));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

await check('readiness', async () => {
  const response = await socketRequest('/ready', { timeoutMs: 15_000 });
  const body = JSON.parse(response.text);
  if (response.status !== 200 || body.ready !== true) throw new Error(`not ready: ${response.status}`);
  return { status: response.status, probes: body.probes?.length ?? 0, transport: 'unix-socket' };
});

await check('responses-nonstream', async () => {
  const response = await socketRequest('/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'Reply with exactly WORKLOAD_OK.', max_output_tokens: 24 }) });
  const body = JSON.parse(response.text);
  const output = (body.output ?? []).flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text').map((item) => item.text).join('');
  if (response.status !== 200 || output !== 'WORKLOAD_OK') throw new Error(`completion failed: ${response.status}`);
  return { status: response.status, marker: true };
});

await check('responses-stream', async () => {
  const response = await socketRequest('/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'Reply with exactly STREAM_OK.', stream: true, max_output_tokens: 24 }) });
  const text = response.text;
  const events = text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    return data;
  }).filter((data) => data && data !== '[DONE]').map((data) => JSON.parse(data));
  const output = events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('');
  const completed = events.some((event) => event.type === 'response.completed' && event.response?.status === 'completed');
  if (response.status !== 200 || output !== 'STREAM_OK' || !completed) throw new Error(`stream failed: ${response.status}`);
  return { status: response.status, marker: true, sse: true };
});

await check('direct-provider-egress-denied', async () => {
  await new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '1.1.1.1', port: 443, path: '/', servername: 'cloudflare-dns.com', timeout: 5_000 }, () => reject(new Error('external network unexpectedly reachable')));
    req.on('error', (error) => error.code === 'ENETUNREACH' ? resolve(error.code) : reject(error));
    req.on('timeout', () => req.destroy(new Error('ambiguous external network timeout')));
    req.end();
  });
  return { blocked_observed: true, error_code: 'ENETUNREACH' };
});

const event = {
  schema_version: '1.0.0', observed_at: new Date().toISOString(), duration_ms: Date.now() - started,
  identity: 'vectra-canary-workload.service', invocation_id: process.env.INVOCATION_ID, network_policy_claim: 'private-network namespace; Vectra reachable only through Unix socket bridge', checks,
  provider_reachable_via_vectra: checks.some((item) => item.name === 'responses-nonstream' && item.ok),
  ok: checks.every((item) => item.ok),
};
await appendFile(process.env.VECTRA_CANARY_WORKLOAD_LOG, `${JSON.stringify(event)}\n`, { mode: 0o600 });
if (!event.ok) process.exitCode = 1;
