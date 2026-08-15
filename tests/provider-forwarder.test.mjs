import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { ProviderForwarder } from '../dist/src/transport/provider-forwarder.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { await new Promise((resolve) => server.close(resolve)); }
async function call(base, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('supports chat completions and Responses API while preserving status and headers', async () => {
  const seen = [];
  const upstream = createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(207, { 'content-type': 'application/json', 'x-provider-id': 'abc', 'set-cookie': ['a=1', 'b=2'] });
      res.end('{"ok":true}');
    });
  });
  const upstreamUrl = await listen(upstream);
  const controller = { requiresHold: () => false, evaluate: () => ({ release: true }) };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    for (const path of ['/v1/chat/completions', '/v1/responses']) {
      const result = await call(proxyUrl, path, '{"model":"m","stream":false}', { authorization: 'Bearer test' });
      assert.equal(result.status, 207); assert.equal(result.headers['x-provider-id'], 'abc'); assert.equal(result.body, '{"ok":true}');
      assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
    }
    assert.deepEqual(seen.map((x) => x.url), ['/v1/chat/completions', '/v1/responses']);
    assert.ok(seen.every((x) => x.auth === 'Bearer test'));
  } finally { await close(proxy); await close(upstream); }
});

test('release-controller failure is fail-closed', async () => {
  const upstream = createServer((_req, res) => res.end('PRIVATE OUTPUT'));
  const upstreamUrl = await listen(upstream);
  const controller = { requiresHold: () => true, evaluate: () => { throw new Error('validator offline'); } };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    const result = await call(proxyUrl, '/v1/responses', '{"input":"mutate state"}');
    assert.equal(result.status, 503); assert.doesNotMatch(result.body, /PRIVATE OUTPUT|validator offline/);
    assert.match(result.body, /enforcement_unavailable/);
  } finally { await close(proxy); await close(upstream); }
});

test('held SSE response is invisible until approved, then released byte-identically', async () => {
  const sse = 'event: response.output_text.delta\ndata: {"delta":"hi"}\n\nevent: response.completed\ndata: {}\n\n';
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'x-stream': 'yes' }); res.end(sse); });
  const upstreamUrl = await listen(upstream);
  let evaluated = false;
  const controller = { requiresHold: () => true, evaluate: async (exchange) => { evaluated = true; assert.equal(Buffer.from(exchange.responseBody).toString(), sse); return { release: true }; } };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    const result = await call(proxyUrl, '/v1/responses', '{"input":"deploy it","stream":true}');
    assert.equal(evaluated, true); assert.equal(result.body, sse); assert.equal(result.headers['x-stream'], 'yes');
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(sse));
  } finally { await close(proxy); await close(upstream); }
});

test('denied held response fails closed without leaking provider bytes', async () => {
  const upstream = createServer((_req, res) => { res.end('SECRET MODEL OUTPUT'); });
  const upstreamUrl = await listen(upstream);
  const controller = { requiresHold: () => true, evaluate: () => ({ release: false, code: 'receipt_invalid', message: 'ATP receipt missing' }) };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    const result = await call(proxyUrl, '/v1/chat/completions', '{"messages":[{"role":"user","content":"change config"}]}');
    assert.equal(result.status, 409); assert.doesNotMatch(result.body, /SECRET/); assert.match(result.body, /receipt_invalid/);
  } finally { await close(proxy); await close(upstream); }
});

test('enforces request and held response size limits', async () => {
  const upstream = createServer((_req, res) => res.end('123456789'));
  const upstreamUrl = await listen(upstream);
  const controller = { requiresHold: () => true, evaluate: () => ({ release: true }) };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller, maxRequestBytes: 30, maxHeldResponseBytes: 8 }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    const oversizedRequest = await call(proxyUrl, '/v1/responses', JSON.stringify({ input: 'x'.repeat(100) }));
    assert.equal(oversizedRequest.status, 413);
    const oversizedResponse = await call(proxyUrl, '/v1/responses', '{"input":"x"}');
    assert.equal(oversizedResponse.status, 502); assert.match(oversizedResponse.body, /held_response_too_large/);
  } finally { await close(proxy); await close(upstream); }
});
