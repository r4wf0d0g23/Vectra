import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';

const role = process.env.CANARY_ROLE;
const secret = process.env.CANARY_SECRET ?? 'canary-only-secret';
const boundary = process.env.CANARY_BOUNDARY ?? 'vectra-boundary';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}
function sign(value) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function tokenFor(run) {
  const payload = Buffer.from(JSON.stringify({ runId: run.runId, nonce: run.nonce })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function verifyToken(token) {
  const [payload, signature] = String(token ?? '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}

async function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const raw = JSON.stringify(body);
    const req = httpRequest(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(raw);
  });
}

function providerService() {
  const attempts = new Map();
  return createServer(async (req, res) => {
    if (req.headers['x-vectra-boundary'] !== boundary) return json(res, 403, { error: 'direct_provider_bypass' });
    const body = JSON.parse(await readBody(req) || '{}');
    const key = String(req.headers['x-canary-run'] ?? 'unknown');
    const count = (attempts.get(key) ?? 0) + 1; attempts.set(key, count);
    if (body.canary_retry && count === 1) return json(res, 503, { error: { type: 'overloaded_error', message: 'retry me' } }, { 'retry-after': '0' });
    const raw = JSON.stringify(body);
    const hasToolResult = /tool_result|function_call_output|"role":"tool"/.test(raw);
    const stream = body.stream === true;
    const dialect = req.url === '/v1/messages' ? 'anthropic' : req.url === '/v1/responses' ? 'responses' : 'chat';
    const payload = hasToolResult ? { phase: 'final', text: `success:${dialect}` } : { phase: 'tool', id: 'call-1', name: 'mutate_state', input: { value: dialect } };
    if (!stream) return json(res, 200, payload);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (dialect === 'responses') {
      res.write(`event: ${hasToolResult ? 'response.output_text.done' : 'response.output_item.done'}\n`);
      res.write(`data: ${JSON.stringify(hasToolResult ? { type: 'response.output_text.done', text: payload.text } : { type: 'response.output_item.done', item: { type: 'function_call', call_id: payload.id, name: payload.name, arguments: JSON.stringify(payload.input) } })}\n\n`);
    } else if (dialect === 'chat') {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: hasToolResult ? { content: payload.text } : { tool_calls: [{ id: payload.id, function: { name: payload.name, arguments: JSON.stringify(payload.input) } }] } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
    } else {
      const event = hasToolResult
        ? { type: 'content_block_delta', delta: { type: 'text_delta', text: payload.text } }
        : { type: 'content_block_start', content_block: { type: 'tool_use', id: payload.id, name: payload.name, input: payload.input } };
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
    res.end();
  });
}

function toolService() {
  return createServer(async (req, res) => {
    if (req.url !== '/invoke' || req.headers['x-vectra-tool-gateway'] !== boundary) return json(res, 403, { error: 'direct_tool_bypass' });
    const body = JSON.parse(await readBody(req) || '{}');
    json(res, 200, { ok: true, mutation: true, evidenceHash: sign(JSON.stringify(body)), result: { changed: body.arguments?.value } });
  });
}

async function gatewayService() {
  const ledgerPath = process.env.CANARY_LEDGER;
  const toolUrl = process.env.CANARY_TOOL_URL;
  let state = { runs: {} };
  try { state = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch {}
  async function persist() {
    const temp = `${ledgerPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state)); await rename(temp, ledgerPath);
  }
  function authorized(req) {
    const decoded = verifyToken(req.headers['x-vectra-run-token']);
    const run = decoded && state.runs[decoded.runId];
    return run && run.nonce === decoded.nonce && ['pending', 'mutated', 'receipted'].includes(run.status) ? run : null;
  }
  return createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    if (req.url === '/runs/start') {
      const runId = body.runId ?? randomUUID();
      if (state.runs[runId]) return json(res, 409, { error: 'run_exists' });
      const run = state.runs[runId] = { runId, bundleId: body.bundleId, pinHash: body.pinHash, nonce: randomUUID(), status: 'pending', mutations: [], receipt: null };
      await persist(); return json(res, 201, { runId, bundleId: run.bundleId, pinHash: run.pinHash, runToken: tokenFor(run) });
    }
    const run = authorized(req);
    if (!run) return json(res, 401, { error: 'invalid_or_replayed_run_token' });
    if (req.url === '/tools/invoke') {
      const tool = await post(`${toolUrl}/invoke`, body, { 'x-vectra-tool-gateway': boundary });
      if (tool.status !== 200) return json(res, 502, { error: 'tool_failed', upstreamStatus: tool.status });
      const result = JSON.parse(tool.body); run.mutations.push({ tool: body.name, evidenceHash: result.evidenceHash }); run.status = 'mutated';
      await persist(); return json(res, 200, result);
    }
    if (req.url === '/runs/receipt') {
      if (body.runId !== run.runId || body.bundleId !== run.bundleId || body.pinHash !== run.pinHash || body.evidenceHash !== run.mutations.at(-1)?.evidenceHash) {
        run.status = 'violated'; await persist(); return json(res, 409, { error: 'receipt_mismatch' });
      }
      run.receipt = body; run.status = 'receipted'; await persist(); return json(res, 200, { valid: true });
    }
    if (req.url === '/runs/finalize') {
      if (run.status !== 'receipted') return json(res, 409, { error: 'terminal_receipt_required', status: run.status });
      run.status = 'completed'; await persist(); return json(res, 200, { release: true });
    }
    return json(res, 404, { error: 'not_found' });
  });
}

const server = role === 'provider' ? providerService() : role === 'tool' ? toolService() : role === 'gateway' ? await gatewayService() : null;
if (!server) throw new Error(`unknown CANARY_ROLE ${role}`);
server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ ready: true, role, port: server.address().port })}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
