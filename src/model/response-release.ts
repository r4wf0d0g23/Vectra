import type { ProviderApiKind, ProviderRequest } from './provider-dialect.js';

export interface ModelExchange {
  api: ProviderApiKind;
  request: ProviderRequest;
  taskDescription: string;
  upstreamStatus: number;
  upstreamHeaders: Headers;
  responseBody: Uint8Array;
}

export type ReleaseDecision =
  | { release: true }
  | { release: false; status?: number; code: string; message: string };

/**
 * ATP enforcement plugs in here. `requiresHold` must be deterministic from the
 * request. Held responses remain private until `evaluate` explicitly releases
 * them; thrown errors fail closed.
 */
export interface ResponseReleaseController {
  requiresHold(api: ProviderApiKind, request: ProviderRequest): boolean | Promise<boolean>;
  evaluate(exchange: ModelExchange): ReleaseDecision | Promise<ReleaseDecision>;
}

export class ImmediateReleaseController implements ResponseReleaseController {
  requiresHold(): boolean { return false; }
  evaluate(): ReleaseDecision { return { release: true }; }
}
