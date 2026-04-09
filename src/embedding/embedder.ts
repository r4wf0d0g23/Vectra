/**
 * Vectra Embedding Client
 *
 * Wraps an OpenAI-compatible /v1/embeddings endpoint.
 * Default target: DGX nemotron-embed at http://100.78.161.126:8004/v1.
 */

export class Embedder {
  private baseUrl: string;
  private cachedModelId: string | null = null;

  constructor(baseUrl: string = 'http://100.78.161.126:8004/v1') {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Discover the model ID from the /models endpoint.
   * Caches the result after first call.
   */
  async getModelId(): Promise<string> {
    if (this.cachedModelId) return this.cachedModelId;

    const resp = await fetch(`${this.baseUrl}/models`);
    if (!resp.ok) {
      throw new Error(
        `Failed to list models: ${resp.status} ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as {
      data: Array<{ id: string }>;
    };

    if (!data.data || data.data.length === 0) {
      throw new Error('No models available at the embedding endpoint');
    }

    this.cachedModelId = data.data[0].id;
    return this.cachedModelId;
  }

  /**
   * Embed an array of texts. Returns one embedding vector per input text.
   * Batches all texts in a single API call.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const modelId = await this.getModelId();

    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        input: texts,
        encoding_format: 'float',
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `Embedding request failed: ${resp.status} ${resp.statusText}\n${body}`,
      );
    }

    const result = (await resp.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    };

    // Sort by index to guarantee order matches input order
    const sorted = result.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  /**
   * Embed a single text. Convenience wrapper.
   */
  async embedOne(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }
}
