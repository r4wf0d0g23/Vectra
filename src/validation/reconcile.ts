import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatorHealth } from './client.js';
import type { ValidatorHealth } from './types.js';

export interface ReconciliationResult {
  ok: boolean;
  expectedConfigHash: string;
  health?: ValidatorHealth;
  reason?: 'validator_unreachable' | 'config_or_health_mismatch';
}

export async function reconcileValidator(configPath: string): Promise<ReconciliationResult> {
  const raw = await readFile(configPath);
  const config = JSON.parse(raw.toString('utf8')) as { socketPath: string };
  const expectedConfigHash = createHash('sha256').update(raw).digest('hex');
  try {
    const health = await validatorHealth(config.socketPath);
    if (health.status !== 'ok' || health.configHash !== expectedConfigHash) {
      return { ok: false, reason: 'config_or_health_mismatch', expectedConfigHash, health };
    }
    return { ok: true, expectedConfigHash, health };
  } catch {
    return { ok: false, reason: 'validator_unreachable', expectedConfigHash };
  }
}
