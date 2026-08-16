#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REQUIRED = [
  'VECTRA_ATP_PATH', 'VECTRA_SNAPSHOT_PATH', 'VECTRA_LEDGER_PATH',
  'VECTRA_ARTIFACTS_PATH', 'VECTRA_TELEMETRY_PATH', 'VECTRA_VALIDATOR_CONFIG',
  'VECTRA_VALIDATOR_ADAPTERS', 'VECTRA_TOOL_GATEWAY_PATH',
  'VECTRA_RUN_TOKEN_SIGNING_KEY', 'VECTRA_ENFORCEMENT_MODE',
  'VECTRA_UPSTREAM_URL', 'VECTRA_UPSTREAM_TOKEN', 'VECTRA_PROXY_TOKEN',
  'VECTRA_PROXY_PORT', 'VECTRA_SHUTDOWN_GRACE_MS',
];
const PATH_KEYS = [
  'VECTRA_ATP_PATH', 'VECTRA_SNAPSHOT_PATH', 'VECTRA_LEDGER_PATH',
  'VECTRA_ARTIFACTS_PATH', 'VECTRA_TELEMETRY_PATH', 'VECTRA_VALIDATOR_CONFIG',
  'VECTRA_TOOL_GATEWAY_PATH',
];

function parseEnvFile(raw) {
  const result = {};
  for (const source of raw.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) throw new Error(`invalid environment line: ${line}`);
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

export function validateProductionEnv(input, { template = false } = {}) {
  const errors = [];
  for (const key of REQUIRED) if (!input[key]) errors.push(`${key} is required`);
  for (const key of PATH_KEYS) if (input[key] && !isAbsolute(input[key])) errors.push(`${key} must be absolute`);
  const port = Number(input.VECTRA_PROXY_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push('VECTRA_PROXY_PORT must be an unprivileged TCP port');
  const grace = Number(input.VECTRA_SHUTDOWN_GRACE_MS);
  if (!Number.isInteger(grace) || grace < 1000 || grace > 120000) errors.push('VECTRA_SHUTDOWN_GRACE_MS is out of range');
  if (!['enforce', 'observe'].includes(input.VECTRA_ENFORCEMENT_MODE)) errors.push('VECTRA_ENFORCEMENT_MODE must be enforce or observe');
  try {
    const url = new URL(input.VECTRA_UPSTREAM_URL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch { errors.push('VECTRA_UPSTREAM_URL must be an HTTP(S) URL'); }
  try {
    const adapters = JSON.parse(input.VECTRA_VALIDATOR_ADAPTERS);
    if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters) || Object.keys(adapters).length === 0 || Object.values(adapters).some((value) => typeof value !== 'string' || !value)) throw new Error();
  } catch { errors.push('VECTRA_VALIDATOR_ADAPTERS must be a non-empty JSON object of string mappings'); }
  if (!template) {
    const signing = input.VECTRA_RUN_TOKEN_SIGNING_KEY ?? '';
    let signingBytes = 0;
    if (/^[a-f0-9]{64,}$/i.test(signing) && signing.length % 2 === 0) signingBytes = Buffer.from(signing, 'hex').length;
    else { try { signingBytes = Buffer.from(signing, 'base64').length; } catch {} }
    if (signingBytes < 32) errors.push('VECTRA_RUN_TOKEN_SIGNING_KEY must decode to at least 32 bytes');
    for (const key of ['VECTRA_UPSTREAM_TOKEN', 'VECTRA_PROXY_TOKEN']) if (Buffer.byteLength(input[key] ?? '') < 32) errors.push(`${key} must contain at least 32 bytes`);
  }
  if (errors.length) throw new Error(errors.join('; '));
  return { valid: true, mode: input.VECTRA_ENFORCEMENT_MODE, port, requiredKeys: REQUIRED.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const templateIndex = process.argv.indexOf('--template');
  const file = templateIndex >= 0 ? process.argv[templateIndex + 1] : undefined;
  const values = file ? parseEnvFile(await readFile(file, 'utf8')) : process.env;
  try { console.log(JSON.stringify(validateProductionEnv(values, { template: templateIndex >= 0 }))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
