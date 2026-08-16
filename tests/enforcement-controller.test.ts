import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtpEnforcementController, DurableRunLedger, type RouteBinding } from '../src/atp/enforcement-controller.js';
import type { OpenAiRequest } from '../src/model/openai-api.js';

const bytes = (value: string): Uint8Array => Buffer.from(value);
const route = (overrides: Partial<RouteBinding> = {}): RouteBinding => ({
  kind: 'single', protocolId: 'deploy', protocolVersion: '1.0.0', protocolSchemaVersion: '1.0.0', protocolBytes: bytes('protocol'),
  requiredVariables: [{ id: 'state', version: '1.0.0', schemaVersion: '1.0.0', bytes: bytes('variable'), adapterId: 'state' }],
  toolImpacts: ['write-capable'], allowReadOnlyDegradation: false, ...overrides,
});

async function fixture(binding: RouteBinding = route(), receiptValid = true) {
  const root = await mkdtemp(join(tmpdir(), 'vectra-enforce-'));
  const request: OpenAiRequest = { messages: [{ role: 'user', content: 'deploy it' }] };
  const controller = new AtpEnforcementController({
    mode: 'enforce', instancePath: root, snapshotPath: join(root, 'snapshots'), ledgerPath: join(root, 'ledger'),
    validatorSocketPath: join(root, 'validator.sock'), pluginVersion: '1.0.0', routes: { resolve: async () => binding },
    validator: { health: async () => ({ status: 'ok', configHash: 'a'.repeat(64) }), validate: async () => ({ ok: true }) },
    receipts: { verify: async () => receiptValid ? { valid: true, receiptSha256: 'b'.repeat(64) } : { valid: false, reason: 'forged' } },
    now: () => new Date('2026-08-15T12:00:00Z'),
  });
  return { root, request, controller };
}

test('creates durable pending and immutable snapshot before upstream forwarding', async () => {
  const { root, request, controller } = await fixture();
  assert.equal(await controller.requiresHold('chat-completions', request), true);
  const ledgerNames = await import('node:fs/promises').then((fs) => fs.readdir(join(root, 'ledger')));
  assert.equal(ledgerNames.length, 1);
  const events = JSON.parse(await readFile(join(root, 'ledger', ledgerNames[0]), 'utf8'));
  assert.equal(events[0].type, 'pending');
  assert.match(events[0].pinsSha256, /^[a-f0-9]{64}$/);
});

test('identical governing definitions reuse the byte-identical immutable snapshot', async () => {
  const { root, controller } = await fixture();
  const one: OpenAiRequest = { messages: [{ role: 'user', content: 'deploy one' }] };
  const two: OpenAiRequest = { messages: [{ role: 'user', content: 'deploy two' }] };
  await controller.requiresHold('chat-completions', one);
  await controller.requiresHold('chat-completions', two);
  const snapshots = await import('node:fs/promises').then((fs) => fs.readdir(join(root, 'snapshots')));
  assert.equal(snapshots.length, 1);
});

test('receipt gates release and records one immutable terminal completion', async () => {
  const { root, request, controller } = await fixture();
  await controller.requiresHold('chat-completions', request);
  const decision = await controller.evaluate({ api: 'chat-completions', request, taskDescription: 'deploy it', upstreamStatus: 200, upstreamHeaders: new Headers(), responseBody: bytes('{}') });
  assert.deepEqual(decision, { release: true });
  const name = (await import('node:fs/promises').then((fs) => fs.readdir(join(root, 'ledger'))))[0];
  const events = JSON.parse(await readFile(join(root, 'ledger', name), 'utf8'));
  assert.deepEqual(events.map((event: any) => event.type), ['pending', 'executing', 'verifying', 'completed']);
  assert.equal(events.at(-1).receiptSha256, 'b'.repeat(64));
});

test('invalid receipt is never released and becomes violated', async () => {
  const { root, request, controller } = await fixture(route(), false);
  await controller.requiresHold('chat-completions', request);
  const decision = await controller.evaluate({ api: 'chat-completions', request, taskDescription: '', upstreamStatus: 200, upstreamHeaders: new Headers(), responseBody: bytes('{}') });
  assert.equal(decision.release, false);
  const name = (await import('node:fs/promises').then((fs) => fs.readdir(join(root, 'ledger'))))[0];
  const events = JSON.parse(await readFile(join(root, 'ledger', name), 'utf8'));
  assert.equal(events.at(-1).type, 'violated');
});

test('ambiguous state-changing route fails closed before upstream', async () => {
  const { request, controller } = await fixture(route({ kind: 'ambiguous', protocolId: undefined, protocolBytes: undefined }));
  await assert.rejects(controller.requiresHold('chat-completions', request), /route-unresolved/);
});

test('read-only degradation requires explicit protocol permission', async () => {
  const permitted = await fixture(route({ kind: 'none', protocolId: undefined, protocolBytes: undefined, requiredVariables: [], toolImpacts: ['read-only'], allowReadOnlyDegradation: true }));
  assert.equal(await permitted.controller.requiresHold('chat-completions', permitted.request), true);
  const denied = await fixture(route({ kind: 'none', protocolId: undefined, protocolBytes: undefined, requiredVariables: [], toolImpacts: ['read-only'], allowReadOnlyDegradation: false }));
  await assert.rejects(denied.controller.requiresHold('chat-completions', denied.request));
});

test('startup reconciliation marks interrupted runs violated, never successful', async () => {
  const { root, request, controller } = await fixture();
  await controller.requiresHold('chat-completions', request);
  const reconciled = await controller.reconcile();
  assert.equal(reconciled.length, 1);
  const ledger = new DurableRunLedger(join(root, 'ledger'));
  const events = await ledger.read(reconciled[0]);
  assert.equal(events.at(-1)?.type, 'violated');
});
