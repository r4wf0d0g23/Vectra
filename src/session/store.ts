/**
 * Vectra Session Store — SQLite-backed persistence for conversation sessions.
 *
 * Each session maps to a unique channelId:senderId pair within an instance.
 * Messages are stored chronologically and support compaction (summarization
 * of old messages while preserving recent context).
 *
 * Database path defaults to ~/.vectra/{instanceId}/sessions.db but is
 * fully configurable via constructor parameter.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface Session {
  id: string;            // channelId:senderId
  instanceId: string;
  createdAt: Date;
  updatedAt: Date;
  totalTokens: number;
  compactionCount: number;
  soulHash?: string;
  metadata?: Record<string, unknown>;
}

// ─── Store ──────────────────────────────────────────────────────────

export class SessionStore {
  private db: Database.Database;

  // Prepared statements (lazy-initialized)
  private stmtGetSession!: Database.Statement;
  private stmtInsertSession!: Database.Statement;
  private stmtUpdateSession!: Database.Statement;
  private stmtAppendMessage!: Database.Statement;
  private stmtGetHistory!: Database.Statement;
  private stmtGetHistoryAll!: Database.Statement;
  private stmtGetTokenCount!: Database.Statement;
  private stmtDeleteOldMessages!: Database.Statement;
  private stmtCountDeletedSessions!: Database.Statement;
  private stmtDeleteOldSessions!: Database.Statement;
  private stmtGetSoulHash!: Database.Statement;
  private stmtUpdateSoulHash!: Database.Statement;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
    this.migrateSchema();
    this.prepareStatements();
  }

  // ─── Schema ───────────────────────────────────────────────────────

  private migrateSchema(): void {
    // Add soul_hash column to existing databases that predate this field
    try {
      this.db.exec('ALTER TABLE sessions ADD COLUMN soul_hash TEXT');
    } catch {
      // Column already exists — safe to ignore
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        soul_hash TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        token_count INTEGER,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_ts
        ON messages(session_id, timestamp ASC);

      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at);
    `);
  }

  private prepareStatements(): void {
    this.stmtGetSession = this.db.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    );

    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions (id, instance_id, created_at, updated_at, total_tokens, compaction_count, metadata)
      VALUES (?, ?, ?, ?, 0, 0, NULL)
    `);

    this.stmtUpdateSession = this.db.prepare(`
      UPDATE sessions SET
        updated_at = ?,
        total_tokens = ?,
        compaction_count = ?,
        metadata = ?
      WHERE id = ?
    `);

    this.stmtAppendMessage = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, token_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetHistory = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?'
    );

    this.stmtGetHistoryAll = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC'
    );

    this.stmtGetTokenCount = this.db.prepare(
      'SELECT COALESCE(SUM(token_count), 0) as total FROM messages WHERE session_id = ?'
    );

    this.stmtDeleteOldMessages = this.db.prepare(`
      DELETE FROM messages WHERE session_id = ? AND id NOT IN (
        SELECT id FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?
      )
    `);

    this.stmtCountDeletedSessions = this.db.prepare(
      'SELECT COUNT(*) as count FROM sessions WHERE updated_at < ?'
    );

    this.stmtDeleteOldSessions = this.db.prepare(
      'DELETE FROM sessions WHERE updated_at < ?'
    );

    this.stmtGetSoulHash = this.db.prepare(
      'SELECT soul_hash FROM sessions WHERE id = ?'
    );

    this.stmtUpdateSoulHash = this.db.prepare(
      'UPDATE sessions SET soul_hash = ? WHERE id = ?'
    );
  }

  // ─── Session Operations ───────────────────────────────────────────

  getOrCreate(sessionId: string, instanceId: string): Session {
    const row = this.stmtGetSession.get(sessionId) as SessionRow | undefined;
    if (row) {
      return this.rowToSession(row);
    }

    const now = new Date().toISOString();
    this.stmtInsertSession.run(sessionId, instanceId, now, now);

    return {
      id: sessionId,
      instanceId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      totalTokens: 0,
      compactionCount: 0,
    };
  }

  update(sessionId: string, updates: Partial<Session>): void {
    const existing = this.stmtGetSession.get(sessionId) as SessionRow | undefined;
    if (!existing) return;

    const now = new Date().toISOString();
    this.stmtUpdateSession.run(
      now,
      updates.totalTokens ?? existing.total_tokens,
      updates.compactionCount ?? existing.compaction_count,
      updates.metadata ? JSON.stringify(updates.metadata) : existing.metadata,
      sessionId
    );
  }

  // ─── Message Operations ───────────────────────────────────────────

  append(message: Message): void {
    this.stmtAppendMessage.run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.timestamp.toISOString(),
      message.tokenCount ?? null,
      message.metadata ? JSON.stringify(message.metadata) : null
    );

    // Update session's updatedAt
    const existing = this.stmtGetSession.get(message.sessionId) as SessionRow | undefined;
    if (existing) {
      const tokenDelta = message.tokenCount ?? 0;
      this.stmtUpdateSession.run(
        new Date().toISOString(),
        existing.total_tokens + tokenDelta,
        existing.compaction_count,
        existing.metadata,
        message.sessionId
      );
    }
  }

  getHistory(sessionId: string, limit?: number): Message[] {
    const rows = limit !== undefined
      ? this.stmtGetHistory.all(sessionId, limit) as MessageRow[]
      : this.stmtGetHistoryAll.all(sessionId) as MessageRow[];

    return rows.map(this.rowToMessage);
  }

  getTokenCount(sessionId: string): number {
    const result = this.stmtGetTokenCount.get(sessionId) as { total: number };
    return result.total;
  }

  // ─── Compaction ───────────────────────────────────────────────────

  /**
   * Compact a session's history:
   * 1. Delete all messages except the most recent `keepLast`
   * 2. Insert a summary message at the beginning
   * 3. Increment compaction count
   */
  compact(sessionId: string, keepLast: number, summaryMessage: Message): void {
    const txn = this.db.transaction(() => {
      // Delete old messages, keeping the most recent `keepLast`
      this.stmtDeleteOldMessages.run(sessionId, sessionId, keepLast);

      // Insert the summary message
      this.stmtAppendMessage.run(
        summaryMessage.id,
        summaryMessage.sessionId,
        summaryMessage.role,
        summaryMessage.content,
        summaryMessage.timestamp.toISOString(),
        summaryMessage.tokenCount ?? null,
        summaryMessage.metadata ? JSON.stringify(summaryMessage.metadata) : null
      );

      // Update session compaction count
      const existing = this.stmtGetSession.get(sessionId) as SessionRow | undefined;
      if (existing) {
        // Recalculate token count from remaining messages
        const newTokenCount = this.getTokenCount(sessionId);
        this.stmtUpdateSession.run(
          new Date().toISOString(),
          newTokenCount,
          existing.compaction_count + 1,
          existing.metadata,
          sessionId
        );
      }
    });

    txn();
  }

  // ─── Soul Hash Operations ─────────────────────────────────────────

  getSoulHash(sessionId: string): string | null {
    const row = this.stmtGetSoulHash.get(sessionId) as { soul_hash: string | null } | undefined;
    return row?.soul_hash ?? null;
  }

  updateSoulHash(sessionId: string, hash: string): void {
    this.stmtUpdateSoulHash.run(hash, sessionId);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────

  /**
   * Delete sessions (and their messages via CASCADE) older than the given number of days.
   * Returns the number of sessions deleted.
   */
  deleteOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const countResult = this.stmtCountDeletedSessions.get(cutoff) as { count: number };
    this.stmtDeleteOldSessions.run(cutoff);
    return countResult.count;
  }

  close(): void {
    this.db.close();
  }

  // ─── Row Mapping ──────────────────────────────────────────────────

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      instanceId: row.instance_id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      totalTokens: row.total_tokens,
      compactionCount: row.compaction_count,
      soulHash: row.soul_hash ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined,
    };
  }

  private rowToMessage(row: MessageRow): Message {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role as Message['role'],
      content: row.content,
      timestamp: new Date(row.timestamp),
      tokenCount: row.token_count ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined,
    };
  }
}

// ─── Internal Row Types ─────────────────────────────────────────────

interface SessionRow {
  id: string;
  instance_id: string;
  created_at: string;
  updated_at: string;
  total_tokens: number;
  compaction_count: number;
  soul_hash: string | null;
  metadata: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  token_count: number | null;
  metadata: string | null;
}

/**
 * Create the default database path for an instance.
 * ~/.vectra/{instanceId}/sessions.db
 */
export function defaultDbPath(instanceId: string): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  return `${home}/.vectra/${instanceId}/sessions.db`;
}
