/**
 * Vectra Model Client — OpenAI-compatible API client
 *
 * Works with any OpenAI-compatible endpoint: OpenAI, Anthropic (via proxy),
 * xAI, vLLM, and other compatible providers.
 *
 * API keys MUST come from environment variables — never from instance config.
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

export interface ModelClientConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

// ─── Client ─────────────────────────────────────────────────────────

export class ModelClient {
  private client: OpenAI;
  private model: string;

  constructor(private config: ModelClientConfig) {
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? this.inferBaseUrl(config.provider),
    });
  }

  /**
   * Send a completion request and return the full response.
   */
  async complete(
    messages: Array<{ role: string; content: string }>,
    options?: {
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
    }
  ): Promise<ModelResponse> {
    // If a separate systemPrompt is provided, prepend it
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

    const response = await this.client.chat.completions.create({
      model: this.model,
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
   */
  async stream(
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<ModelResponse> {
    const allMessages: Array<OpenAI.ChatCompletionMessageParam> = messages.map(
      (msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      })
    );

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: allMessages,
      stream: true,
    });

    let content = '';
    let finishReason = 'unknown';
    let model = this.model;

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
        model = chunk.model;
      }
    }

    // Token usage isn't available per-chunk in streaming; estimate
    return {
      content,
      tokenUsage: {
        prompt: 0,
        completion: Math.ceil(content.length / 4),
        total: Math.ceil(content.length / 4),
      },
      model,
      finishReason,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  private inferBaseUrl(provider: string): string {
    switch (provider.toLowerCase()) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'anthropic':
        return 'https://api.anthropic.com/v1';
      case 'xai':
        return 'https://api.x.ai/v1';
      default:
        return 'https://api.openai.com/v1';
    }
  }
}
