/**
 * Vectra Approval Gate — policy predicates, not model judgment.
 *
 * The approval gate evaluates whether a job's actions require
 * human approval, T3 analysis, or can auto-execute. Decisions
 * are based on machine-checkable rules, never model opinion.
 */

import type { ApprovalPolicy, JobEnvelope, ToolName } from '../core/job.js';

// ─── Approval Predicate ─────────────────────────────────────────────

export interface ApprovalPredicate {
  /** Human-readable name for this predicate. */
  name: string;
  /** Evaluate the predicate. Returns the required approval level. */
  evaluate(job: JobEnvelope): ApprovalPolicy;
}

// ─── Built-in Predicates ────────────────────────────────────────────

/** Jobs from webhook sources always require T3 analysis. */
const webhookSourcePredicate: ApprovalPredicate = {
  name: 'webhook-source',
  evaluate(job) {
    return job.source === 'webhook' ? 'require-t3' : 'auto';
  },
};

/** Credential-affecting tasks never auto-execute. */
const credentialPredicate: ApprovalPredicate = {
  name: 'credential-change',
  evaluate(job) {
    const credentialPatterns = /credential|token|key|password|secret/i;
    return credentialPatterns.test(job.description) ? 'require-human' : 'auto';
  },
};

/** Production deploy tasks require human approval. */
const productionDeployPredicate: ApprovalPredicate = {
  name: 'production-deploy',
  evaluate(job) {
    const deployPatterns = /deploy|publish|push to prod/i;
    if (deployPatterns.test(job.description) && job.taskClass === 'deploy-ops') {
      return 'require-human';
    }
    return 'auto';
  },
};

/** High recursion depth requires T3 analysis. */
const recursionDepthPredicate: ApprovalPredicate = {
  name: 'recursion-depth',
  evaluate(job) {
    return job.recursionDepth >= 2 ? 'require-t3' : 'auto';
  },
};

/** External messaging requires human approval. */
const externalMessagePredicate: ApprovalPredicate = {
  name: 'external-message',
  evaluate(job) {
    if (job.toolAllowlist.includes('message')) {
      return 'require-human';
    }
    return 'auto';
  },
};

// ─── Default Predicates ─────────────────────────────────────────────

export const DEFAULT_PREDICATES: ApprovalPredicate[] = [
  webhookSourcePredicate,
  credentialPredicate,
  productionDeployPredicate,
  recursionDepthPredicate,
  externalMessagePredicate,
];

// ─── Approval Gate ──────────────────────────────────────────────────

/** Approval level priority: higher = more restrictive. */
const APPROVAL_PRIORITY: Record<ApprovalPolicy, number> = {
  auto: 0,
  'require-t3': 1,
  'require-human': 2,
  never: 3,
};

export class ApprovalGate {
  private predicates: ApprovalPredicate[];

  constructor(predicates: ApprovalPredicate[] = DEFAULT_PREDICATES) {
    this.predicates = predicates;
  }

  /**
   * Evaluate all predicates and return the most restrictive result.
   */
  evaluate(job: JobEnvelope): {
    policy: ApprovalPolicy;
    triggeredBy: string[];
  } {
    let maxPolicy: ApprovalPolicy = 'auto';
    const triggeredBy: string[] = [];

    for (const pred of this.predicates) {
      const result = pred.evaluate(job);
      if (APPROVAL_PRIORITY[result] > APPROVAL_PRIORITY[maxPolicy]) {
        maxPolicy = result;
        triggeredBy.push(pred.name);
      } else if (
        result !== 'auto' &&
        APPROVAL_PRIORITY[result] === APPROVAL_PRIORITY[maxPolicy]
      ) {
        triggeredBy.push(pred.name);
      }
    }

    return { policy: maxPolicy, triggeredBy };
  }
}
