import {
  apiKindForPath as openAiApiKindForPath,
  extractTaskDescription as extractOpenAiTask,
  type OpenAiApiKind,
  type OpenAiRequest,
} from './openai-api.js';

export type ProviderApiKind = OpenAiApiKind | 'anthropic-messages';

export interface AnthropicMessageRequest {
  model?: string;
  stream?: boolean;
  system?: unknown;
  messages?: Array<{ role?: string; content?: unknown }>;
  [key: string]: unknown;
}

export type ProviderRequest = OpenAiRequest | AnthropicMessageRequest;

export interface ProviderDialect<TRequest extends ProviderRequest = ProviderRequest> {
  readonly id: 'openai' | 'anthropic';
  match(path: string): ProviderApiKind | null;
  extractTask(api: ProviderApiKind, request: TRequest): string;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const record = part as Record<string, unknown>;
    return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
  }).filter(Boolean).join('\n');
}

export const openAiDialect: ProviderDialect<OpenAiRequest> = {
  id: 'openai',
  match: openAiApiKindForPath,
  extractTask(api, request) {
    if (api === 'anthropic-messages') return '';
    return extractOpenAiTask(api, request);
  },
};

export const anthropicDialect: ProviderDialect<AnthropicMessageRequest> = {
  id: 'anthropic',
  match(path) {
    return new URL(path, 'http://vectra.invalid').pathname === '/v1/messages'
      ? 'anthropic-messages'
      : null;
  },
  extractTask(_api, request) {
    const messages = request.messages ?? [];
    const user = [...messages].reverse().find((message) => message.role === 'user');
    return textFromContent(user?.content);
  },
};

export interface MatchedProviderRoute {
  api: ProviderApiKind;
  dialect: ProviderDialect;
}

/** Ordered registry keeps route ownership explicit and future dialects pluggable. */
export class ProviderDialectRegistry {
  constructor(private readonly dialects: readonly ProviderDialect[] = [openAiDialect, anthropicDialect]) {}

  match(path: string): MatchedProviderRoute | null {
    for (const dialect of this.dialects) {
      const api = dialect.match(path);
      if (api) return { api, dialect };
    }
    return null;
  }
}
