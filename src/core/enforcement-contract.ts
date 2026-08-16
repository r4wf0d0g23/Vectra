/** Production ATP enforcement contract owned by Vectra, not the model. */

export const ENFORCEMENT_CONTRACT_VERSION = '1.0.0' as const;

export type EnforcementMode = 'off' | 'observe' | 'warn' | 'enforce';
export type OperationImpact = 'read-only' | 'state-changing';
export type AdmissionDisposition = 'admit' | 'degrade' | 'hold' | 'reject';
export type LedgerTerminalState = 'completed' | 'failed' | 'violated' | 'cancelled';
export type LedgerState = 'pending' | 'executing' | 'verifying' | LedgerTerminalState;

export interface DefinitionPin {
  id: string;
  version: string;
  schemaVersion: string;
  contentSha256: string;
  validatorSha256?: string;
  attestationId?: string;
}

export interface ImmutableExecutionPins {
  protocol: DefinitionPin;
  variables: DefinitionPin[];
  bundleSha256: string;
  pluginVersion: string;
  contractVersion: typeof ENFORCEMENT_CONTRACT_VERSION;
}

export interface AdmissionInput {
  mode: EnforcementMode;
  impact: OperationImpact;
  routeResolved: boolean;
  pinsValid: boolean;
  requiredVarsFresh: boolean;
  protocolAllowsReadOnlyDegradation: boolean;
}

export interface AdmissionDecision {
  disposition: AdmissionDisposition;
  upstreamAllowed: boolean;
  reason: string;
  degraded: boolean;
}

export function classifyOperation(impacts: Array<'read-only' | 'write-capable' | 'destructive' | 'privileged' | 'unknown'>): OperationImpact {
  return impacts.length > 0 && impacts.every((impact) => impact === 'read-only') ? 'read-only' : 'state-changing';
}

/**
 * Only explicitly classified read-only work may degrade. Unknown operations
 * must be classified state-changing by the caller before this function runs.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const valid = input.routeResolved && input.pinsValid && input.requiredVarsFresh;
  if (valid) return { disposition: 'admit', upstreamAllowed: true, reason: 'all-gates-passed', degraded: false };

  if (input.mode !== 'enforce') {
    return { disposition: 'admit', upstreamAllowed: true, reason: `non-enforcing-${input.mode}`, degraded: false };
  }

  if (input.impact === 'read-only' && input.protocolAllowsReadOnlyDegradation) {
    return { disposition: 'degrade', upstreamAllowed: true, reason: failedGate(input), degraded: true };
  }

  return { disposition: 'hold', upstreamAllowed: false, reason: failedGate(input), degraded: false };
}

function failedGate(input: AdmissionInput): string {
  if (!input.routeResolved) return 'route-unresolved';
  if (!input.pinsValid) return 'immutable-pins-invalid';
  return 'required-variable-unverified';
}

export interface BypassGrant {
  bypassId: string;
  operatorId: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  scope: { protocolId: string; runId?: string };
  signature: string;
}

export function validateBypass(grant: BypassGrant, now: string): string[] {
  const errors: string[] = [];
  if (!grant.bypassId || !grant.operatorId || !grant.reason.trim()) errors.push('identity-and-reason-required');
  if (!grant.signature) errors.push('signature-required');
  if (!grant.scope.protocolId) errors.push('protocol-scope-required');
  const issued = Date.parse(grant.issuedAt);
  const expires = Date.parse(grant.expiresAt);
  const current = Date.parse(now);
  if (![issued, expires, current].every(Number.isFinite)) errors.push('timestamps-invalid');
  else {
    if (expires <= issued) errors.push('expiry-must-follow-issuance');
    if (current < issued || current >= expires) errors.push('bypass-not-active');
  }
  return errors;
}

export interface LedgerEvent {
  sequence: number;
  runId: string;
  bundleId: string;
  protocolId: string;
  from: LedgerState | null;
  to: LedgerState;
  occurredAt: string;
  pinsSha256: string;
  receiptSha256?: string;
  bypassId?: string;
  previousEventSha256: string | null;
}

const LEDGER_TRANSITIONS: Record<LedgerState, ReadonlySet<LedgerState>> = {
  pending: new Set(['executing', 'failed', 'cancelled', 'violated']),
  executing: new Set(['verifying', 'failed', 'cancelled', 'violated']),
  verifying: new Set(['completed', 'failed', 'violated']),
  completed: new Set(), failed: new Set(), violated: new Set(), cancelled: new Set(),
};

export function validateLedgerAppend(previous: LedgerEvent | null, next: LedgerEvent): string[] {
  const errors: string[] = [];
  if (previous === null) {
    if (next.sequence !== 0 || next.from !== null || next.to !== 'pending' || next.previousEventSha256 !== null) {
      errors.push('first-event-must-create-pending-run');
    }
  } else {
    if (next.runId !== previous.runId || next.bundleId !== previous.bundleId || next.protocolId !== previous.protocolId) errors.push('correlation-immutable');
    if (next.pinsSha256 !== previous.pinsSha256) errors.push('pins-immutable');
    if (next.sequence !== previous.sequence + 1) errors.push('sequence-not-contiguous');
    if (next.from !== previous.to) errors.push('from-state-mismatch');
    if (!LEDGER_TRANSITIONS[previous.to].has(next.to)) errors.push('illegal-or-terminal-transition');
    if (!next.previousEventSha256) errors.push('hash-chain-required');
  }
  if (next.to === 'completed' && !next.receiptSha256) errors.push('completion-requires-receipt');
  return errors;
}

export function reconcileInterruptedRun(last: LedgerEvent): LedgerState {
  return last.to === 'completed' || last.to === 'failed' || last.to === 'violated' || last.to === 'cancelled'
    ? last.to
    : 'violated';
}
