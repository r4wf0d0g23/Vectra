import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();

test('production environment template contains every composed startup requirement', async () => {
  const env = await readFile(join(root, 'deploy/proxy.env.example'), 'utf8');
  for (const key of [
    'VECTRA_TOOL_GATEWAY_PATH', 'VECTRA_RUN_TOKEN_SIGNING_KEY',
    'VECTRA_VALIDATOR_ADAPTERS', 'VECTRA_ENFORCEMENT_MODE',
  ]) assert.match(env, new RegExp(`^${key}=`, 'm'));
  const dryRun = spawnSync(process.execPath, ['deploy/validate-production-env.mjs', '--template', 'deploy/proxy.env.example'], { cwd: root, encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).port, 18800);
});

test('environment preflight fails when a required composed variable is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vectra-env-test-'));
  const source = await readFile(join(root, 'deploy/proxy.env.example'), 'utf8');
  const broken = join(dir, 'broken.env');
  await writeFile(broken, source.replace(/^VECTRA_TOOL_GATEWAY_PATH=.*\n/m, ''));
  const dryRun = spawnSync(process.execPath, ['deploy/validate-production-env.mjs', '--template', broken], { cwd: root, encoding: 'utf8' });
  assert.notEqual(dryRun.status, 0);
  assert.match(dryRun.stderr, /VECTRA_TOOL_GATEWAY_PATH is required/);
});

test('service preflights the environment and all deployment assets use port 18800', async () => {
  const service = await readFile(join(root, 'deploy/systemd/vectra-proxy.service'), 'utf8');
  const manifest = await readFile(join(root, 'integrations/openclaw-vectra-tool/openclaw.plugin.json'), 'utf8');
  const plugin = await readFile(join(root, 'integrations/openclaw-vectra-tool/lib.js'), 'utf8');
  const docs = await readFile(join(root, 'integrations/openclaw-vectra-tool/README.md'), 'utf8');
  assert.match(service, /ExecStartPre=\/usr\/bin\/node \/opt\/vectra\/current\/deploy\/validate-production-env\.mjs/);
  for (const value of [manifest, plugin, docs]) {
    assert.match(value, /18800/);
    assert.doesNotMatch(value, /18801/);
  }
});
