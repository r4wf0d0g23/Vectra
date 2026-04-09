/**
 * Vectra Scheduler — cron jobs and heartbeat runner.
 *
 * Replaces OpenClaw's built-in task scheduler with Vectra-native scheduling.
 * Cron jobs and heartbeats inject messages into the transport pipeline with
 * senderTrust: 'cron' — never 'human'. Quiet hours are enforced for heartbeats.
 *
 * Lifecycle:
 *   1. Construct with specs from instance config
 *   2. Register message handler via onCronMessage()
 *   3. Call start() — cron tasks and heartbeat timer begin
 *   4. Call stop() on shutdown — all timers/tasks cleaned up
 */

import cron from 'node-cron';

// ─── Types ──────────────────────────────────────────────────────────

export interface CronJobSpec {
  id: string;
  schedule: string;        // cron expression e.g. "*/30 * * * *"
  task: string;            // task description to inject as message
  channelId: string;       // which channel to inject into
  model?: string;          // model override for this job
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
}

export interface HeartbeatSpec {
  intervalMs: number;      // how often to check
  prompt: string;          // heartbeat prompt to inject
  channelId: string;
  model: string;           // should be fast/cheap model
  quietHoursStart?: number; // 0-23, hour to stop heartbeats
  quietHoursEnd?: number;
}

export type CronMessageHandler = (
  channelId: string,
  text: string,
  role: 'cron',
) => Promise<void>;

// ─── Scheduler ──────────────────────────────────────────────────────

export class Scheduler {
  private cronTasks = new Map<string, cron.ScheduledTask>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler: CronMessageHandler | null = null;
  private jobSpecs: Map<string, CronJobSpec>;
  private running = false;

  constructor(
    cronJobs: CronJobSpec[],
    private heartbeat?: HeartbeatSpec,
  ) {
    this.jobSpecs = new Map(cronJobs.map((j) => [j.id, { ...j }]));
  }

  // ── Handler Registration ────────────────────────────────────────

  /**
   * Register the message injection handler. Set by the main runtime
   * before calling start(). Messages are always injected with role 'cron'.
   */
  onCronMessage(handler: CronMessageHandler): void {
    this.messageHandler = handler;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Start all enabled cron jobs and the heartbeat timer.
   * Throws if no message handler is registered.
   */
  start(): void {
    if (!this.messageHandler) {
      throw new Error('[scheduler] Cannot start: no message handler registered. Call onCronMessage() first.');
    }
    if (this.running) {
      console.warn('[scheduler] Already running — ignoring duplicate start()');
      return;
    }

    this.running = true;
    console.log('[scheduler] Starting...');

    // Start all enabled cron jobs
    for (const [id, spec] of this.jobSpecs) {
      if (spec.enabled) {
        this.startCronJob(id, spec);
      }
    }

    // Start heartbeat timer
    if (this.heartbeat) {
      this.startHeartbeat(this.heartbeat);
    }

    const enabledCount = [...this.jobSpecs.values()].filter((s) => s.enabled).length;
    console.log(
      `[scheduler] Started: ${enabledCount} cron job(s), heartbeat: ${this.heartbeat ? 'enabled' : 'disabled'}`,
    );
  }

  /**
   * Stop all cron jobs and the heartbeat timer. Clean shutdown — no hanging intervals.
   */
  stop(): void {
    if (!this.running) return;

    console.log('[scheduler] Stopping...');

    // Stop all cron tasks
    for (const [id, task] of this.cronTasks) {
      task.stop();
      console.log(`[scheduler] Stopped cron job: ${id}`);
    }
    this.cronTasks.clear();

    // Stop heartbeat timer
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('[scheduler] Stopped heartbeat timer');
    }

    this.running = false;
    console.log('[scheduler] Stopped.');
  }

  // ── Status ──────────────────────────────────────────────────────

  /**
   * Get status of all registered jobs.
   */
  status(): Array<{ id: string; enabled: boolean; lastRun?: Date; nextRun?: Date }> {
    return [...this.jobSpecs.values()].map((spec) => ({
      id: spec.id,
      enabled: spec.enabled,
      lastRun: spec.lastRun,
      nextRun: spec.nextRun,
    }));
  }

  // ── Runtime Job Management ──────────────────────────────────────

  /**
   * Add a new cron job at runtime. If a job with the same ID exists, it is replaced.
   */
  addJob(spec: CronJobSpec): void {
    // Stop existing job if running
    if (this.cronTasks.has(spec.id)) {
      this.cronTasks.get(spec.id)!.stop();
      this.cronTasks.delete(spec.id);
    }

    this.jobSpecs.set(spec.id, { ...spec });

    if (this.running && spec.enabled) {
      this.startCronJob(spec.id, spec);
    }

    console.log(`[scheduler] Added job: ${spec.id} (${spec.enabled ? 'enabled' : 'disabled'})`);
  }

  /**
   * Remove a cron job by ID.
   */
  removeJob(id: string): void {
    const task = this.cronTasks.get(id);
    if (task) {
      task.stop();
      this.cronTasks.delete(id);
    }
    this.jobSpecs.delete(id);
    console.log(`[scheduler] Removed job: ${id}`);
  }

  /**
   * Enable a job. Starts it immediately if the scheduler is running.
   */
  enableJob(id: string): void {
    const spec = this.jobSpecs.get(id);
    if (!spec) {
      console.warn(`[scheduler] Cannot enable unknown job: ${id}`);
      return;
    }

    spec.enabled = true;

    if (this.running && !this.cronTasks.has(id)) {
      this.startCronJob(id, spec);
    }

    console.log(`[scheduler] Enabled job: ${id}`);
  }

  /**
   * Disable a job. Stops it immediately if running.
   */
  disableJob(id: string): void {
    const spec = this.jobSpecs.get(id);
    if (!spec) {
      console.warn(`[scheduler] Cannot disable unknown job: ${id}`);
      return;
    }

    spec.enabled = false;

    const task = this.cronTasks.get(id);
    if (task) {
      task.stop();
      this.cronTasks.delete(id);
    }

    console.log(`[scheduler] Disabled job: ${id}`);
  }

  // ── Internal ────────────────────────────────────────────────────

  /**
   * Start a single cron job. Validates the cron expression before scheduling.
   */
  private startCronJob(id: string, spec: CronJobSpec): void {
    if (!cron.validate(spec.schedule)) {
      console.error(`[scheduler] Invalid cron expression for job '${id}': ${spec.schedule}`);
      return;
    }

    const task = cron.schedule(spec.schedule, async () => {
      spec.lastRun = new Date();
      console.log(`[scheduler] Firing cron job: ${id}`);

      try {
        await this.messageHandler!(spec.channelId, spec.task, 'cron');
      } catch (err) {
        console.error(`[scheduler] Cron job '${id}' handler error:`, err);
      }
    });

    this.cronTasks.set(id, task);
    console.log(`[scheduler] Scheduled cron job: ${id} [${spec.schedule}]`);
  }

  /**
   * Start the heartbeat interval timer with quiet hours enforcement.
   */
  private startHeartbeat(hb: HeartbeatSpec): void {
    this.heartbeatTimer = setInterval(async () => {
      // Enforce quiet hours
      if (this.isQuietHours(hb.quietHoursStart, hb.quietHoursEnd)) {
        return; // Silent skip during quiet hours
      }

      console.log('[scheduler] Firing heartbeat');

      try {
        await this.messageHandler!(hb.channelId, hb.prompt, 'cron');
      } catch (err) {
        console.error('[scheduler] Heartbeat handler error:', err);
      }
    }, hb.intervalMs);

    // Prevent the heartbeat timer from keeping the process alive on shutdown
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }

    console.log(
      `[scheduler] Heartbeat started: every ${hb.intervalMs / 1000}s` +
      (hb.quietHoursStart != null ? ` (quiet ${hb.quietHoursStart}:00–${hb.quietHoursEnd}:00)` : ''),
    );
  }

  /**
   * Check if the current local time falls within quiet hours.
   * Handles overnight ranges (e.g. 23:00–06:00).
   */
  private isQuietHours(start?: number, end?: number): boolean {
    if (start == null || end == null) return false;

    const now = new Date();
    const hour = now.getHours();

    if (start <= end) {
      // Same-day range (e.g. 09:00–17:00)
      return hour >= start && hour < end;
    } else {
      // Overnight range (e.g. 23:00–06:00)
      return hour >= start || hour < end;
    }
  }
}
