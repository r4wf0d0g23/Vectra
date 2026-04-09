/**
 * Vectra Model Client — multi-provider OpenAI-compatible API client
 *
 * Supports Anthropic, OpenAI, xAI (Grok), vLLM (self-hosted), and OpenRouter.
 * Provider is detected from the model string prefix (e.g. "anthropic/claude-...").
 * API keys come from environment variables — never from instance config.
 * vLLM endpoint URL goes in instance config (not an env var — not a secret).
 */

import OpenAI from 'openai';

// ─── Types ──────────────────────────────────────────────────────────

export interface ModelResponse {
  content: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
  model: string;
  finishReason: string;
}

/** Per-provider configuration override. Keys are provider IDs. */
export interface ProviderConfig {
  /** Override default base URL (required for vLLM). */
  baseUrl?: string;
  /** Direct API key (not recommended — use envVar instead). */
  apiKey?: string;
  /** Env var name to read API key from (overrides built-in default). */
  envVar?: string;
}

/**
 * @deprecated Use ProviderConfig + multi-provider ModelClient instead.
 * Kept for backward compatibility with external consumers.
 */
export interface ModelClientConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

// ─── Provider Registry ───────────────────────────────────────────────

interface BuiltinProvider {
  baseUrl: string;
  envVar: string;
  label: string;
  models: string[];
}

const PROVIDER_CONFIG: Record<string, BuiltinProvider> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic (Claude)',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    label: 'OpenAI',
    models: ['gpt-5.4-mini', 'gpt-4o', 'gpt-4-turbo'],
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    envVar: 'XAI_API_KEY',
    label: 'xAI (Grok)',
    models: ['grok-4-1-fast', 'grok-3'],
  },
  vllm: {
    baseUrl: '', // set by user — e.g. http://localhost:8001/v1 or http://100.78.161.126:8001/v1
    envVar: 'VLLM_API_KEY', // optional — vLLM can run without auth
    label: 'vLLM (self-hosted)',
    models: [], // user defines their own model names
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    models: [], // pass-through — any model string
  },
};

// ─── Provider Detection ─────────────────────────────────────────────

/**
 * Detect provider from a model string.
 * "anthropic/claude-sonnet-4-6" → "anthropic"
 * Falls back to pattern matching for bare model names.
 */
function detectProvider(model: string): string {
  if (model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('openai/')) return 'openai';
  if (model.startsWith('xai/')) return 'xai';
  if (model.startsWith('vllm/')) return 'vllm';
  if (model.startsWith('openrouter/')) return 'openrouter';
  // Fallback: pattern matching for bare model names
  if (model.includes('claude')) return 'anthropic';
  if (model.includes('gpt')) return 'openai';
  if (model.includes('grok')) return 'xai';
  return 'openai';
}

// ─── Client ─────────────────────────────────────────────────────────

export class ModelClient {
  /** Default model used when no model string is specified by the caller. */
  readonly defaultModel: string;

  constructor(
    private readonly providers: Record<string, ProviderConfig> = {},
    defaultModel: string = 'anthropic/claude-sonnet-4-6',
  ) {
    this.defaultModel = defaultModel;
  }

  /**
   * Get an OpenAI-compatible client and resolved model name for a given model string.
   */
  private getClient(model: string): { client: OpenAI; resolvedModel: string } {
    const providerKey = detectProvider(model);
    const providerDefault = PROVIDER_CONFIG[providerKey];
    const providerOverride = this.providers[providerKey] ?? {};

    const baseURL =
      providerOverride.baseUrl ?? providerDefault?.baseUrl ?? 'https://api.openai.com/v1';
    const envVar =
      providerOverride.envVar ?? providerDefault?.envVar ?? 'OPENAI_API_KEY';
    const apiKey =
      providerOverride.apiKey ?? process.env[envVar] ?? 'no-key'; // vLLM may not need a key

    // Strip provider prefix from model name for the actual API call
    const resolvedModel =
      model.includes('/') ? model.split('/').slice(1).join('/') : model;

    return {
      client: new OpenAI({ apiKey, baseURL }),
      resolvedModel,
    };
  }

  /**
   * Send a completion request and return the full response.
   *
   * @param model  Full model string, e.g. "anthropic/claude-sonnet-4-6" or "xai/grok-4-1-fast".
   *               Use `this.defaultModel` when no preference.
   */
  async complete(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    },
  ): Promise<ModelResponse> {
    const { client, resolvedModel } = this.getClient(model);

    const allMessages: Array<OpenAI.ChatCompletionMessageParam> = [];
    if (options?.systemPrompt) {
      allMessages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const msg of messages) {
      allMessages.push({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      });
    }

    const response = await client.chat.completions.create({
      model: resolvedModel,
      messages: allMessages,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
    });

    const choice = response.choices[0];
    const usage = response.usage;

    return {
      content: choice?.message?.content ?? '',
      tokenUsage: {
        prompt: usage?.prompt_tokens ?? 0,
        completion: usage?.completion_tokens ?? 0,
        total: usage?.total_tokens ?? 0,
      },
      model: response.model,
      finishReason: choice?.finish_reason ?? 'unknown',
    };
  }

  /**
   * Stream a completion, calling onChunk for each content delta.
   * Returns the full accumulated response when done.
   *
   * @param model  Full model string, e.g. "anthropic/claude-sonnet-4-6".
   */
  async stream(
    model: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
  ): Promise<ModelResponse> {
    const { client, resolvedModel } = this.getClient(model);

    const allMessages: Array<OpenAI.ChatCompletionMessageParam> = messages.map(
      (msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      }),
    );

    const stream = await client.chat.completions.create({
      model: resolvedModel,
      messages: allMessages,
      stream: true,
    });

    let content = '';
    let finishReason = 'unknown';
    let modelName = resolvedModel;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        content += delta;
        onChunk(delta);
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      if (chunk.model) {
        modelName = chunk.model;
      }
    }

    // Token usage isn't available per-chunk in streaming; estimate from content length
    return {
      content,
      tokenUsage: {
        prompt: 0,
        completion: Math.ceil(content.length / 4),
        total: Math.ceil(content.length / 4),
      },
      model: modelName,
      finishReason,
    };
  }
}
