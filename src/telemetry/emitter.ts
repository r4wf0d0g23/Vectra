/**
 * Vectra Telemetry Emitter — structured JSONL event emission.
 *
 * Every state transition, gate evaluation, and job lifecycle event
 * is emitted as a structured telemetry record. Records are appended
 * to a JSONL file for audit and analysis.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ─── Telemetry Event Types ──────────────────────────────────────────

export type TelemetryEventType =
  | 'job.created'
  | 'job.admitted'
  | 'job.prepared'
  | 'job.planning'
  | 'job.executing'
  | 'job.blocked'
  | 'job.verifying'
  | 'job.completed'
  | 'job.failed'
  | 'job.halted'
  | 'job.archived'
  | 'gate.intake.pass'
  | 'gate.intake.hold'
  | 'gate.bundle.pass'
  | 'gate.bundle.fail'
  | 'gate.approval.auto'
  | 'gate.approval.blocked'
  | 'gate.receipt.pass'
  | 'gate.receipt.fail'
  | 'checkpoint.saved'
  | 'tool.called'
  | 'tool.completed'
  | 'escalation.triggered'
  | 'stop.condition';

// ─── Telemetry Record ───────────────────────────────────────────────

export interface TelemetryRecord {
  /** Event type. */
  type: TelemetryEventType;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Job ID this event belongs to. */
  jobId: string;
  /** Protocol ID (if bound). */
  protocolId: string | null;
  /** Structured payload — varies by event type. */
  payload: Record<string, unknown>;
}

// ─── Emitter ────────────────────────────────────────────────────────

export class TelemetryEmitter {
  private outputPath: string;
  private buffer: TelemetryRecord[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  /**
   * Emit a telemetry event. Buffered and flushed periodically.
   */
  emit(
    type: TelemetryEventType,
    jobId: string,
    protocolId: string | null,
    payload: Record<string, unknown> = {}
  ): void {
    this.buffer.push({
      type,
      timestamp: new Date().toISOString(),
      jobId,
      protocolId,
      payload,
    });

    // Auto-flush if buffer grows large
    if (this.buffer.length >= 50) {
      void this.flush();
    }
  }

  /**
   * Flush buffered events to the output file.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const records = this.buffer.splice(0);
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

    await mkdir(dirname(this.outputPath), { recursive: true });
    await appendFile(this.outputPath, lines, 'utf-8');
  }

  /**
   * Start periodic flushing.
   */
  startPeriodicFlush(intervalMs: number = 5000): void {
    this.flushInterval = setInterval(() => void this.flush(), intervalMs);
  }

  /**
   * Stop periodic flushing and flush remaining.
   */
  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }
}
