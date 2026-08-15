import type { ModelExchange } from './response-release.js';

export interface ToolCall { callId: string; tool: string; args: unknown }
export type Phase =
  | { kind: 'intermediate'; calls: ToolCall[] }
  | { kind: 'terminal' }
  | { kind: 'unknown' };

interface SseEvent { event?: string; data: string }

function parseSse(bytes: Uint8Array): SseEvent[] | null {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
  const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/);
  const events: SseEvent[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return events;
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  return JSON.parse(value || '{}') as unknown;
}

interface PartialCall { callId?: string; tool?: string; arguments: string; input?: unknown }

abstract class StatefulSseToolCallAssembler {
  protected readonly calls = new Map<string, PartialCall>();
  protected completed = false;
  protected invalid = false;
  abstract consume(event: SseEvent): void;

  result(): Phase {
    if (this.invalid || !this.completed) return { kind: 'unknown' };
    if (this.calls.size === 0) return { kind: 'terminal' };
    const output: ToolCall[] = [];
    try {
      for (const call of this.calls.values()) {
        if (!call.callId || !call.tool) return { kind: 'unknown' };
        output.push({ callId: call.callId, tool: call.tool, args: call.input ?? parseArgs(call.arguments) });
      }
    } catch { return { kind: 'unknown' }; }
    return { kind: 'intermediate', calls: output };
  }

  protected json(event: SseEvent): Record<string, any> | null {
    if (event.data === '[DONE]') { this.completed = true; return null; }
    try { return JSON.parse(event.data) as Record<string, any>; }
    catch { this.invalid = true; return null; }
  }
}

export class ChatSseToolCallAssembler extends StatefulSseToolCallAssembler {
  consume(event: SseEvent): void {
    const value = this.json(event); if (!value) return;
    for (const choice of value.choices ?? []) {
      if (choice.finish_reason != null) this.completed = true;
      for (const delta of choice.delta?.tool_calls ?? []) {
        const key = String(delta.index ?? delta.id ?? '0');
        const call = this.calls.get(key) ?? { arguments: '' };
        if (delta.id) call.callId = delta.id;
        if (delta.function?.name) call.tool = delta.function.name;
        if (typeof delta.function?.arguments === 'string') call.arguments += delta.function.arguments;
        this.calls.set(key, call);
      }
    }
  }
}

export class ResponsesSseToolCallAssembler extends StatefulSseToolCallAssembler {
  private readonly outputIndex = new Map<string, string>();

  consume(event: SseEvent): void {
    const value = this.json(event); if (!value) return;
    const type = value.type ?? event.event;
    if (type === 'response.completed') this.completed = true;
    if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') this.invalid = true;
    const item = value.item;
    if ((type === 'response.output_item.added' || type === 'response.output_item.done') && item?.type === 'function_call') {
      const key = String(item.id ?? item.call_id ?? value.output_index);
      const call = this.calls.get(key) ?? { arguments: '' };
      call.callId = item.call_id ?? item.id ?? call.callId;
      call.tool = item.name ?? call.tool;
      // A done item contains the authoritative full value; do not append it to
      // deltas or duplicate terminal events will corrupt otherwise-valid JSON.
      if (type === 'response.output_item.done' && typeof item.arguments === 'string') call.arguments = item.arguments;
      else if (typeof item.arguments === 'string' && !call.arguments) call.arguments = item.arguments;
      this.calls.set(key, call);
      if (value.output_index !== undefined) this.outputIndex.set(String(value.output_index), key);
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = String(value.item_id ?? this.outputIndex.get(String(value.output_index)) ?? value.output_index);
      const call = this.calls.get(key) ?? { arguments: '' };
      call.arguments += String(value.delta ?? ''); this.calls.set(key, call);
    }
    if (type === 'response.function_call_arguments.done') {
      const key = String(value.item_id ?? this.outputIndex.get(String(value.output_index)) ?? value.output_index);
      const call = this.calls.get(key) ?? { arguments: '' };
      if (typeof value.arguments === 'string') call.arguments = value.arguments;
      this.calls.set(key, call);
    }
  }
}

export class AnthropicSseToolCallAssembler extends StatefulSseToolCallAssembler {
  consume(event: SseEvent): void {
    const value = this.json(event); if (!value) return;
    const type = value.type ?? event.event;
    if (type === 'message_stop') this.completed = true;
    if (type === 'error') this.invalid = true;
    if (type === 'content_block_start' && value.content_block?.type === 'tool_use') {
      const key = String(value.index ?? value.content_block.id);
      const existing = this.calls.get(key);
      this.calls.set(key, {
        callId: value.content_block.id ?? existing?.callId,
        tool: value.content_block.name ?? existing?.tool,
        arguments: existing?.arguments ?? '',
        input: value.content_block.input && Object.keys(value.content_block.input).length > 0
          ? value.content_block.input : existing?.input,
      });
    }
    if (type === 'content_block_delta' && value.delta?.type === 'input_json_delta') {
      const key = String(value.index);
      const call = this.calls.get(key) ?? { arguments: '' };
      call.arguments += String(value.delta.partial_json ?? ''); this.calls.set(key, call);
    }
  }
}

function classifySse(exchange: ModelExchange): Phase {
  const events = parseSse(exchange.responseBody);
  if (!events) return { kind: 'unknown' };
  const assembler = exchange.api === 'chat-completions'
    ? new ChatSseToolCallAssembler()
    : exchange.api === 'responses'
      ? new ResponsesSseToolCallAssembler()
      : new AnthropicSseToolCallAssembler();
  for (const event of events) assembler.consume(event);
  return assembler.result();
}

function classifyJson(exchange: ModelExchange): Phase {
  let value: any;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(exchange.responseBody)); }
  catch { return { kind: 'unknown' }; }
  const calls: ToolCall[] = [];
  try {
    if (exchange.api === 'chat-completions') {
      for (const choice of value.choices ?? []) for (const call of choice.message?.tool_calls ?? []) {
        calls.push({ callId: call.id, tool: call.function.name, args: parseArgs(call.function.arguments) });
      }
    } else if (exchange.api === 'responses') {
      for (const call of [...(value.output ?? []), ...(value.response?.output ?? [])]) if (call.type === 'function_call') {
        calls.push({ callId: call.call_id ?? call.id, tool: call.name, args: parseArgs(call.arguments) });
      }
    } else {
      for (const call of [...(value.content ?? []), ...(value.message?.content ?? [])]) if (call.type === 'tool_use') {
        calls.push({ callId: call.id, tool: call.name, args: call.input ?? {} });
      }
    }
  } catch { return { kind: 'unknown' }; }
  if (!calls.length) return { kind: 'terminal' };
  if (calls.some((call) => !call.callId || !call.tool)) return { kind: 'unknown' };
  return { kind: 'intermediate', calls: [...new Map(calls.map((call) => [call.callId, call])).values()] };
}

export function classifyProviderResponse(exchange: ModelExchange): Phase {
  return (exchange.upstreamHeaders.get('content-type') ?? '').includes('event-stream')
    ? classifySse(exchange)
    : classifyJson(exchange);
}
