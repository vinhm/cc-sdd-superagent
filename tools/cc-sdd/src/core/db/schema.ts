import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
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

/** Grace period for a lock file whose content cannot be parsed yet (e.g. mid-write by a live process). */
const UNPARSEABLE_LOCK_GRACE_MS = 5_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

function isLockStale(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').split('\n')[0] ?? '', 10);
    if (Number.isInteger(pid) && pid > 0) {
      return !isProcessAlive(pid);
    }
    return Date.now() - statSync(lockPath).mtimeMs > UNPARSEABLE_LOCK_GRACE_MS;
  } catch {
    // The lock vanished between the EEXIST and the read: let the caller retry creation.
    return true;
  }
}

export function acquireStateLock(stateDir: string): StateLock {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  const lockPath = join(stateDir, '.lock');
  let fd: number;

  const tryCreate = (): number => {
    const handle = openSync(lockPath, 'wx');
    writeFileSync(handle, `${process.pid}\n${new Date().toISOString()}\n`);
    return handle;
  };

  try {
    fd = tryCreate();
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;

    // A lock left behind by a crashed process must not block crash recovery.
    if (!isLockStale(lockPath)) {
      throw new StateLockError(`State directory is locked by another process: ${lockPath}`);
    }
    try {
      unlinkSync(lockPath);
      fd = tryCreate();
    } catch (retryErr: any) {
      if (retryErr.code === 'EEXIST' || retryErr.code === 'ENOENT' || retryErr.code === 'EPERM') {
        throw new StateLockError(`State directory is locked by another process: ${lockPath}`);
      }
      throw retryErr;
    }
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

/**
 * `context_chunks` is a derived index of the spec documents. Stable IDs are unique per `scope`
 * (document or feature), not globally. Databases created before `scope` existed are rebuilt:
 * the index can always be regenerated from the markdown sources.
 */
function migrateContextChunks(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(context_chunks)').all() as unknown as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((c) => c.name === 'scope')) {
    db.exec('DROP TABLE context_chunks;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_chunks (
      id TEXT PRIMARY KEY,
      stable_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      content TEXT NOT NULL,
      char_length INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope, stable_id)
    );
  `);
}

/** Adds the claim `status` column to `inbox_dedup` for databases created before it existed. */
function migrateInboxDedup(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(inbox_dedup)').all() as unknown as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'status')) {
    db.exec("ALTER TABLE inbox_dedup ADD COLUMN status TEXT NOT NULL DEFAULT 'DONE';");
  }
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

    CREATE TABLE IF NOT EXISTS eval_queue (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS executor_inbox (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      ticket_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      UNIQUE(event_id, executor_id)
    );
  `);

  migrateContextChunks(db);
  migrateInboxDedup(db);

  return db;
}

