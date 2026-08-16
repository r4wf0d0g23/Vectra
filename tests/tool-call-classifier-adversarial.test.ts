import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderResponse, type ToolCall } from '../src/model/tool-call-classifier.js';
import type { ProviderApiKind } from '../src/model/provider-dialect.js';

function exchange(api: ProviderApiKind, body: Uint8Array | string) {
  return {
    api, request: {}, taskDescription: '', upstreamStatus: 200,
    upstreamHeaders: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
    responseBody: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  } as any;
}
function calls(api: ProviderApiKind, body: Uint8Array | string): ToolCall[] {
  const phase = classifyProviderResponse(exchange(api, body));
  assert.equal(phase.kind, 'intermediate');
  return phase.kind === 'intermediate' ? phase.calls : [];
}
function bytesAcrossUtf8Boundary(text: string, marker: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const markerBytes = new TextEncoder().encode(marker);
  let start = -1;
  outer: for (let i = 0; i <= encoded.length - markerBytes.length; i++) {
    for (let j = 0; j < markerBytes.length; j++) if (encoded[i + j] !== markerBytes[j]) continue outer;
    start = i; break;
  }
  assert.ok(start >= 0);
  // Model the response reader receiving chunks split in the middle of a
  // multi-byte code point, then assembling the exact bounded response bytes.
  const chunks = [encoded.slice(0, start + 1), encoded.slice(start + 1, start + 2), encoded.slice(start + 2)];
  const output = new Uint8Array(encoded.length); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

test('Chat assembler reconstructs interleaved fragmented calls and ignores duplicate terminals', () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"write","arguments":"{\\"label\\":\\""}},{"index":1,"id":"call-b","function":{"name":"send","arguments":"{\\"n\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}},{"index":0,"function":{"arguments":"⚓\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]', 'data: [DONE]', '',
  ].join('\n\n');
  assert.deepEqual(calls('chat-completions', bytesAcrossUtf8Boundary(sse, '⚓')), [
    { callId: 'call-a', tool: 'write', args: { label: '⚓' } },
    { callId: 'call-b', tool: 'send', args: { n: 2 } },
  ]);
});

test('Responses assembler joins interleaved deltas and treats done payload as authoritative', () => {
  const sse = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"item-a","call_id":"call-a","name":"write","arguments":""}}',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"item-b","call_id":"call-b","name":"send","arguments":""}}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item-a","delta":"{\\"label\\":\\""}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item-b","delta":"{\\"n\\":2}"}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item-a","delta":"⚓\\"}"}',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"item-a","call_id":"call-a","name":"write","arguments":"{\\"label\\":\\"⚓\\"}"}}',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"item-a","call_id":"call-a","name":"write","arguments":"{\\"label\\":\\"⚓\\"}"}}',
    'event: response.completed\ndata: {"type":"response.completed"}',
    'event: response.completed\ndata: {"type":"response.completed"}', '',
  ].join('\n\n');
  assert.deepEqual(calls('responses', bytesAcrossUtf8Boundary(sse, '⚓')), [
    { callId: 'call-a', tool: 'write', args: { label: '⚓' } },
    { callId: 'call-b', tool: 'send', args: { n: 2 } },
  ]);
});

test('Anthropic assembler joins interleaved partial_json and duplicate message_stop', () => {
  const sse = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-a","name":"write","input":{}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-b","name":"send","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"label\\":\\""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"n\\":2}"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"⚓\\"}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    'event: message_stop\ndata: {"type":"message_stop"}', '',
  ].join('\n\n');
  assert.deepEqual(calls('anthropic-messages', bytesAcrossUtf8Boundary(sse, '⚓')), [
    { callId: 'call-a', tool: 'write', args: { label: '⚓' } },
    { callId: 'call-b', tool: 'send', args: { n: 2 } },
  ]);
});

test('incomplete or invalid UTF-8 streams fail closed as unknown', () => {
  assert.deepEqual(classifyProviderResponse(exchange('chat-completions', 'data: {"choices":[]}\n\n')), { kind: 'unknown' });
  assert.deepEqual(classifyProviderResponse(exchange('responses', Uint8Array.from([0xc3, 0x28]))), { kind: 'unknown' });
});
