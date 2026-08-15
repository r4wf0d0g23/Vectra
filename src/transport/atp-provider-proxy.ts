import type { IncomingMessage, ServerResponse } from 'node:http';
import { AtpEnforcementController, type EnforcementControllerOptions } from '../atp/enforcement-controller.js';
import { ProviderForwarder } from './provider-forwarder.js';

export interface AtpProviderProxyOptions extends EnforcementControllerOptions {
  upstreamBaseUrl: string;
  maxRequestBytes?: number;
  maxHeldResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Production construction path. It deliberately has no immediate-release
 * option: every supported provider request crosses the owning ATP controller.
 */
export async function createAtpProviderProxy(options: AtpProviderProxyOptions): Promise<{
  controller: AtpEnforcementController;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}> {
  const controller = new AtpEnforcementController(options);
  await controller.reconcile();
  const forwarder = new ProviderForwarder({
    upstreamBaseUrl: options.upstreamBaseUrl,
    releaseController: controller,
    maxRequestBytes: options.maxRequestBytes,
    maxHeldResponseBytes: options.maxHeldResponseBytes,
    fetchImpl: options.fetchImpl,
  });
  return { controller, handle: (req, res) => forwarder.forward(req, res) };
}
