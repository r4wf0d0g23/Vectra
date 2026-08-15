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

test('supports Anthropic Messages and preserves required provider headers', async () => {
  let seen;
  const upstream = createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      seen = { url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], beta: req.headers['anthropic-beta'], body: Buffer.concat(chunks).toString() };
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_123' });
      res.end('{"type":"message","content":[{"type":"text","text":"ok"}]}');
    });
  });
  const upstreamUrl = await listen(upstream);
  const controller = { requiresHold: () => false, evaluate: () => ({ release: true }) };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    const body = '{"model":"claude-test","max_tokens":32,"messages":[{"role":"user","content":"hello"}]}';
    const result = await call(proxyUrl, '/v1/messages?beta=true', body, {
      'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-2025-01-01',
    });
    assert.equal(result.status, 200); assert.equal(result.headers['request-id'], 'req_123');
    assert.equal(seen.url, '/v1/messages?beta=true'); assert.equal(seen.key, 'test-key');
    assert.equal(seen.version, '2023-06-01'); assert.equal(seen.beta, 'tools-2025-01-01'); assert.equal(seen.body, body);
  } finally { await close(proxy); await close(upstream); }
});

test('holds and releases Anthropic event-stream byte-identically with extracted user task', async () => {
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_sse' }); res.end(sse); });
  const upstreamUrl = await listen(upstream);
  let exchange;
  const controller = { requiresHold: (api) => api === 'anthropic-messages', evaluate: (value) => { exchange = value; return { release: true }; } };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    const body = JSON.stringify({ model: 'claude-test', stream: true, max_tokens: 32, messages: [
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'deploy safely' }, { type: 'image', source: {} }] },
    ] });
    const result = await call(proxyUrl, '/v1/messages', body, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
    assert.equal(result.status, 200); assert.equal(result.body, sse); assert.equal(result.headers['request-id'], 'req_sse');
    assert.equal(exchange.api, 'anthropic-messages'); assert.equal(exchange.taskDescription, 'deploy safely');
    assert.equal(Buffer.from(exchange.responseBody).toString(), sse);
  } finally { await close(proxy); await close(upstream); }
});

test('passes Anthropic upstream errors through unchanged', async () => {
  const errorBody = '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}';
  const upstream = createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_error' }); res.end(errorBody); });
  const upstreamUrl = await listen(upstream);
  const controller = { requiresHold: () => false, evaluate: () => ({ release: true }) };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: upstreamUrl, releaseController: controller }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    const result = await call(proxyUrl, '/v1/messages', '{"messages":[]}');
    assert.equal(result.status, 401); assert.equal(result.headers['request-id'], 'req_error'); assert.equal(result.body, errorBody);
  } finally { await close(proxy); await close(upstream); }
});

test('aborts the Anthropic upstream fetch when the downstream disconnects', async () => {
  let markAborted;
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      markAborted(options.signal.reason);
      reject(options.signal.reason);
    }, { once: true });
  });
  const controller = { requiresHold: () => false, evaluate: () => ({ release: true }) };
  const proxy = createServer((req, res) => new ProviderForwarder({ upstreamBaseUrl: 'http://provider.invalid', releaseController: controller, fetchImpl }).forward(req, res));
  const proxyUrl = await listen(proxy);
  try {
    await new Promise((resolve) => {
      const req = request(proxyUrl + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' } });
      req.on('error', () => resolve());
      req.end('{"messages":[]}');
      setTimeout(() => { req.destroy(); resolve(); }, 10);
    });
    const reason = await Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 500)),
    ]);
    assert.match(String(reason), /downstream disconnected/);
  } finally { await close(proxy); }
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
