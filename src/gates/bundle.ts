/**
 * Vectra Bundle Validator — validates context bundles before spawn.
 *
 * Implements the 6 validation rules from ATP bundle-schema spec:
 * 1. Single protocol — bundle references exactly one protocol
 * 2. Var scope — only vars listed in the protocol's requires.vars
 * 3. Model class compliance — assigned class meets or exceeds protocol requirement
 * 4. Guardrail inheritance — protocol guardrails are present in the bundle
 * 5. Task description — bundle contains a non-empty task description
 * 6. Credential detection — no raw credentials in bundle content
 */

import type { JobEnvelope, ModelClass } from '../core/job.js';
import { MODEL_CLASS_ORDER } from '../core/job.js';

// ─── Validation Result ──────────────────────────────────────────────

export interface BundleValidationResult {
  valid: boolean;
  rules: Array<{
    rule: string;
    passed: boolean;
    detail: string;
  }>;
}

// ─── Credential Patterns ────────────────────────────────────────────

const CREDENTIAL_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /(?:password|secret|token|key)\s*[:=]\s*\S+/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /shpat_[a-f0-9]{32}/,   // Shopify access token
  /ghp_[A-Za-z0-9]{36}/,  // GitHub personal access token
  /sk-[A-Za-z0-9]{48}/,   // OpenAI API key
];

// ─── Bundle Validator ───────────────────────────────────────────────

export class BundleValidator {
  /**
   * Validate a job's context bundle against the 6 rules.
   */
  validate(
    job: JobEnvelope,
    protocolVarIds: string[],
    protocolModelClass: ModelClass,
    protocolGuardrails: string[]
  ): BundleValidationResult {
    const rules: BundleValidationResult['rules'] = [];

    // Rule 1: Single protocol
    rules.push({
      rule: 'single-protocol',
      passed: !!job.protocolId,
      detail: job.protocolId
        ? `Protocol: ${job.protocolId}`
        : 'No protocol bound to job',
    });

    // Rule 2: Var scope — job's varIds must be subset of protocol's
    const extraVars = job.varIds.filter((v) => !protocolVarIds.includes(v));
    rules.push({
      rule: 'var-scope',
      passed: extraVars.length === 0,
      detail:
        extraVars.length === 0
          ? `All ${job.varIds.length} vars within protocol scope`
          : `Extra vars not in protocol scope: ${extraVars.join(', ')}`,
    });

    // Rule 3: Model class compliance
    const classOk =
      MODEL_CLASS_ORDER[job.modelClass] >=
      MODEL_CLASS_ORDER[protocolModelClass];
    rules.push({
      rule: 'model-class',
      passed: classOk,
      detail: classOk
        ? `Model class ${job.modelClass} meets requirement ${protocolModelClass}`
        : `Model class ${job.modelClass} below requirement ${protocolModelClass}`,
    });

    // Rule 4: Guardrail inheritance
    const missingGuardrails = protocolGuardrails.filter(
      (g) => !job.guardrails.includes(g)
    );
    rules.push({
      rule: 'guardrail-inheritance',
      passed: missingGuardrails.length === 0,
      detail:
        missingGuardrails.length === 0
          ? `All ${protocolGuardrails.length} guardrails inherited`
          : `Missing guardrails: ${missingGuardrails.length}`,
    });

    // Rule 5: Task description
    rules.push({
      rule: 'task-description',
      passed: job.description.trim().length > 0,
      detail: job.description.trim().length > 0
        ? `Description present (${job.description.length} chars)`
        : 'Empty task description',
    });

    // Rule 6: Credential detection
    const allContent = [
      ...job.context.static,
      ...job.context.task,
      ...job.context.working,
      ...job.context.persistent,
      ...job.context.retrieval,
    ].join('\n');

    const credentialFound = CREDENTIAL_PATTERNS.some((p) => p.test(allContent));
    rules.push({
      rule: 'credential-detection',
      passed: !credentialFound,
      detail: credentialFound
        ? 'Credential pattern detected in bundle content'
        : 'No credential patterns detected',
    });

    return {
      valid: rules.every((r) => r.passed),
      rules,
    };
  }
}
