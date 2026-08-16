import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AtpEnforcementController } from '../dist/src/atp/enforcement-controller.js';
import { ProviderForwarder } from '../dist/src/transport/provider-forwarder.js';

async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { await new Promise((resolve) => server.close(resolve)); }
async function call(base, body) { return new Promise((resolve, reject) => { const req = request(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { const chunks=[]; res.on('data',(c)=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()})); }); req.on('error',reject); req.end(body); }); }

function binding() { return { kind:'single', protocolId:'mutate', protocolVersion:'1.0.0', protocolSchemaVersion:'1.0.0', protocolBytes:Buffer.from('p'), requiredVariables:[{id:'state',version:'1.0.0',schemaVersion:'1.0.0',bytes:Buffer.from('v'),adapterId:'state'}], toolImpacts:['write-capable'], allowReadOnlyDegradation:false }; }

async function controller(root, validator) { return new AtpEnforcementController({ mode:'enforce', instancePath:root, snapshotPath:join(root,'snapshots'), ledgerPath:join(root,'ledger'), validatorSocketPath:join(root,'v.sock'), pluginVersion:'1.0.0', routes:{resolve:async()=>binding()}, validator, preExecutionOnly:true }); }

test('stale variable blocks before mock provider receives a request', async () => {
  const root = await mkdtemp(join(tmpdir(),'vectra-preexec-')); let upstreamCalls=0;
  const gate = await controller(root,{health:async()=>({status:'ok',configHash:'a'.repeat(64)}),validate:async()=>({ok:false})});
  const proxy=createServer((req,res)=>new ProviderForwarder({upstreamBaseUrl:'http://provider.invalid',releaseController:gate,fetchImpl:async()=>{upstreamCalls++;return new Response('{}')}}).forward(req,res));
  const url=await listen(proxy); try { const result=await call(url,JSON.stringify({messages:[{role:'user',content:'mutate'}]})); assert.equal(result.status,503); assert.equal(upstreamCalls,0); } finally { await close(proxy); }
});

test('pending is durable before provider call and tool-call response is not deadlocked', async () => {
  const root = await mkdtemp(join(tmpdir(),'vectra-preexec-'));
  const gate = await controller(root,{health:async()=>({status:'ok',configHash:'a'.repeat(64)}),validate:async()=>({ok:true})});
  let pendingObserved=false;
  const toolResponse=JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'x',type:'function'}]}}]});
  const proxy=createServer((req,res)=>new ProviderForwarder({upstreamBaseUrl:'http://provider.invalid',releaseController:gate,fetchImpl:async()=>{ const names=await readdir(join(root,'ledger')); const events=JSON.parse(await readFile(join(root,'ledger',names[0]),'utf8')); pendingObserved=events[0].type==='pending'; return new Response(toolResponse,{status:200,headers:{'content-type':'application/json'}}); }}).forward(req,res));
  const url=await listen(proxy); try { const result=await call(url,JSON.stringify({messages:[{role:'user',content:'mutate'}]})); assert.equal(pendingObserved,true); assert.equal(result.status,200); assert.equal(result.body,toolResponse); const reconciled=await gate.reconcile(); assert.equal(reconciled.length,1); } finally { await close(proxy); }
});
