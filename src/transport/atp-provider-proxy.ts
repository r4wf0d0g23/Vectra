import type { IncomingMessage, ServerResponse } from 'node:http';
import { AtpEnforcementController, type EnforcementControllerOptions } from '../atp/enforcement-controller.js';
import { ProviderForwarder } from './provider-forwarder.js';
import { AtpProductionRouteResolver } from '../atp/production-adapters.js';

export interface AtpProviderProxyOptions extends Omit<EnforcementControllerOptions, 'routes' | 'receipts'> {
  upstreamBaseUrl: string;
  upstreamAuthorization?: string;
  validatorAdapters: Readonly<Record<string, string>>;
  maxRequestBytes?: number;
  maxHeldResponseBytes?: number;
  fetchImpl?: typeof fetch;
  localOnlyRequestHeaders?: readonly string[];
}

/**
 * Production construction path. It deliberately has no immediate-release
 * option: every supported provider request crosses the owning ATP controller.
 */
export async function createAtpProviderProxy(options: AtpProviderProxyOptions): Promise<{
  controller: AtpEnforcementController;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}> {
  const controller = new AtpEnforcementController({
    ...options,
    routes: new AtpProductionRouteResolver(options.instancePath, options.validatorAdapters),
    preExecutionOnly: options.toolGateway ? false : true,
  });
  await controller.reconcile();
  const forwarder = new ProviderForwarder({
    upstreamBaseUrl: options.upstreamBaseUrl,
    releaseController: controller,
    maxRequestBytes: options.maxRequestBytes,
    maxHeldResponseBytes: options.maxHeldResponseBytes,
    fetchImpl: options.fetchImpl,
    upstreamAuthorization: options.upstreamAuthorization,
    localOnlyRequestHeaders: options.localOnlyRequestHeaders,
  });
  return { controller, handle: (req, res) => forwarder.forward(req, res) };
}
