/**
 * Vectra Job State Machine
 *
 * Every job has explicit states with legal transitions. The state machine
 * is the single source of truth for job lifecycle. Illegal transitions
 * trigger a halt condition — they indicate harness corruption.
 *
 * States:
 *   queued → admitted → prepared → planning → executing → verifying → completed → archived
 *                                      ↕          ↕
 *                                   blocked    blocked
 *                                      ↓          ↓
 *                              (back to planning/executing on unblock)
 *
 * Terminal states: completed, failed, halted (all can transition to archived)
 */

import type { JobEnvelope, JobState } from './job.js';

// ─── Transition Table ───────────────────────────────────────────────

/**
 * Legal state transitions. Key = current state, value = set of allowed next states.
 * Any transition not in this table is illegal and triggers a halt.
 */
export const LEGAL_TRANSITIONS: Record<JobState, ReadonlySet<JobState>> = {
  queued:    new Set(['admitted', 'failed']),
  admitted:  new Set(['prepared', 'failed']),
  prepared:  new Set(['planning', 'failed']),
  planning:  new Set(['executing', 'blocked', 'failed', 'halted']),
  executing: new Set(['verifying', 'blocked', 'failed', 'halted']),
  blocked:   new Set(['planning', 'executing', 'failed', 'halted']),
  verifying: new Set(['completed', 'failed', 'halted']),
  completed: new Set(['archived']),
  failed:    new Set(['archived']),
  halted:    new Set(['archived']),
  archived:  new Set([]),
} as const;

// ─── Transition Reasons ─────────────────────────────────────────────

/** Standard reasons for transitions. Custom reasons are also allowed. */
export type TransitionReason =
  | 'intake-passed'          // queued → admitted
  | 'bundle-validated'       // admitted → prepared
  | 'plan-started'           // prepared → planning
  | 'execution-started'      // planning → executing
  | 'approval-required'      // planning/executing → blocked
  | 'external-wait'          // planning/executing → blocked
  | 'unblocked'              // blocked → planning/executing
  | 'verification-started'   // executing → verifying
  | 'verification-passed'    // verifying → completed
  | 'verification-failed'    // verifying → failed
  | 'intake-rejected'        // queued → failed
  | 'bundle-invalid'         // admitted → failed
  | 'execution-error'        // executing → failed
  | 'timeout'                // any → failed/halted
  | 'stop-condition'         // any → halted
  | 'cost-exceeded'          // any → halted
  | 'recursion-exceeded'     // any → halted
  | 'credential-exposure'    // any → halted
  | 'lifecycle-complete'     // completed/failed/halted → archived
  | string;                  // custom reasons

// ─── Transition Result ──────────────────────────────────────────────

export interface TransitionResult {
  success: boolean;
  previousState: JobState;
  newState: JobState;
  timestamp: string;
  reason: TransitionReason;
  error?: string;
}

// ─── Transition Logger ──────────────────────────────────────────────

export interface TransitionLogger {
  log(event: TransitionResult & { jobId: string }): void;
}

/** Default logger: writes structured JSON to stderr. */
export const consoleTransitionLogger: TransitionLogger = {
  log(event) {
    const entry = {
      type: 'vectra.state_transition',
      jobId: event.jobId,
      from: event.previousState,
      to: event.newState,
      reason: event.reason,
      success: event.success,
      timestamp: event.timestamp,
      ...(event.error ? { error: event.error } : {}),
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  },
};

// ─── State Machine ──────────────────────────────────────────────────

export class JobStateMachine {
  private logger: TransitionLogger;

  constructor(logger: TransitionLogger = consoleTransitionLogger) {
    this.logger = logger;
  }

  /**
   * Check if a transition is legal without performing it.
   */
  canTransition(from: JobState, to: JobState): boolean {
    return LEGAL_TRANSITIONS[from].has(to);
  }

  /**
   * Attempt a state transition on a job envelope.
   *
   * If the transition is illegal, the job is halted (if not already terminal)
   * and the result indicates failure. Every transition — legal or not — is logged.
   *
   * @returns TransitionResult indicating success/failure.
   * @mutates job.state, job.updatedAt, job.stateHistory, and potentially job.haltCondition
   */
  transition(
    job: JobEnvelope,
    to: JobState,
    reason: TransitionReason
  ): TransitionResult {
    const now = new Date().toISOString();
    const from = job.state;

    // Check legality
    if (!this.canTransition(from, to)) {
      const error = `Illegal transition: ${from} → ${to}`;

      // If not already terminal, halt the job
      const isTerminal = from === 'completed' || from === 'failed' || from === 'halted' || from === 'archived';
      if (!isTerminal && this.canTransition(from, 'halted')) {
        job.state = 'halted';
        job.updatedAt = now;
        job.haltCondition = `Illegal state transition attempted: ${from} → ${to} (reason: ${reason})`;
        job.stateHistory.push({
          from,
          to: 'halted',
          timestamp: now,
          reason: `illegal-transition-halt: ${error}`,
        });
      }

      const result: TransitionResult = {
        success: false,
        previousState: from,
        newState: job.state,
        timestamp: now,
        reason,
        error,
      };

      this.logger.log({ ...result, jobId: job.id });
      return result;
    }

    // Execute transition
    job.state = to;
    job.updatedAt = now;
    job.stateHistory.push({ from, to, timestamp: now, reason });

    const result: TransitionResult = {
      success: true,
      previousState: from,
      newState: to,
      timestamp: now,
      reason,
    };

    this.logger.log({ ...result, jobId: job.id });
    return result;
  }

  /**
   * Check if a job is in a terminal state.
   */
  isTerminal(state: JobState): boolean {
    return state === 'completed' || state === 'failed' || state === 'halted' || state === 'archived';
  }

  /**
   * Check if a job is in an active (non-terminal) state.
   */
  isActive(state: JobState): boolean {
    return !this.isTerminal(state);
  }

  /**
   * Get all legal next states from the current state.
   */
  legalNextStates(state: JobState): JobState[] {
    return [...LEGAL_TRANSITIONS[state]];
  }
}
