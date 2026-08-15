import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOperation, decideAdmission, reconcileInterruptedRun, validateBypass, validateLedgerAppend, type LedgerEvent } from '../src/core/enforcement-contract.js';

test('operation classification defaults unknown and empty plans to state-changing', () => {
  assert.equal(classifyOperation(['read-only']), 'read-only');
  assert.equal(classifyOperation(['read-only', 'unknown']), 'state-changing');
  assert.equal(classifyOperation([]), 'state-changing');
});

test('state-changing work fails closed when any gate fails', () => {
  const result = decideAdmission({ mode: 'enforce', impact: 'state-changing', routeResolved: true, pinsValid: true, requiredVarsFresh: false, protocolAllowsReadOnlyDegradation: false });
  assert.deepEqual(result, { disposition: 'hold', upstreamAllowed: false, reason: 'required-variable-unverified', degraded: false });
});

test('read-only work degrades only by explicit protocol opt-in', () => {
  const base = { mode: 'enforce' as const, impact: 'read-only' as const, routeResolved: false, pinsValid: false, requiredVarsFresh: false };
  assert.equal(decideAdmission({ ...base, protocolAllowsReadOnlyDegradation: true }).disposition, 'degrade');
  assert.equal(decideAdmission({ ...base, protocolAllowsReadOnlyDegradation: false }).disposition, 'hold');
});

test('non-enforcing modes observe without claiming degradation', () => {
  const result = decideAdmission({ mode: 'warn', impact: 'state-changing', routeResolved: false, pinsValid: false, requiredVarsFresh: false, protocolAllowsReadOnlyDegradation: false });
  assert.equal(result.upstreamAllowed, true);
  assert.equal(result.degraded, false);
});

const first: LedgerEvent = { sequence: 0, runId: 'r', bundleId: 'b', protocolId: 'p', from: null, to: 'pending', occurredAt: '2026-08-15T00:00:00Z', pinsSha256: 'a'.repeat(64), previousEventSha256: null };

test('ledger begins pending and completion requires receipt', () => {
  assert.deepEqual(validateLedgerAppend(null, first), []);
  const executing: LedgerEvent = { ...first, sequence: 1, from: 'pending', to: 'executing', previousEventSha256: 'b'.repeat(64) };
  assert.deepEqual(validateLedgerAppend(first, executing), []);
  const verifying: LedgerEvent = { ...executing, sequence: 2, from: 'executing', to: 'verifying' };
  const complete: LedgerEvent = { ...verifying, sequence: 3, from: 'verifying', to: 'completed' };
  assert.ok(validateLedgerAppend(verifying, complete).includes('completion-requires-receipt'));
  assert.deepEqual(validateLedgerAppend(verifying, { ...complete, receiptSha256: 'c'.repeat(64) }), []);
});

test('correlation, pins, sequence and terminal states are immutable', () => {
  const terminal: LedgerEvent = { ...first, sequence: 1, from: 'pending', to: 'failed', previousEventSha256: 'b'.repeat(64) };
  const illegal: LedgerEvent = { ...terminal, sequence: 2, from: 'failed', to: 'completed', previousEventSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), pinsSha256: 'e'.repeat(64) };
  const errors = validateLedgerAppend(terminal, illegal);
  assert.ok(errors.includes('pins-immutable'));
  assert.ok(errors.includes('illegal-or-terminal-transition'));
});

test('interrupted runs reconcile violated, never complete', () => {
  assert.equal(reconcileInterruptedRun(first), 'violated');
});

test('emergency bypass is signed, scoped, reasoned and active', () => {
  const valid = { bypassId: 'x', operatorId: 'op', reason: 'incident', issuedAt: '2026-08-15T00:00:00Z', expiresAt: '2026-08-15T01:00:00Z', scope: { protocolId: 'p' }, signature: 'sig' };
  assert.deepEqual(validateBypass(valid, '2026-08-15T00:30:00Z'), []);
  assert.ok(validateBypass({ ...valid, signature: '' }, '2026-08-15T02:00:00Z').includes('signature-required'));
});
