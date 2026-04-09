/**
 * Vectra Entry Point — v0.2.0
 *
 * Loads instance config, creates the transport connector, and starts
 * receiving messages. Full pipeline (intake gate → dispatcher → context
 * engine → model → receipt gate) is wired in v0.3.0.
 */

import { readFileSync } from 'fs';
import { createTransport } from './transport/factory.js';
import type { VectraConfig } from '../config/vectra.config.js';

interface InstanceConfig {
  instanceId: string;
  transport: {
    type: string;
    config: Record<string, unknown>;
  };
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const instancePath =
    process.env['VECTRA_INSTANCE'] || 'instances/reality-anchor.instance.json';
  const instance: InstanceConfig = JSON.parse(
    readFileSync(instancePath, 'utf8')
  );

  console.log(`[Vectra] Starting instance: ${instance.instanceId}`);

  const transport = createTransport(
    instance.transport.type,
    instance.transport.config
  );

  transport.onMessage(async (message) => {
    console.log(
      `[Vectra] Message from ${message.senderId}: ${message.text.slice(0, 80)}`
    );
    // TODO v0.3.0: route through intake gate → dispatcher → context engine → model → receipt gate
    // For now: echo acknowledgment to confirm transport is working
    await transport.send({
      channelId: message.channelId,
      text: `⚓ Vectra transport online. Message received. Full pipeline not yet wired (v0.3.0).`,
      replyToId: message.id,
    });
  });

  transport.onConnect(() => console.log('[Vectra] Transport connected'));
  transport.onDisconnect((reason) =>
    console.log(`[Vectra] Transport disconnected: ${reason}`)
  );
  transport.onError((err) => console.error('[Vectra] Transport error:', err));

  await transport.connect();
  console.log('[Vectra] Running. Press Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    await transport.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
