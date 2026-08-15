import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtpToolGateway } from '../src/atp/tool-gateway.js';
import { classifyProviderResponse } from '../src/model/tool-call-classifier.js';

const claims={runId:`run_${'a'.repeat(32)}`,bundleId:'b',protocolId:'p',pinsSha256:'b'.repeat(64)};
async function fix(){const g=new AtpToolGateway(await mkdtemp(join(tmpdir(),'tg-')),Buffer.alloc(32,1));return{g,token:await g.createRun(claims)}}

test('signed token and exact trusted-policy binding reject tamper/replay',async()=>{const{g,token}=await fix();assert.throws(()=>g.verifyToken(token+'x'));await g.registerExpected(token,[{callId:'c',tool:'write',args:{a:1,b:2}}]);await assert.rejects(g.authorizeNativeTool({openClawRunId:'oc',toolCallId:'c',tool:'write',args:{a:9}}));await g.authorizeNativeTool({openClawRunId:'oc',toolCallId:'c',tool:'write',args:{b:2,a:1}});const input={openClawRunId:'oc',toolCallId:'c',tool:'write',args:{a:1,b:2},result:{ok:true}};const one=await g.recordNativeResult(input),retry=await g.recordNativeResult(input);assert.equal(one.resultSha256,retry.resultSha256);assert.equal((await g.finalEligibility(token)).eligible,true)});
test('divergent result retry violates run',async()=>{const{g,token}=await fix();await g.registerExpected(token,[{callId:'c',tool:'write',args:{}}]);await g.authorizeNativeTool({openClawRunId:'oc',toolCallId:'c',tool:'write',args:{}});await g.recordNativeResult({openClawRunId:'oc',toolCallId:'c',tool:'write',args:{},result:1});await assert.rejects(g.recordNativeResult({openClawRunId:'oc',toolCallId:'c',tool:'write',args:{},result:2}),/diverged/);assert.equal((await g.read(claims.runId)).status,'violated')});

const exchange=(api:string,body:unknown,type='application/json')=>({api,request:{},taskDescription:'',upstreamStatus:200,upstreamHeaders:new Headers({'content-type':type}),responseBody:Buffer.from(typeof body==='string'?body:JSON.stringify(body))}) as any;
test('classifier handles Chat, Responses, Anthropic and buffered SSE',()=>{
  assert.equal(classifyProviderResponse(exchange('chat-completions',{choices:[{message:{tool_calls:[{id:'c',function:{name:'x',arguments:'{}'}}]}}]})).kind,'intermediate');
  assert.equal(classifyProviderResponse(exchange('responses',{output:[{type:'function_call',call_id:'c',name:'x',arguments:'{}'}]})).kind,'intermediate');
  assert.equal(classifyProviderResponse(exchange('anthropic-messages',{content:[{type:'tool_use',id:'c',name:'x',input:{}}]})).kind,'intermediate');
  assert.equal(classifyProviderResponse(exchange('responses','data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c","name":"x","arguments":"{}"}}\n\n','text/event-stream')).kind,'intermediate');
});
