import { appendFile, readFile } from 'node:fs/promises';
import { createHash, sign } from 'node:crypto';

const logPath = '/var/lib/vectra-canary/workloads.jsonl';
const attestPath = '/var/lib/vectra-canary/attestations.jsonl';
const keyPath = '/etc/vectra-canary/attestation-private.pem';
const lines = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/);
const eventLine = lines.at(-1);
if (!eventLine) throw new Error('workload event missing');
const event = JSON.parse(eventLine);
if (event.ok !== true) throw new Error('refusing to attest failed workload');
if (!process.env.INVOCATION_ID || event.invocation_id !== process.env.INVOCATION_ID) throw new Error('workload invocation binding invalid');
const eventSha256 = createHash('sha256').update(eventLine).digest('hex');
const payload = JSON.stringify({ event_sha256: eventSha256, invocation_id: process.env.INVOCATION_ID, signed_at: new Date().toISOString() });
const privateKey = await readFile(keyPath, 'utf8');
const signature = sign(null, Buffer.from(payload), privateKey).toString('base64');
await appendFile(attestPath, `${JSON.stringify({ payload, signature })}\n`, { mode: 0o600 });
