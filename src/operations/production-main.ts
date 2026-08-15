import { resolve } from 'node:path';
import { loadConfig } from '../../config/vectra.config.js';
import { AtpLoader } from '../atp/loader.js';
import { AtpDispatchMatcher } from '../atp/matcher.js';
import { Dispatcher } from '../core/dispatcher.js';
import { ContextEngine } from '../core/context.js';
import { IntakeGate } from '../gates/intake.js';
import { ReceiptGate } from '../gates/receipt.js';
import { TelemetryEmitter } from '../telemetry/emitter.js';
import { VectraProxy } from '../transport/proxy.js';
import { ReadinessService, atpParserProbe, durableStoreProbe, upstreamProbe, validatorProbe } from './readiness.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const atpPath = resolve(required('VECTRA_ATP_PATH'));
const snapshotPath = resolve(required('VECTRA_SNAPSHOT_PATH'));
const ledgerPath = resolve(required('VECTRA_LEDGER_PATH'));
const validatorConfig = resolve(required('VECTRA_VALIDATOR_CONFIG'));
const artifactsPath = resolve(required('VECTRA_ARTIFACTS_PATH'));
const telemetryPath = resolve(required('VECTRA_TELEMETRY_PATH'));
const upstreamBaseUrl = required('VECTRA_UPSTREAM_URL');
const upstreamToken = required('VECTRA_UPSTREAM_TOKEN');

const config = loadConfig({
  atpInstancePath: atpPath,
  checkpointPath: snapshotPath,
  telemetryPath,
  upstreamBaseUrl,
  upstreamAuthToken: upstreamToken,
  proxyPort: Number(process.env['VECTRA_PROXY_PORT'] ?? '18800'),
  proxyAuthToken: required('VECTRA_PROXY_TOKEN'),
  proxyShutdownGraceMs: Number(process.env['VECTRA_SHUTDOWN_GRACE_MS'] ?? '15000'),
});
const loader = new AtpLoader(atpPath);
const data = await loader.load();
const guardrails = new Map([...data.protocols].map(([id, protocol]) => [id, protocol.frontmatter.guardrails ?? []]));
const matcher = new AtpDispatchMatcher(data.routingTable, guardrails);
const readiness = new ReadinessService([
  atpParserProbe(atpPath),
  durableStoreProbe('snapshot-store', snapshotPath),
  durableStoreProbe('ledger', ledgerPath),
  validatorProbe(validatorConfig),
  upstreamProbe(upstreamBaseUrl, upstreamToken),
]);
const telemetry = new TelemetryEmitter(telemetryPath);
const proxy = new VectraProxy({
  config,
  matcher,
  dispatcher: new Dispatcher(),
  contextEngine: new ContextEngine(),
  intakeGate: new IntakeGate(matcher),
  receiptGate: new ReceiptGate(artifactsPath),
  telemetry,
  readiness,
});

await loader.startWatching();
telemetry.startPeriodicFlush(config.telemetryFlushIntervalMs);
await proxy.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stderr.write(JSON.stringify({ type: 'vectra.proxy.shutdown', signal, timestamp: new Date().toISOString() }) + '\n');
  loader.stopWatching();
  await proxy.stop();
  await telemetry.stop();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal).then(() => process.exit(0), () => process.exit(1)));
}
