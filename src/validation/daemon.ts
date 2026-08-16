import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadValidatorConfig } from './config.js';
import { runAdapter } from './runner.js';
import type { ValidationRequest, ValidatorDaemonConfig, ValidatorHealth } from './types.js';

const MAX_REQUEST_BYTES = 16 * 1024;

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export class ValidatorDaemon {
  private readonly startedAt = new Date().toISOString();
  private active = 0;
  private completed = 0;
  private failed = 0;
  private lastCompletionAt: string | null = null;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(private readonly config: ValidatorDaemonConfig, private readonly configHash: string) {}

  health(): ValidatorHealth {
    return {
      status: 'ok', component: 'vectra-validator', configHash: this.configHash,
      startedAt: this.startedAt, active: this.active, completed: this.completed,
      failed: this.failed, lastCompletionAt: this.lastCompletionAt,
    };
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.config.socketPath), { recursive: true, mode: 0o750 });
    await rm(this.config.socketPath, { force: true });
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.socketPath, resolve);
    });
    await chmod(this.config.socketPath, 0o660);
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await rm(this.config.socketPath, { force: true });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, this.health());
      if (req.method !== 'POST' || req.url !== '/v1/validate') return json(res, 404, { error: 'not_found' });
      if (this.active >= (this.config.maxConcurrent ?? 2)) return json(res, 503, { error: 'capacity_exceeded' });
      const input = JSON.parse((await body(req)).toString('utf8')) as ValidationRequest;
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.adapterId ?? '') ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.correlationId ?? '')) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const adapter = this.config.adapters.find((item) => item.id === input.adapterId);
      if (!adapter) return json(res, 404, { error: 'unknown_adapter' });
      this.active++;
      try {
        const result = await runAdapter(adapter, input.correlationId, {
          timeoutMs: this.config.defaultTimeoutMs ?? 10_000,
          maxOutputBytes: this.config.defaultMaxOutputBytes ?? 64 * 1024,
        });
        this.completed++;
        if (!result.ok) this.failed++;
        this.lastCompletionAt = new Date().toISOString();
        return json(res, result.ok ? 200 : 422, result);
      } finally { this.active--; }
    } catch (error) {
      return json(res, 400, { error: 'invalid_request', detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

export async function startValidatorDaemon(configPath: string): Promise<ValidatorDaemon> {
  const { config, configHash } = await loadValidatorConfig(configPath);
  const daemon = new ValidatorDaemon(config, configHash);
  await daemon.start();
  return daemon;
}
