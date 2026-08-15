import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadValidatorConfig, reconcileValidator, startValidatorDaemon, validate, validatorHealth } from '../dist/src/validation/index.js';

async function fixture(script) {
  const dir = await mkdtemp(join(tmpdir(), 'vectra-validator-'));
  const bin = join(dir, 'validator');
  const socketPath = join(dir, 'validator.sock');
  await writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  await chmod(bin, 0o700);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    socketPath, allowedExecutableRoots: [dir], allowedWorkingRoots: [dir],
    defaultTimeoutMs: 100, defaultMaxOutputBytes: 32, maxConcurrent: 1,
    adapters: [{ id: 'fixed', executable: bin, args: ['literal'], cwd: dir }],
  }));
  return { dir, bin, socketPath, configPath };
}

test('runs only the fixed adapter and reports health/restart identity', async () => {
  const f = await fixture('printf "%s" "$1"');
  const first = await startValidatorDaemon(f.configPath);
  const before = await validatorHealth(f.socketPath);
  const result = await validate(f.socketPath, 'fixed', 'run-1');
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'literal');
  assert.equal((await validatorHealth(f.socketPath)).completed, 1);
  await first.stop();
  const second = await startValidatorDaemon(f.configPath);
  const after = await validatorHealth(f.socketPath);
  assert.equal(after.configHash, before.configHash);
  assert.equal(after.completed, 0);
  await second.stop();
});

test('rejects unknown adapters and request-controlled command material', async () => {
  const f = await fixture('exit 0');
  const daemon = await startValidatorDaemon(f.configPath);
  await assert.rejects(validate(f.socketPath, '../../bin/sh', 'run-2'));
  await daemon.stop();
});

test('fails closed on timeout and output overflow', async () => {
  const slow = await fixture('sleep 2');
  let daemon = await startValidatorDaemon(slow.configPath);
  await assert.rejects(validate(slow.socketPath, 'fixed', 'timeout'));
  await daemon.stop();
  const noisy = await fixture('printf "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"');
  daemon = await startValidatorDaemon(noisy.configPath);
  await assert.rejects(validate(noisy.socketPath, 'fixed', 'overflow'));
  await daemon.stop();
});

test('redacts validator output before returning it', async () => {
  const f = await fixture('printf "token=supersecretvalue"');
  const daemon = await startValidatorDaemon(f.configPath);
  const result = await validate(f.socketPath, 'fixed', 'redact');
  assert.equal(result.stdout, '[REDACTED]');
  await daemon.stop();
});

test('rejects symlink/path escapes during config load', async () => {
  const f = await fixture('exit 0');
  const other = await mkdtemp(join(tmpdir(), 'vectra-outside-'));
  const outside = join(other, 'outside');
  await writeFile(outside, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  config.adapters[0].executable = outside;
  await writeFile(f.configPath, JSON.stringify(config));
  await assert.rejects(loadValidatorConfig(f.configPath), /outside allowed roots/);
});

test('production service preserves the validator isolation contract', async () => {
  const unit = await readFile(new URL('../deploy/systemd/vectra-validator.service', import.meta.url), 'utf8');
  for (const setting of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'RestrictAddressFamilies=AF_UNIX', 'CapabilityBoundingSet=', 'RestrictNamespaces=yes']) {
    assert.match(unit, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('reconciliation detects config drift and unreachable rollback state', async () => {
  const f = await fixture('exit 0');
  const daemon = await startValidatorDaemon(f.configPath);
  assert.equal((await reconcileValidator(f.configPath)).ok, true);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  config.defaultTimeoutMs = 101;
  await writeFile(f.configPath, JSON.stringify(config));
  const drift = await reconcileValidator(f.configPath);
  assert.equal(drift.ok, false);
  assert.equal(drift.reason, 'config_or_health_mismatch');
  await daemon.stop();
  const stopped = await reconcileValidator(f.configPath);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, 'validator_unreachable');
});
