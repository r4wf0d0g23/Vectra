import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function requireStrongLocalToken(token: string): void {
  if (Buffer.byteLength(token, 'utf8') < 32) throw new Error('VECTRA_PROXY_TOKEN must contain at least 32 bytes');
}

export function isLocallyAuthenticated(req: IncomingMessage, expected: string): boolean {
  const supplied = req.headers['x-vectra-token'];
  if (typeof supplied !== 'string') return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}
