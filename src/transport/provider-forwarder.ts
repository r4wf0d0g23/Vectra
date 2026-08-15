import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ProviderDialectRegistry,
  type ProviderRequest,
} from '../model/provider-dialect.js';
import type { ResponseReleaseController } from '../model/response-release.js';
import {
  BodyLimitError, forwardedRequestHeaders, pipeWebResponse, readBoundedRequest,
  readBoundedResponse, writeUpstreamHeaders,
} from './http-utils.js';

export interface ProviderForwarderOptions {
  upstreamBaseUrl: string;
  releaseController: ResponseReleaseController;
  maxRequestBytes?: number;
  maxHeldResponseBytes?: number;
  fetchImpl?: typeof fetch;
  dialectRegistry?: ProviderDialectRegistry;
  upstreamAuthorization?: string;
}

export class ProviderForwarder {
  private readonly requestLimit: number;
  private readonly heldResponseLimit: number;
  private readonly fetchImpl: typeof fetch;
  private readonly dialectRegistry: ProviderDialectRegistry;

  constructor(private readonly options: ProviderForwarderOptions) {
    this.requestLimit = options.maxRequestBytes ?? 2 * 1024 * 1024;
    this.heldResponseLimit = options.maxHeldResponseBytes ?? 16 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dialectRegistry = options.dialectRegistry ?? new ProviderDialectRegistry();
  }

  supports(req: IncomingMessage): boolean {
    return req.method === 'POST' && this.dialectRegistry.match(req.url ?? '/') !== null;
  }

  async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = this.dialectRegistry.match(req.url ?? '/');
    if (!route || req.method !== 'POST') throw new Error('Unsupported provider route');
    const { api, dialect } = route;

    let raw: Buffer;
    try {
      raw = await readBoundedRequest(req, this.requestLimit);
    } catch (error) {
      if (error instanceof BodyLimitError) return this.error(res, 413, 'request_too_large', error.message);
      throw error;
    }

    let body: ProviderRequest;
    try { body = JSON.parse(raw.toString('utf8')) as ProviderRequest; }
    catch { return this.error(res, 400, 'invalid_json', 'Request body must be valid JSON'); }

    const headers = forwardedRequestHeaders(req.headers);
    if (this.options.upstreamAuthorization) headers.set('authorization', this.options.upstreamAuthorization);
    // Node fetch auto-decompresses response bodies. Asking the provider for an
    // identity representation keeps proxy payload and header semantics aligned.
    headers.set('accept-encoding', 'identity');
    headers.set('content-length', String(raw.byteLength));
    const abort = new AbortController();
    const onClose = (): void => abort.abort(new Error('downstream disconnected'));
    req.once('aborted', onClose);
    res.once('close', onClose);

    try {
      let hold: boolean;
      try { hold = await this.options.releaseController.requiresHold(api, body, {headers:req.headers}); }
      catch { return this.error(res, 503, 'enforcement_unavailable', 'ATP enforcement decision unavailable'); }

      const target = new URL(req.url ?? '/', this.options.upstreamBaseUrl).toString();
      const upstream = await this.fetchImpl(target, {
        method: 'POST', headers, body: raw, signal: abort.signal, redirect: 'manual',
      });
      if (!hold) {
        res.statusCode = upstream.status;
        res.statusMessage = upstream.statusText;
        writeUpstreamHeaders(res, upstream.headers);
        await pipeWebResponse(upstream, res);
        return;
      }

      let responseBody: Uint8Array;
      try { responseBody = await readBoundedResponse(upstream, this.heldResponseLimit); }
      catch (error) {
        if (error instanceof BodyLimitError) return this.error(res, 502, 'held_response_too_large', error.message);
        throw error;
      }
      let decision;
      try {
        decision = await this.options.releaseController.evaluate({
          api, request: body, taskDescription: dialect.extractTask(api, body),
          upstreamStatus: upstream.status, upstreamHeaders: upstream.headers, responseBody,
        });
      } catch {
        return this.error(res, 503, 'enforcement_unavailable', 'ATP response validation unavailable');
      }
      if (!decision.release) {
        return this.error(res, decision.status ?? 409, decision.code, decision.message);
      }
      res.statusCode = upstream.status;
      res.statusMessage = upstream.statusText;
      writeUpstreamHeaders(res, upstream.headers, responseBody.byteLength);
      for(const [key,value] of Object.entries(decision.responseHeaders??{}))res.setHeader(key,value);
      res.end(responseBody);
    } catch (error) {
      if (!res.headersSent && !res.writableEnded) {
        this.error(res, 502, 'upstream_error', error instanceof Error ? error.message : 'Upstream failure');
      } else if (!res.writableEnded) res.destroy(error instanceof Error ? error : undefined);
    } finally {
      req.off('aborted', onClose);
      res.off('close', onClose);
    }
  }

  private error(res: ServerResponse, status: number, code: string, message: string): void {
    if (res.writableEnded) return;
    const payload = Buffer.from(JSON.stringify({ error: { message, type: 'vectra_proxy_error', code } }));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.byteLength });
    res.end(payload);
  }
}
