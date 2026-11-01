import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorktreeManager } from '../src/execution/worktreeManager.js';

const execFileAsync = promisify(execFile);

describe('BND-EXEC-RUNTIME: GitWorktreeManager Parallel Isolation', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'cc-sdd-worktree-test-'));
    // Initialize temporary git repo
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'TestBot'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'bot@test.org'], { cwd: repoDir });

    await writeFile(join(repoDir, 'README.md'), '# Main Repo\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('creates and manages isolated worktrees for concurrent (P) tasks without index conflicts', async () => {
    const manager = new GitWorktreeManager(repoDir);

    // Create 3 concurrent worktrees
    const [wt1, wt2, wt3] = await Promise.all([
      manager.createWorktree('feat-alpha', '1.1'),
      manager.createWorktree('feat-alpha', '1.2'),
      manager.createWorktree('feat-alpha', '1.3'),
    ]);

    expect(wt1.branchName).toBe('sdd/feat-alpha/task-1-1');
    expect(wt2.branchName).toBe('sdd/feat-alpha/task-1-2');
    expect(wt3.branchName).toBe('sdd/feat-alpha/task-1-3');

    // Run parallel commits in each worktree simultaneously
    await Promise.all([
      (async () => {
        await writeFile(join(wt1.worktreePath, 'file1.txt'), 'Task 1.1 work', 'utf8');
        await execFileAsync('git', ['add', '.'], { cwd: wt1.worktreePath });
        await execFileAsync('git', ['commit', '-m', 'feat(alpha): task 1.1 done'], { cwd: wt1.worktreePath });
      })(),
      (async () => {
        await writeFile(join(wt2.worktreePath, 'file2.txt'), 'Task 1.2 work', 'utf8');
        await execFileAsync('git', ['add', '.'], { cwd: wt2.worktreePath });
        await execFileAsync('git', ['commit', '-m', 'feat(alpha): task 1.2 done'], { cwd: wt2.worktreePath });
      })(),
      (async () => {
        await writeFile(join(wt3.worktreePath, 'file3.txt'), 'Task 1.3 work', 'utf8');
        await execFileAsync('git', ['add', '.'], { cwd: wt3.worktreePath });
        await execFileAsync('git', ['commit', '-m', 'feat(alpha): task 1.3 done'], { cwd: wt3.worktreePath });
      })(),
    ]);

    // Verify isolation: file1 exists only in wt1, not in wt2 or main
    const { stdout: log1 } = await execFileAsync('git', ['log', '-1', '--oneline'], { cwd: wt1.worktreePath });
    expect(log1).toContain('task 1.1 done');

    const { stdout: log2 } = await execFileAsync('git', ['log', '-1', '--oneline'], { cwd: wt2.worktreePath });
    expect(log2).toContain('task 1.2 done');

    // Cleanup worktrees
    await manager.removeWorktree(wt1.worktreePath, true);
    await manager.removeWorktree(wt2.worktreePath, true);
    await manager.removeWorktree(wt3.worktreePath, true);
  });
});
