/**
 * Vectra Checkpoint Persistence
 *
 * Durable checkpoints are taken at key moments in job lifecycle:
 *   - On job admission (post intake gate)
 *   - After plan generation
 *   - Before each tool call with side effects
 *   - After each tool call with side effects
 *   - Before verification
 *
 * Checkpoints enable:
 *   - Recovery from crashes (resume from last checkpoint)
 *   - Captain-2 failover (standby reads checkpoints)
 *   - Audit trail (full execution history)
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Checkpoint, JobEnvelope, JobState } from './job.js';

// ─── Checkpoint Store ───────────────────────────────────────────────

export interface CheckpointStore {
  /** Save a checkpoint for a job. */
  save(jobId: string, checkpoint: Checkpoint): Promise<void>;
  /** Load all checkpoints for a job, ordered by creation time. */
  loadAll(jobId: string): Promise<Checkpoint[]>;
  /** Load the latest checkpoint for a job. */
  loadLatest(jobId: string): Promise<Checkpoint | null>;
}

// ─── File-Based Checkpoint Store ────────────────────────────────────

export class FileCheckpointStore implements CheckpointStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private jobDir(jobId: string): string {
    return join(this.basePath, jobId);
  }

  async save(jobId: string, checkpoint: Checkpoint): Promise<void> {
    const dir = this.jobDir(jobId);
    await mkdir(dir, { recursive: true });
    const filename = `${checkpoint.id}.json`;
    await writeFile(
      join(dir, filename),
      JSON.stringify(checkpoint, null, 2),
      'utf-8'
    );
  }

  async loadAll(jobId: string): Promise<Checkpoint[]> {
    const dir = this.jobDir(jobId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const checkpoints: Checkpoint[] = [];
    for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
      const raw = await readFile(join(dir, file), 'utf-8');
      checkpoints.push(JSON.parse(raw) as Checkpoint);
    }

    return checkpoints;
  }

  async loadLatest(jobId: string): Promise<Checkpoint | null> {
    const all = await this.loadAll(jobId);
    return all.length > 0 ? all[all.length - 1] : null;
  }
}

// ─── Checkpoint Factory ─────────────────────────────────────────────

let checkpointSequence = 0;

/**
 * Create a checkpoint from the current job state.
 */
export function createCheckpoint(
  job: JobEnvelope,
  notes: string
): Checkpoint {
  checkpointSequence++;
  return {
    id: `${job.id}-cp-${String(checkpointSequence).padStart(4, '0')}`,
    createdAt: new Date().toISOString(),
    state: job.state,
    contextSnapshot: { ...job.context },
    toolCallsCompleted: job.toolCallCount,
    elapsedMs: job.elapsedMs,
    notes,
  };
}
