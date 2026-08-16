import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ValidatorAdapter, ValidatorDaemonConfig } from './types.js';

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function canonicalExisting(path: string): Promise<string> {
  return realpath(resolve(path));
}

export async function loadValidatorConfig(path: string): Promise<{
  config: ValidatorDaemonConfig;
  configHash: string;
}> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as ValidatorDaemonConfig;
  if (!isAbsolute(parsed.socketPath) || !Array.isArray(parsed.adapters)) {
    throw new Error('socketPath must be absolute and adapters must be an array');
  }
  if (!parsed.allowedExecutableRoots?.length || !parsed.allowedWorkingRoots?.length) {
    throw new Error('allowed executable and working roots are required');
  }
  if ((parsed.maxConcurrent ?? 2) < 1 || (parsed.maxConcurrent ?? 2) > 16) {
    throw new Error('maxConcurrent must be between 1 and 16');
  }
  for (const [name, value, min, max] of [
    ['defaultTimeoutMs', parsed.defaultTimeoutMs ?? 10_000, 100, 300_000],
    ['defaultMaxOutputBytes', parsed.defaultMaxOutputBytes ?? 65_536, 1, 1_048_576],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`);
  }

  const executableRoots = await Promise.all(parsed.allowedExecutableRoots.map(canonicalExisting));
  const workingRoots = await Promise.all(parsed.allowedWorkingRoots.map(canonicalExisting));
  const ids = new Set<string>();
  const adapters: ValidatorAdapter[] = [];
  for (const adapter of parsed.adapters) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(adapter.id) || ids.has(adapter.id)) {
      throw new Error(`invalid or duplicate adapter id: ${adapter.id}`);
    }
    ids.add(adapter.id);
    if (!isAbsolute(adapter.executable) || !isAbsolute(adapter.cwd)) {
      throw new Error(`adapter ${adapter.id} paths must be absolute`);
    }
    if (!Array.isArray(adapter.args) || adapter.args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`adapter ${adapter.id} args must be literal strings`);
    }
    if (adapter.timeoutMs !== undefined && (!Number.isInteger(adapter.timeoutMs) || adapter.timeoutMs < 100 || adapter.timeoutMs > 300_000)) {
      throw new Error(`adapter ${adapter.id} timeoutMs is out of range`);
    }
    if (adapter.maxOutputBytes !== undefined && (!Number.isInteger(adapter.maxOutputBytes) || adapter.maxOutputBytes < 1 || adapter.maxOutputBytes > 1_048_576)) {
      throw new Error(`adapter ${adapter.id} maxOutputBytes is out of range`);
    }
    const executable = await canonicalExisting(adapter.executable);
    const cwd = await canonicalExisting(adapter.cwd);
    const executableStat = await stat(executable);
    if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
      throw new Error(`adapter ${adapter.id} executable is not executable`);
    }
    if (!executableRoots.some((root) => within(executable, root))) {
      throw new Error(`adapter ${adapter.id} executable is outside allowed roots`);
    }
    if (!workingRoots.some((root) => within(cwd, root))) {
      throw new Error(`adapter ${adapter.id} cwd is outside allowed roots`);
    }
    adapters.push({ ...adapter, executable, cwd, args: [...adapter.args] });
  }

  return {
    config: { ...parsed, adapters, allowedExecutableRoots: executableRoots, allowedWorkingRoots: workingRoots },
    configHash: createHash('sha256').update(raw).digest('hex'),
  };
}
