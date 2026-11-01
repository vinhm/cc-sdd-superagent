import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class StateLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateLockError';
  }
}

export interface StateLock {
  release(): void;
}

export function acquireStateLock(stateDir: string): StateLock {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const lockPath = join(stateDir, '.lock');
  let fd: number;

  try {
    fd = openSync(lockPath, 'wx');
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      throw new StateLockError(`State directory is locked by another process: ${lockPath}`);
    }
    throw err;
  }

  let released = false;

  return {
    release() {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        if (existsSync(lockPath)) {
          unlinkSync(lockPath);
        }
      } catch {
        // ignore
      }
    },
  };
}

export function initHarnessDatabase(dbPath: string): DatabaseSync {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for concurrency
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      thread_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      task_id TEXT NOT NULL,
      feature_name TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      current_phase TEXT DEFAULT 'RED',
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(thread_id) REFERENCES threads(id)
    );

    CREATE TABLE IF NOT EXISTS mandates (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      allowed_files TEXT NOT NULL,
      forbidden_files TEXT,
      allowed_commands TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(ticket_id) REFERENCES tickets(id)
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      FOREIGN KEY(ticket_id) REFERENCES tickets(id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(ticket_id) REFERENCES tickets(id)
    );

    CREATE TABLE IF NOT EXISTS effects_queue (
      id TEXT PRIMARY KEY,
      ticket_id TEXT,
      effect_type TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(ticket_id) REFERENCES tickets(id)
    );

    CREATE TABLE IF NOT EXISTS inbox_dedup (
      message_id TEXT PRIMARY KEY,
      handler TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outbox_receipts (
      id TEXT PRIMARY KEY,
      ticket_id TEXT,
      channel TEXT NOT NULL,
      message_id TEXT,
      idempotency_key TEXT UNIQUE,
      html_marker TEXT,
      status TEXT NOT NULL DEFAULT 'SENT',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(ticket_id) REFERENCES tickets(id)
    );

    CREATE TABLE IF NOT EXISTS context_chunks (
      id TEXT PRIMARY KEY,
      stable_id TEXT NOT NULL UNIQUE,
      source_file TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      content TEXT NOT NULL,
      char_length INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

