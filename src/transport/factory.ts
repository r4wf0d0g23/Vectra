/**
 * Transport Factory — registry-based connector instantiation.
 *
 * Each transport type registers a factory. The entry point calls
 * createTransport(type, config) to get the right connector.
 */

import type { TransportFactory, TransportConnector } from './interface.js';
import { DiscordConnector } from './discord.js';

const registry = new Map<string, TransportFactory>();

registry.set('discord', {
  create(config: Record<string, unknown>): TransportConnector {
    return new DiscordConnector(config);
  },
});

export function createTransport(
  type: string,
  config: Record<string, unknown>
): TransportConnector {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(
      `Unknown transport type: ${type}. Registered: ${[...registry.keys()].join(', ')}`
    );
  }
  return factory.create(config);
}
