/**
 * Vectra T1 Scanner — periodic drift detection.
 *
 * Runs on cron (daily 3am CT). Scans:
 * - Protocol files for schema violations
 * - Var files for staleness beyond policy thresholds
 * - Dispatch table for missing/orphaned patterns
 * - Open PRs to avoid duplicate findings
 *
 * Output: PRs to ATP repo + reports to atp-instance/reports/
 */

export interface T1ScanResult {
  timestamp: string;
  protocolsScanned: number;
  varsScanned: number;
  findings: T1Finding[];
  prsOpened: string[];
}

export interface T1Finding {
  type: 'schema-violation' | 'staleness' | 'orphaned-pattern' | 'missing-field';
  target: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

/**
 * T1 Scanner worker — implementation deferred to harness wiring phase.
 * See atp/lib/workers/tiers/t1.md for full specification.
 */
export class T1Scanner {
  async scan(): Promise<T1ScanResult> {
    // Implementation will load ATP instance, iterate protocols + vars,
    // check schemas, compare staleness policies, and emit findings.
    throw new Error('T1Scanner.scan() not yet implemented — pending harness wiring');
  }
}
