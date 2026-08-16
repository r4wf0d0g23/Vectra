import { request } from 'node:http';
import type { ValidationResult, ValidatorHealth } from './types.js';

async function call<T>(socketPath: string, method: string, path: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise<T>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: body ? {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } : undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
        if ((res.statusCode ?? 500) >= 400) reject(Object.assign(new Error('validator rejected request'), { response: parsed }));
        else resolve(parsed);
      });
    });
    req.once('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('validator request timed out')));
    if (body) req.end(body); else req.end();
  });
}

export const validatorHealth = (socketPath: string): Promise<ValidatorHealth> => call(socketPath, 'GET', '/health');
export const validate = (socketPath: string, adapterId: string, correlationId: string): Promise<ValidationResult> =>
  call(socketPath, 'POST', '/v1/validate', { adapterId, correlationId });
