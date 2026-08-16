import type { IncomingMessage, ServerResponse } from 'node:http';

export const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export const LOCAL_CREDENTIAL_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'x-vectra-token', 'x-vectra-run-token',
]);

export class BodyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`HTTP body exceeds ${limit} bytes`);
    this.name = 'BodyLimitError';
  }
}

export async function readBoundedRequest(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyLimitError(limit);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > limit) throw new BodyLimitError(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function forwardedRequestHeaders(
  headers: IncomingMessage['headers'],
  localOnlyHeaders: readonly string[] = [],
): Headers {
  const output = new Headers();
  const blocked = new Set([...LOCAL_CREDENTIAL_HEADERS, ...localOnlyHeaders.map((name) => name.toLowerCase())]);
  const connectionTokens = new Set(
    (Array.isArray(headers.connection) ? headers.connection.join(',') : headers.connection ?? '')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  for (const [name, raw] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (raw === undefined || blocked.has(normalized) || HOP_BY_HOP_HEADERS.has(normalized) || connectionTokens.has(normalized) || normalized === 'host') continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) output.append(name, value);
  }
  return output;
}

export function writeUpstreamHeaders(res: ServerResponse, headers: Headers, bufferedLength?: number): void {
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    // fetch transparently decodes compressed bodies, so forwarding the original
    // content-encoding would make an otherwise valid body unreadable downstream.
    if (!HOP_BY_HOP_HEADERS.has(normalized) && normalized !== 'content-length' && normalized !== 'set-cookie' && normalized !== 'content-encoding') {
      res.setHeader(name, value);
    }
  });
  const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = cookieHeaders.getSetCookie?.() ?? [];
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  if (bufferedLength !== undefined) res.setHeader('content-length', String(bufferedLength));
}

export async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel(new BodyLimitError(limit));
        throw new BodyLimitError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export async function pipeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (error) {
    res.destroy(error instanceof Error ? error : undefined);
  } finally {
    reader.releaseLock();
  }
}
