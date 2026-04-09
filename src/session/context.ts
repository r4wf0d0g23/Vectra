/**
 * Vectra Context Window Manager
 *
 * Manages the context window for model calls. Builds message arrays
 * that respect token budgets, triggers compaction when the session
 * history grows too large, and handles summarization of old messages.
 */

import type { SessionStore, Message } from './store.js';
import type { ModelClient } from '../model/client.js';

export class ContextWindowManager {
  constructor(
    private store: SessionStore,
    private softThresholdTokens: number = 80_000,
    private hardLimitTokens: number = 120_000
  ) {}

  /**
   * Build a message array for a model call that respects the token budget.
   *
   * Strategy:
   * 1. Always include the system prompt
   * 2. Load session history (newest messages first for budget trimming)
   * 3. Fill from most recent backward until we'd exceed the hard limit
   * 4. The new user message is always included
   *
   * Returns messages in chronological order (system, history..., new user message).
   */
  buildContext(
    sessionId: string,
    systemPrompt: string,
    newUserMessage: string
  ): Array<{ role: string; content: string }> {
    const systemTokens = this.estimateTokens(systemPrompt);
    const newMsgTokens = this.estimateTokens(newUserMessage);
    const reservedTokens = systemTokens + newMsgTokens;

    // Budget available for history
    let budgetRemaining = this.hardLimitTokens - reservedTokens;
    if (budgetRemaining < 0) budgetRemaining = 0;

    // Load all history (chronological order)
    const history = this.store.getHistory(sessionId);

    // Walk backward from newest to oldest, accumulating within budget
    const included: Array<{ role: string; content: string }> = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const tokens = msg.tokenCount ?? this.estimateTokens(msg.content);
      if (tokens > budgetRemaining) break;
      budgetRemaining -= tokens;
      included.unshift({ role: msg.role, content: msg.content });
    }

    // Assemble final context: system + history + new user message
    const result: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...included,
      { role: 'user', content: newUserMessage },
    ];

    return result;
  }

  /**
   * Check if a session needs compaction based on the soft threshold.
   */
  needsCompaction(sessionId: string): boolean {
    const tokenCount = this.store.getTokenCount(sessionId);
    if (tokenCount > 0) return tokenCount >= this.softThresholdTokens;

    // If no token counts stored, estimate from message content
    const history = this.store.getHistory(sessionId);
    const estimated = history.reduce(
      (sum, msg) => sum + this.estimateTokens(msg.content),
      0
    );
    return estimated >= this.softThresholdTokens;
  }

  /**
   * Perform compaction on a session:
   * 1. Load full history
   * 2. Keep the last `keepLast` messages (default 20)
   * 3. Summarize the older messages using the model
   * 4. Replace old messages with a single system summary message
   */
  async compact(
    sessionId: string,
    modelClient: ModelClient,
    keepLast: number = 20
  ): Promise<void> {
    const history = this.store.getHistory(sessionId);

    // Nothing to compact if history is small enough
    if (history.length <= keepLast) return;

    // Split: messages to summarize vs. messages to keep
    const toSummarize = history.slice(0, history.length - keepLast);

    // Build summarization prompt
    const summaryPrompt = this.buildSummaryPrompt(toSummarize);

    // Call model for summary — use the client's default model
    const response = await modelClient.complete(
      modelClient.defaultModel,
      [
        {
          role: 'system',
          content:
            'You are a conversation summarizer. Produce a concise summary of the conversation below, preserving key facts, decisions, user preferences, and any commitments made. Be factual and compact.',
        },
        { role: 'user', content: summaryPrompt },
      ],
      { maxTokens: 2000, temperature: 0.3 }
    );

    // Create summary message
    const summaryMessage: Message = {
      id: crypto.randomUUID(),
      sessionId,
      role: 'system',
      content: `[Session Summary — compacted ${toSummarize.length} messages]\n\n${response.content}`,
      timestamp: new Date(),
      tokenCount: this.estimateTokens(response.content),
      metadata: {
        type: 'compaction-summary',
        messagesCompacted: toSummarize.length,
        compactedAt: new Date().toISOString(),
      },
    };

    // Execute compaction in the store
    this.store.compact(sessionId, keepLast, summaryMessage);
  }

  /**
   * Estimate token count for a string.
   * Rough heuristic: ~4 characters per token for English text.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  private buildSummaryPrompt(messages: Message[]): string {
    const lines = messages.map(
      (m) => `[${m.role}] ${m.content}`
    );
    return `Summarize the following conversation:\n\n${lines.join('\n\n')}`;
  }
}
