import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { isLocallyAuthenticated, requireStrongLocalToken } from './local-auth.js';
import { ReadinessService, atpParserProbe, durableStoreProbe, terminalLifecycleProbe, toolGatewayProbe, upstreamProbe, validatorProbe } from './readiness.js';
import { loadValidatorConfig } from '../validation/config.js';
import { createAtpProviderProxy } from '../transport/atp-provider-proxy.js';
import { AtpToolGateway } from '../atp/tool-gateway.js';
import { handleToolGatewayApi } from '../transport/tool-gateway-api.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const atpPath = resolve(required('VECTRA_ATP_PATH'));
const snapshotPath = resolve(required('VECTRA_SNAPSHOT_PATH'));
const ledgerPath = resolve(required('VECTRA_LEDGER_PATH'));
const validatorConfigPath = resolve(required('VECTRA_VALIDATOR_CONFIG'));
const upstreamBaseUrl = required('VECTRA_UPSTREAM_URL');
const upstreamToken = required('VECTRA_UPSTREAM_TOKEN');
const proxyToken = required('VECTRA_PROXY_TOKEN');
const port = Number(process.env['VECTRA_PROXY_PORT'] ?? '18800');
const mode = process.env['VECTRA_ENFORCEMENT_MODE'] ?? 'enforce';
if (mode !== 'enforce' && mode !== 'observe') throw new Error('VECTRA_ENFORCEMENT_MODE must be enforce or observe');
requireStrongLocalToken(proxyToken);

const toolRoot = resolve(required('VECTRA_TOOL_GATEWAY_PATH'));
const signingRaw = required('VECTRA_RUN_TOKEN_SIGNING_KEY');
const signingKey = /^[a-f0-9]{64}$/i.test(signingRaw) ? Buffer.from(signingRaw, 'hex') : Buffer.from(signingRaw, 'base64');
if (signingKey.length < 32) throw new Error('VECTRA_RUN_TOKEN_SIGNING_KEY must decode to at least 32 bytes');
const toolGateway = new AtpToolGateway(toolRoot, signingKey);

const { config: validatorConfig } = await loadValidatorConfig(validatorConfigPath);
const validatorAdapters = JSON.parse(required('VECTRA_VALIDATOR_ADAPTERS')) as Record<string, string>;
for (const [varId, adapterId] of Object.entries(validatorAdapters)) {
  if (!/^[a-z0-9-]+$/.test(varId) || !validatorConfig.adapters.some((adapter) => adapter.id === adapterId)) {
    throw new Error(`invalid or unavailable validator adapter mapping: ${varId}`);
  }
}

const readiness = new ReadinessService([
  atpParserProbe(atpPath), durableStoreProbe('snapshot-store', snapshotPath), durableStoreProbe('ledger', ledgerPath),
  validatorProbe(validatorConfigPath), upstreamProbe(upstreamBaseUrl, upstreamToken),
  terminalLifecycleProbe(mode === 'enforce', mode === 'observe'),
  toolGatewayProbe(() => toolGateway.reconcile()),
]);
await readiness.reconcileStartup();

const proxy = await createAtpProviderProxy({
  mode, instancePath: atpPath, snapshotPath, ledgerPath,
  validatorSocketPath: validatorConfig.socketPath, validatorAdapters,
  pluginVersion: process.env['npm_package_version'] ?? '0.1.0', upstreamBaseUrl,
  upstreamAuthorization: `Bearer ${upstreamToken}`,
  toolGateway: mode === 'enforce' ? toolGateway : undefined,
});

const server = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({status:'ok',mode})); return; }
  if (!isLocallyAuthenticated(req, proxyToken)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"local authentication required"}'); return; }
  if (req.url === '/ready' && req.method === 'GET') { const report = await readiness.check(); res.writeHead(report.ready ? 200 : 503, { 'content-type': 'application/json' }); res.end(JSON.stringify(report)); return; }
  if (await handleToolGatewayApi(toolGateway, req, res)) return;
  if (!req.url?.startsWith('/v1/')) { res.writeHead(404).end(); return; }
  await proxy.handle(req, res);
});

await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
let stopping = false;
const shutdown = (): void => {
  if (stopping) return; stopping = true;
  const timer = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, Number(process.env['VECTRA_SHUTDOWN_GRACE_MS'] ?? '15000'));
  server.close(() => { clearTimeout(timer); process.exit(0); });
};
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
