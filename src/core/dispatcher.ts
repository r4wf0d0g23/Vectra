/**
 * Vectra Dispatcher — routes jobs to the correct execution path.
 *
 * Dispatch flow:
 * 1. Policy filter — reject jobs that violate trust/capability boundaries
 * 2. Hard fit — match task against protocol patterns (from ATP matcher)
 * 3. Score — rank matches by priority and specificity
 * 4. Tie-break — if multiple protocols match equally, prefer higher priority
 * 5. Bind — attach protocol metadata to the job envelope
 */

import type { JobEnvelope, ModelClass, ProtocolId, TaskClass, ToolName } from './job.js';
import { MODEL_CLASS_ORDER } from './job.js';
import type { RoutingMatch } from '../atp/matcher.js';

// ─── Dispatch Result ────────────────────────────────────────────────

export interface DispatchResult {
  matched: boolean;
  protocolId: ProtocolId | null;
  taskClass: TaskClass | null;
  varIds: string[];
  modelClass: ModelClass;
  toolAllowlist: ToolName[];
  guardrails: string[];
  priority: number;
  /** Reason for rejection if not matched. */
  rejectionReason: string | null;
}

// ─── Protocol-to-TaskClass Mapping ──────────────────────────────────

const PROTOCOL_TASK_CLASS: Record<string, TaskClass> = {
  'orchestration-main': 'orchestration',
  'openclaw-config-change': 'config-ops',
  'dgx-inference-ops': 'inference-ops',
  'crew-ops': 'crew-comms',
  'crew-peering': 'crew-comms',
  'cradleos-deploy': 'deploy-ops',
  'memory-maintenance': 'memory-ops',
  'atp-protocol-review': 'orchestration',
  'conversational': 'conversational',
};

// ─── Dispatcher ─────────────────────────────────────────────────────

export class Dispatcher {
  /**
   * Select the best protocol match for a job.
   *
   * @param job - The job envelope (state must be 'queued' or 'admitted')
   * @param matches - Candidate matches from the ATP pattern matcher
   * @returns DispatchResult with the winning protocol or rejection reason
   */
  dispatch(job: JobEnvelope, matches: RoutingMatch[]): DispatchResult {
    // Step 1: Policy filter — reject if trust level insufficient for any match
    if (matches.length === 0) {
      return {
        matched: false,
        protocolId: null,
        taskClass: null,
        varIds: [],
        modelClass: 'fast',
        toolAllowlist: [],
        guardrails: [],
        priority: 0,
        rejectionReason: 'No protocol pattern matched the task description.',
      };
    }

    // Step 2: Filter by trust level
    const trustFiltered = matches.filter((m) => {
      // Webhook sources can only route to conversational (lowest risk)
      if (job.source === 'webhook' && m.protocolId !== 'conversational') {
        return false;
      }
      return true;
    });

    if (trustFiltered.length === 0) {
      return {
        matched: false,
        protocolId: null,
        taskClass: null,
        varIds: [],
        modelClass: 'fast',
        toolAllowlist: [],
        guardrails: [],
        priority: 0,
        rejectionReason: `Source '${job.source}' has insufficient trust for matched protocols.`,
      };
    }

    // Step 3: Score by priority (higher = better), then specificity
    const scored = trustFiltered
      .map((m) => ({
        match: m,
        score: (m.priority ?? 0) * 1000 + (m.patternSpecificity ?? 0),
      }))
      .sort((a, b) => b.score - a.score);

    // Step 4: Take the winner
    const winner = scored[0].match;

    const taskClass = PROTOCOL_TASK_CLASS[winner.protocolId] ?? 'conversational';

    return {
      matched: true,
      protocolId: winner.protocolId as ProtocolId,
      taskClass,
      varIds: winner.varIds,
      modelClass: winner.modelClass as ModelClass,
      toolAllowlist: (winner.toolAllowlist ?? []) as ToolName[],
      guardrails: winner.guardrails ?? [],
      priority: winner.priority ?? 0,
      rejectionReason: null,
    };
  }

  /**
   * Bind dispatch result to a job envelope, updating protocol metadata.
   */
  bind(job: JobEnvelope, result: DispatchResult): void {
    if (!result.matched || !result.protocolId || !result.taskClass) {
      throw new Error(`Cannot bind unmatched dispatch result to job ${job.id}`);
    }

    job.protocolId = result.protocolId;
    job.taskClass = result.taskClass;
    job.varIds = result.varIds;
    job.modelClass = result.modelClass;
    job.toolAllowlist = result.toolAllowlist;
    job.guardrails = result.guardrails;
  }

  /**
   * Validate that a model class meets or exceeds the protocol requirement.
   */
  validateModelClass(assigned: ModelClass, required: ModelClass): boolean {
    return MODEL_CLASS_ORDER[assigned] >= MODEL_CLASS_ORDER[required];
  }
}
