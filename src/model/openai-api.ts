export type OpenAiApiKind = 'chat-completions' | 'responses';

export interface OpenAiRequest {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
  input?: unknown;
  [key: string]: unknown;
}

export function apiKindForPath(path: string): OpenAiApiKind | null {
  const pathname = new URL(path, 'http://vectra.invalid').pathname;
  if (pathname === '/v1/chat/completions') return 'chat-completions';
  if (pathname === '/v1/responses') return 'responses';
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const value = part as Record<string, unknown>;
    return typeof value.text === 'string' ? value.text : '';
  }).filter(Boolean).join('\n');
}

export function extractTaskDescription(kind: OpenAiApiKind, body: OpenAiRequest): string {
  if (kind === 'chat-completions') {
    const messages = body.messages ?? [];
    const user = [...messages].reverse().find((message) => message.role === 'user');
    return textFromContent(user?.content);
  }

  if (typeof body.input === 'string') return body.input;
  if (!Array.isArray(body.input)) return '';
  const items = body.input as Array<Record<string, unknown>>;
  const user = [...items].reverse().find((item) => item.role === 'user');
  return textFromContent(user?.content);
}
