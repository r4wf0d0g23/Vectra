/**
 * Vectra Session Counters — aggregate metrics for the current session.
 */

export interface SessionCounters {
  jobsCreated: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsHalted: number;
  gateIntakePassed: number;
  gateIntakeHeld: number;
  gateBundlePassed: number;
  gateBundleFailed: number;
  gateApprovalAuto: number;
  gateApprovalBlocked: number;
  gateReceiptPassed: number;
  gateReceiptFailed: number;
  toolCallsTotal: number;
  checkpointsSaved: number;
  escalationsTriggered: number;
  estimatedCostUsd: number;
}

export function createCounters(): SessionCounters {
  return {
    jobsCreated: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    jobsHalted: 0,
    gateIntakePassed: 0,
    gateIntakeHeld: 0,
    gateBundlePassed: 0,
    gateBundleFailed: 0,
    gateApprovalAuto: 0,
    gateApprovalBlocked: 0,
    gateReceiptPassed: 0,
    gateReceiptFailed: 0,
    toolCallsTotal: 0,
    checkpointsSaved: 0,
    escalationsTriggered: 0,
    estimatedCostUsd: 0,
  };
}

export function incrementCounter(
  counters: SessionCounters,
  key: keyof SessionCounters,
  amount: number = 1
): void {
  (counters[key] as number) += amount;
}
