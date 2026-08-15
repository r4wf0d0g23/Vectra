import { spawn } from 'node:child_process';
import type { ValidationResult, ValidatorAdapter } from './types.js';

const SAFE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  HOME: '/nonexistent',
  NO_COLOR: '1',
};

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /\b(?:sk|ghp|shpat)_[A-Za-z0-9_-]{16,}\b/g,
];

function redact(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value);
}

export async function runAdapter(
  adapter: ValidatorAdapter,
  correlationId: string,
  defaults: { timeoutMs: number; maxOutputBytes: number },
): Promise<ValidationResult> {
  const started = Date.now();
  const timeoutMs = adapter.timeoutMs ?? defaults.timeoutMs;
  const maxOutputBytes = adapter.maxOutputBytes ?? defaults.maxOutputBytes;

  return new Promise((resolveResult) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(adapter.executable, adapter.args, {
      cwd: adapter.cwd,
      env: SAFE_ENV,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = maxOutputBytes - current.length;
      if (remaining <= 0) { truncated = true; return current; }
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    timer.unref();

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: !error && !timedOut && exitCode === 0 && !truncated,
        adapterId: adapter.id,
        correlationId,
        exitCode,
        timedOut,
        truncated,
        stdout: redact(stdout.toString('utf8')),
        stderr: redact(stderr.toString('utf8')),
        durationMs: Date.now() - started,
        ...(error ? { error } : {}),
      });
    };
    child.once('error', (error) => finish(null, error.message));
    child.once('close', (code) => finish(code));
  });
}
