const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function loopbackUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(host) || url.username || url.password) {
    throw new Error('gatewayUrl must be an unauthenticated HTTP loopback URL');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export function resolveConfig(input = {}, env = process.env) {
  const gatewayUrl = loopbackUrl(input.gatewayUrl ?? 'http://127.0.0.1:18801');
  const authTokenEnv = input.authTokenEnv ?? 'VECTRA_TOOL_GATEWAY_TOKEN';
  if (!ENV_NAME.test(authTokenEnv)) throw new Error('authTokenEnv is invalid');
  const authToken = env[authTokenEnv];
  if (typeof authToken !== 'string' || Buffer.byteLength(authToken) < 32) throw new Error(`${authTokenEnv} must contain at least 32 bytes`);
  if (!Array.isArray(input.allowedTools) || input.allowedTools.length === 0 || input.allowedTools.some((name) => !TOOL_NAME.test(name))) {
    throw new Error('allowedTools must be a non-empty array of valid tool names');
  }
  if (!Array.isArray(input.protectedAgentIds) || input.protectedAgentIds.length === 0 || input.protectedAgentIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id))) {
    throw new Error('protectedAgentIds must be a non-empty array of valid agent IDs');
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxRequestBytes = input.maxRequestBytes ?? 256 * 1024;
  const maxResponseBytes = input.maxResponseBytes ?? 256 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('timeoutMs is out of range');
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1024 || maxRequestBytes > 1024 * 1024) throw new Error('maxRequestBytes is out of range');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 1024 * 1024) throw new Error('maxResponseBytes is out of range');
  return { gatewayUrl, authToken, allowedTools: new Set(input.allowedTools), protectedAgentIds: new Set(input.protectedAgentIds), timeoutMs, maxRequestBytes, maxResponseBytes };
}

export function createVectraOnlyPolicy(protectedAgentIds) {
  return {
    id: 'vectra-only',
    description: 'Fail closed so protected canary agents can execute only vectra_execute.',
    evaluate(event, ctx) {
      if (!ctx?.agentId || !protectedAgentIds.has(ctx.agentId)) return;
      if (event?.toolName === 'vectra_execute') return { allow: true };
      return { allow: false, reason: `Agent ${ctx.agentId} must route tool execution through vectra_execute` };
    },
  };
}

function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  const { run_token: runToken, requested_tool: requestedTool, args: toolArgs } = args;
  if (typeof runToken !== 'string' || runToken.length < 32 || runToken.length > 8192 || /\s/.test(runToken)) throw new Error('run_token is invalid');
  if (typeof requestedTool !== 'string' || !TOOL_NAME.test(requestedTool)) throw new Error('requested_tool is invalid');
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) throw new Error('args must be a structured object');
  return { runToken, requestedTool, toolArgs };
}

async function boundedJson(response, maxBytes) {
  if (!response.body) throw new Error('Vectra gateway returned an empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) { await reader.cancel(); throw new Error('Vectra gateway response exceeded configured limit'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks.map((value) => Buffer.from(value))).toString('utf8')); }
  catch { throw new Error('Vectra gateway returned invalid JSON'); }
}

function validateGatewayResult(value) {
  if (!value || typeof value !== 'object' || value.ok !== true || typeof value.receipt_token !== 'string' || value.receipt_token.length < 16) {
    throw new Error('Vectra gateway did not return a valid result and receipt token');
  }
  return { ok: true, run_id: typeof value.run_id === 'string' ? value.run_id : undefined, result: value.result, receipt_token: value.receipt_token };
}

export function createVectraExecuteTool(config, fetchImpl = fetch) {
  return {
    name: 'vectra_execute',
    label: 'Vectra Execute',
    description: 'Execute one Vectra-authorized tool using a signed run token. This is the only mutation bridge; it cannot execute tools directly.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['run_token', 'requested_tool', 'args'],
      properties: {
        run_token: { type: 'string', minLength: 32, maxLength: 8192, pattern: '^\\S+$' },
        requested_tool: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,63}$' },
        args: { type: 'object', additionalProperties: true },
      },
    },
    async execute(toolCallId, rawArgs, signal) {
      const { runToken, requestedTool, toolArgs } = validateArgs(rawArgs);
      if (!config.allowedTools.has(requestedTool)) throw new Error(`requested tool is not enabled for this canary: ${requestedTool}`);
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let body;
      try { body = JSON.stringify({ run_token: runToken, requested_tool: requestedTool, args: toolArgs, tool_call_id: toolCallId }); }
      catch { throw new Error('args must be acyclic JSON data'); }
      if (Buffer.byteLength(body) > config.maxRequestBytes) throw new Error('Vectra gateway request exceeded configured limit');
      const response = await fetchImpl(new URL('/v1/tools/execute', config.gatewayUrl), {
        method: 'POST', signal: combined,
        headers: { 'content-type': 'application/json', 'x-vectra-token': config.authToken },
        body,
      });
      const payload = await boundedJson(response, config.maxResponseBytes);
      if (!response.ok) throw new Error(`Vectra gateway denied execution (HTTP ${response.status})`);
      const result = validateGatewayResult(payload);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
