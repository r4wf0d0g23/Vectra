#!/usr/bin/env node
const base = process.env.VECTRA_DRILL_URL ?? 'http://127.0.0.1:18800';
const token = process.env.VECTRA_PROXY_TOKEN;
if (!token) throw new Error('VECTRA_PROXY_TOKEN is required');

async function probe(path, authenticated = false) {
  const response = await fetch(`${base}${path}`, { headers: authenticated ? { 'x-vectra-token': token } : {} });
  return { path, status: response.status, body: await response.text() };
}

const results = [];
results.push(await probe('/health'));
results.push(await probe('/ready', true));
results.push(await probe('/v1/models', false));
const passed = results[0].status === 200 && results[1].status === 200 && results[2].status === 401;
console.log(JSON.stringify({ passed, phase: 'pre-rollback', results }, null, 2));
if (!passed) process.exit(1);

console.log('\nOperator drill sequence (not executed):');
console.log('1. Stop canary traffic; keep ledger/snapshots/artifacts intact.');
console.log('2. Restore the prior OpenClaw canary provider configuration using its validated backup.');
console.log('3. Verify a real completion through the baseline provider endpoint.');
console.log('4. Stop Vectra only after traffic is confirmed drained; preserve forensic state.');
console.log('5. Confirm the canary service identity still cannot reach the wrapped provider directly.');
