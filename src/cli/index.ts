#!/usr/bin/env node
/**
 * Vectra CLI entry point.
 *
 * Usage:
 *   vectra init   — create a new instance config
 *   vectra start  — start Vectra with configured instance
 */

const command = process.argv[2];

if (command === 'init') {
  import('./init.js').then((m) => m.init());
} else if (command === 'start') {
  import('../index.js').then(async (m) => {
    const { createTransport } = await import('../transport/factory.js');
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { config: dotenv } = await import('dotenv');
    dotenv();

    // Resolve instance path
    let instancePath = process.env['VECTRA_INSTANCE'];
    if (!instancePath) {
      const dir = resolve(process.cwd(), 'instances');
      const files = readdirSync(dir).map((f: string) => f.trim()).filter((f: string) => f.endsWith('.instance.json'));
      if (files.length === 1) instancePath = resolve(dir, files[0]!);
      else { console.error('[vectra] No instance found. Run: vectra init'); process.exit(1); }
    }

    const instance = JSON.parse(readFileSync(instancePath, 'utf-8'));
    console.log(`[Vectra] Starting instance: ${instance.instanceId}`);

    if (instance.transport.type === 'discord' && !process.env['DISCORD_BOT_TOKEN']) {
      console.error('[vectra] Error: DISCORD_BOT_TOKEN not set. Add it to .env');
      process.exit(1);
    }

    const transport = createTransport(instance.transport.type, {
      ...instance.transport.config,
      token: process.env[instance.transport.config.tokenEnvVar ?? 'DISCORD_BOT_TOKEN'],
    });

    m.wireMessageHandler(transport);
    m.initScheduler();

    transport.onConnect(() => console.log('[Vectra] Connected'));
    transport.onDisconnect((reason: string) => console.log(`[Vectra] Disconnected: ${reason}`));
    transport.onError((err: Error) => console.error('[Vectra] Error:', err.message));

    await transport.connect();
    console.log('[Vectra] Running. Ctrl+C to stop.');

    process.on('SIGINT', () => { m.shutdown(); process.exit(0); });
    process.on('SIGTERM', () => { m.shutdown(); process.exit(0); });
  }).catch((err: Error) => {
    console.error('[Vectra] Fatal startup error:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
} else if (command === 'soul-reset') {
  // Delete the session database so next start is fresh
  import('node:fs').then(({ existsSync, unlinkSync }) => {
    import('node:path').then(({ resolve }) => {
      import('node:os').then(({ homedir }) => {
        const instanceId = process.argv[3];
        if (!instanceId) {
          console.error('[vectra] Usage: vectra soul-reset <instanceId>');
          console.error('[vectra] Example: vectra soul-reset vectra-prime');
          process.exit(1);
        }
        const dbPath = resolve(homedir(), `.vectra/${instanceId}/sessions.db`);
        console.warn(`[vectra] WARNING: This will permanently delete all session history for: ${instanceId}`);
        console.warn(`[vectra] Database path: ${dbPath}`);
        if (existsSync(dbPath)) {
          unlinkSync(dbPath);
          console.log(`[vectra] Session history cleared for: ${instanceId}`);
          console.log('[vectra] Next start will begin fresh with current soul files.');
        } else {
          console.log(`[vectra] No session database found at: ${dbPath}`);
          console.log('[vectra] Nothing to delete — already clean.');
        }
      });
    });
  });
} else {
  console.log('Usage: vectra [init|start|soul-reset]');
  console.log('  init              — create a new instance config');
  console.log('  start             — start Vectra with configured instance');
  console.log('  soul-reset <id>   — clear session history for an instance (destructive)');
}
