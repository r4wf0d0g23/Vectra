import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AtpLoader } from '../atp/loader.js';
import { reconcileValidator } from '../validation/reconcile.js';

export interface ProbeResult { name: string; ok: boolean; durationMs: number; detail: string }
export interface ReadinessReport { ready: boolean; checkedAt: string; probes: ProbeResult[] }
export interface ReadinessProbe { name: string; run(signal: AbortSignal): Promise<string> }

export class ReadinessService {
  private last: ReadinessReport | null = null;
  constructor(private readonly probes: ReadinessProbe[], private readonly timeoutMs = 5_000) {}

  getLastReport(): ReadinessReport | null { return this.last; }

  async check(): Promise<ReadinessReport> {
    const probes: ProbeResult[] = [];
    for (const probe of this.probes) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const detail = await Promise.race([
          probe.run(controller.signal),
          new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(`probe timed out after ${this.timeoutMs}ms`)), { once: true })),
        ]);
        probes.push({ name: probe.name, ok: true, durationMs: Date.now() - started, detail });
      } catch (error) {
        probes.push({ name: probe.name, ok: false, durationMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) });
      } finally { clearTimeout(timer); }
    }
    this.last = { ready: probes.every((probe) => probe.ok), checkedAt: new Date().toISOString(), probes };
    return this.last;
  }

  async reconcileStartup(): Promise<ReadinessReport> {
    const report = await this.check();
    if (!report.ready) {
      const failed = report.probes.filter((probe) => !probe.ok).map((probe) => probe.name).join(', ');
      throw new Error(`startup reconciliation failed: ${failed}`);
    }
    return report;
  }
}

export function atpParserProbe(instancePath: string): ReadinessProbe {
  return { name: 'atp-parser', async run() {
    const data = await new AtpLoader(instancePath).load();
    if (data.protocols.size === 0) throw new Error('no ATP protocols parsed');
    if (!data.protocols.has('conversational')) throw new Error('conversational fallback missing');
    return `${data.protocols.size} protocols, ${data.vars.size} vars`;
  } };
}

export function durableStoreProbe(name: 'snapshot-store' | 'ledger', path: string): ReadinessProbe {
  return { name, async run() {
    await mkdir(path, { recursive: true });
    const marker = join(path, `.readiness-${randomUUID()}`);
    await writeFile(marker, 'vectra-readiness', { flag: 'wx', mode: 0o600 });
    await rm(marker);
    return 'atomic write/remove passed';
  } };
}

export function validatorProbe(configPath: string): ReadinessProbe {
  return { name: 'validator', async run() {
    const result = await reconcileValidator(configPath);
    if (!result.ok) throw new Error(result.reason ?? 'validator unhealthy');
    return `config ${result.expectedConfigHash}`;
  } };
}

export function upstreamProbe(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ReadinessProbe {
  return { name: 'upstream', async run(signal) {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
      method: 'GET', signal, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
    await response.body?.cancel();
    return `HTTP ${response.status}`;
  } };
}
