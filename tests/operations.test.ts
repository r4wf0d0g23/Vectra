import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isLocallyAuthenticated, requireStrongLocalToken } from '../src/operations/local-auth.js';
import { ReadinessService, atpParserProbe, durableStoreProbe, upstreamProbe, type ReadinessProbe } from '../src/operations/readiness.js';

test('local authentication is mandatory and timing-safe over fixed digests', () => {
  assert.throws(() => requireStrongLocalToken('short'), /32 bytes/);
  requireStrongLocalToken('a'.repeat(32));
  const request = (token?: string) => ({ headers: token ? { 'x-vectra-token': token } : {} }) as never;
  assert.equal(isLocallyAuthenticated(request(), 'a'.repeat(32)), false);
  assert.equal(isLocallyAuthenticated(request('b'.repeat(32)), 'a'.repeat(32)), false);
  assert.equal(isLocallyAuthenticated(request('a'.repeat(32)), 'a'.repeat(32)), true);
});

test('readiness aggregates every required component and startup fails closed', async () => {
  const seen: string[] = [];
  const probe = (name: string, ok = true): ReadinessProbe => ({ name, async run() { seen.push(name); if (!ok) throw new Error('down'); return 'ok'; } });
  const service = new ReadinessService([
    probe('atp-parser'), probe('snapshot-store'), probe('ledger'), probe('validator', false), probe('upstream'),
  ]);
  const report = await service.check();
  assert.equal(report.ready, false);
  assert.deepEqual(seen, ['atp-parser', 'snapshot-store', 'ledger', 'validator', 'upstream']);
  await assert.rejects(service.reconcileStartup(), /validator/);
});

test('readiness timeout applies even when a probe ignores abort', async () => {
  const never: ReadinessProbe = { name: 'wedged', run: async () => new Promise<string>(() => {}) };
  const report = await new ReadinessService([never], 20).check();
  assert.equal(report.ready, false);
  assert.match(report.probes[0]!.detail, /timed out/);
});

test('ATP, snapshot, ledger, and mock upstream probes are operational', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vectra-ops-'));
  await mkdir(join(root, 'protocols'));
  await mkdir(join(root, 'vars'));
  await writeFile(join(root, 'protocols', 'conversational.md'), '---\nid: conversational\nname: Conversational\nversion: 1.0.0\nstatus: active\nclassification: private\ntriggers: ["*"]\n---\nFallback');
  const requested: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requested.push(String(input), String(new Headers(init?.headers).get('authorization')));
    return new Response('{}', { status: 200 });
  };
  const service = new ReadinessService([
    atpParserProbe(root), durableStoreProbe('snapshot-store', join(root, 'snapshots')),
    durableStoreProbe('ledger', join(root, 'ledger')), upstreamProbe('https://mock.invalid/', 'secret', mockFetch),
  ]);
  assert.equal((await service.reconcileStartup()).ready, true);
  assert.deepEqual(requested, ['https://mock.invalid/v1/models', 'Bearer secret']);
});

test('deployment assets encode readiness, graceful shutdown, auth, and non-mutating rollback', async () => {
  const unit = await readFile(join(process.cwd(), 'deploy/systemd/vectra-proxy.service'), 'utf8');
  for (const value of ['Requires=vectra-validator.service', 'EnvironmentFile=/etc/vectra/proxy.env', 'KillSignal=SIGTERM', 'TimeoutStopSec=20s', 'NoNewPrivileges=yes', 'ProtectSystem=strict']) {
    assert.match(unit, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const drill = await readFile(join(process.cwd(), 'deploy/rollback-drill.mjs'), 'utf8');
  assert.match(drill, /not executed/);
  assert.doesNotMatch(drill, /execSync|spawn|systemctl|openclaw config/);
});
