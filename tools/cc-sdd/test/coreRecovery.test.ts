import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { RecoveryEngine, syncStateToTasksMarkdown } from '../src/core/recovery.js';

describe('BND-STATE-ENGINE: 3-Step Crash Recovery & Tasks.md Projection', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-recovery-test-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));

    db.prepare("INSERT INTO threads (id, title) VALUES ('th-rec', 'Recovery Feature')").run();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('recovers ticket after crash in GREEN phase to continue PR creation without re-running RED', async () => {
    // Ticket interrupted after passing GREEN tests and committing code, but before PR creation
    db.prepare(`
      INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status, current_phase)
      VALUES ('tk-green', 'th-rec', '1.3', 'my-feat', 'Task 1.3', 'IN_PROGRESS', 'GREEN')
    `).run();

    db.prepare(`
      INSERT INTO assignments (id, ticket_id, executor_id, worktree_path, status)
      VALUES ('asg-1', 'tk-green', 'worker-1.3', '/worktree/my-feat/task-1.3', 'ACTIVE')
    `).run();

    const mockGit = {
      getWorktreeStatus: async (_path: string) => ({
        hasUncommittedChanges: false,
        lastCommitMessage: 'feat(core): complete Task 1.3 implementation',
        commitsAhead: 1,
      }),
      getRemotePrStatus: async (_branch: string) => ({
        exists: false,
      }),
    };

    const recovery = new RecoveryEngine(db, mockGit);
    const decision = await recovery.recoverTicket('tk-green');

    expect(decision.nextAction).toBe('CREATE_PR');
    expect(decision.skipRedPhase).toBe(true);
    expect(decision.worktreePath).toBe('/worktree/my-feat/task-1.3');
  });

  it('projects completed SQLite tickets back to tasks.md checkboxes', async () => {
    // Create mock tasks.md
    const tasksMdPath = join(tempDir, 'tasks.md');
    const initialTasksMd = `
### 1. Group 1
* [ ] **1.1** Task 1.1 description
* [ ] **1.2 (P)** Task 1.2 description
* [ ] **1.3** Task 1.3 description
`;
    await writeFile(tasksMdPath, initialTasksMd, 'utf8');

    // Mark 1.1 and 1.2 completed in SQLite
    db.prepare(`
      INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status)
      VALUES 
        ('tk-1', 'th-rec', '1.1', 'my-feat', 'Task 1.1', 'COMPLETED'),
        ('tk-2', 'th-rec', '1.2', 'my-feat', 'Task 1.2', 'COMPLETED'),
        ('tk-3', 'th-rec', '1.3', 'my-feat', 'Task 1.3', 'IN_PROGRESS')
    `).run();

    const { updatedCount } = await syncStateToTasksMarkdown(db, tasksMdPath);
    expect(updatedCount).toBe(2);

    const updatedTasksMd = await readFile(tasksMdPath, 'utf8');
    expect(updatedTasksMd).toContain('* [x] **1.1** Task 1.1 description');
    expect(updatedTasksMd).toContain('* [x] **1.2 (P)** Task 1.2 description');
    expect(updatedTasksMd).toContain('* [ ] **1.3** Task 1.3 description');
  });
});
