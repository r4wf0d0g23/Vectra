/**
 * ObservationStore — 4-tier storage for raw evidence, observations, resolved
 * facts, and active decision context.
 *
 * Tiers:
 *   1. Raw evidence — append-only
 *   2. Observations — mutable, versioned
 *   3. Resolved facts — high-confidence propositions
 *   4. Active decision context — task-scoped, small
 *
 * Uses in-memory maps backed by optional JSON file persistence.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VectraObservation, Proposition } from './types.js';

// ─── Persistence Shape ────────────────────────────────────────────────

interface RawEvidenceRecord {
  id: string;
  text: string;
  source: string;
  timestamp: string;
}

interface ResolvedFactRecord {
  observationId: string;
  propositionId: string;
  proposition: Proposition;
}

interface StoreData {
  rawEvidence: Record<string, RawEvidenceRecord>;
  observations: Record<string, VectraObservation>;
  resolvedFacts: ResolvedFactRecord[];
  activeContexts: Record<string, string[]>;  // taskId → observationIds
}

// ─── ObservationStore ────────────────────────────────────────────────

export class ObservationStore {
  private filePath: string;
  private rawEvidence: Map<string, RawEvidenceRecord> = new Map();
  private observations: Map<string, VectraObservation> = new Map();
  private resolvedFacts: ResolvedFactRecord[] = [];
  private activeContexts: Map<string, string[]> = new Map();
  private loaded = false;

  constructor(filePath: string = '.vectra/observation-store.json') {
    this.filePath = filePath;
  }

  // ── Init ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as StoreData;
      for (const [k, v] of Object.entries(data.rawEvidence ?? {})) {
        this.rawEvidence.set(k, v);
      }
      for (const [k, v] of Object.entries(data.observations ?? {})) {
        this.observations.set(k, v);
      }
      this.resolvedFacts = data.resolvedFacts ?? [];
      for (const [k, v] of Object.entries(data.activeContexts ?? {})) {
        this.activeContexts.set(k, v);
      }
    } catch {
      // File doesn't exist yet — start empty
    }
  }

  private async persist(): Promise<void> {
    const data: StoreData = {
      rawEvidence: Object.fromEntries(this.rawEvidence),
      observations: Object.fromEntries(this.observations),
      resolvedFacts: this.resolvedFacts,
      activeContexts: Object.fromEntries(this.activeContexts),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── Tier 1: Raw Evidence (append-only) ────────────────────────────

  async addRawEvidence(id: string, text: string, source: string): Promise<void> {
    await this.ensureLoaded();
    if (this.rawEvidence.has(id)) return;  // append-only: never overwrite
    this.rawEvidence.set(id, {
      id,
      text,
      source,
      timestamp: new Date().toISOString(),
    });
    await this.persist();
  }

  async getRawEvidence(id: string): Promise<RawEvidenceRecord | null> {
    await this.ensureLoaded();
    return this.rawEvidence.get(id) ?? null;
  }

  // ── Tier 2: Observations (mutable, versioned) ──────────────────────

  async addObservation(obs: VectraObservation): Promise<void> {
    await this.ensureLoaded();
    this.observations.set(obs.id, obs);
    await this.persist();
  }

  async getObservation(id: string): Promise<VectraObservation | null> {
    await this.ensureLoaded();
    return this.observations.get(id) ?? null;
  }

  async getObservationsBySource(sourceId: string): Promise<VectraObservation[]> {
    await this.ensureLoaded();
    const results: VectraObservation[] = [];
    for (const obs of this.observations.values()) {
      if (obs.sourceId === sourceId) results.push(obs);
    }
    return results;
  }

  // ── Tier 3: Resolved Facts ─────────────────────────────────────────

  async promoteToResolved(observationId: string, propositionId: string): Promise<void> {
    await this.ensureLoaded();
    const obs = this.observations.get(observationId);
    if (!obs) throw new Error(`Observation not found: ${observationId}`);
    const prop = obs.propositions.find((p) => p.id === propositionId);
    if (!prop) throw new Error(`Proposition not found: ${propositionId} in ${observationId}`);

    // Avoid duplicates
    const exists = this.resolvedFacts.some(
      (r) => r.observationId === observationId && r.propositionId === propositionId,
    );
    if (!exists) {
      this.resolvedFacts.push({ observationId, propositionId, proposition: prop });
      await this.persist();
    }
  }

  async getResolvedFacts(filter?: { entityId?: string; minConfidence?: number }): Promise<Proposition[]> {
    await this.ensureLoaded();
    let facts = this.resolvedFacts.map((r) => r.proposition);
    if (filter?.minConfidence !== undefined) {
      facts = facts.filter((p) => p.confidence >= filter.minConfidence!);
    }
    if (filter?.entityId !== undefined) {
      const eid = filter.entityId;
      facts = facts.filter(
        (p) => p.subject.includes(eid) || p.object.includes(eid),
      );
    }
    return facts;
  }

  /**
   * Returns resolved facts that conflict with the given proposition.
   * A conflict is detected when another proposition shares the same subject+predicate
   * but has a different object, or is explicitly listed in contradicts[].
   */
  async checkContradiction(prop: Proposition): Promise<Proposition[]> {
    await this.ensureLoaded();
    const conflicts: Proposition[] = [];
    for (const record of this.resolvedFacts) {
      const existing = record.proposition;
      if (existing.id === prop.id) continue;

      // Explicit contradiction list
      if (prop.contradicts?.includes(existing.id) || existing.contradicts?.includes(prop.id)) {
        conflicts.push(existing);
        continue;
      }

      // Implicit: same subject+predicate, different object
      if (
        existing.subject === prop.subject &&
        existing.predicate === prop.predicate &&
        existing.object !== prop.object
      ) {
        conflicts.push(existing);
      }
    }
    return conflicts;
  }

  // ── Tier 4: Active Decision Context (task-scoped) ──────────────────

  async setActiveContext(taskId: string, observationIds: string[]): Promise<void> {
    await this.ensureLoaded();
    this.activeContexts.set(taskId, observationIds);
    await this.persist();
  }

  async getActiveContext(taskId: string): Promise<VectraObservation[]> {
    await this.ensureLoaded();
    const ids = this.activeContexts.get(taskId) ?? [];
    const results: VectraObservation[] = [];
    for (const id of ids) {
      const obs = this.observations.get(id);
      if (obs) results.push(obs);
    }
    return results;
  }

  async clearActiveContext(taskId: string): Promise<void> {
    await this.ensureLoaded();
    this.activeContexts.delete(taskId);
    await this.persist();
  }
}
