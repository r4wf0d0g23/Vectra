import { startValidatorDaemon } from './daemon.js';

const configPath = process.env.VECTRA_VALIDATOR_CONFIG;
if (!configPath) throw new Error('VECTRA_VALIDATOR_CONFIG is required');
const daemon = await startValidatorDaemon(configPath);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void daemon.stop().finally(() => process.exit(0)));
}
