import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export interface GitWorktreeInfo {
  worktreePath: string;
  branchName: string;
}

export class GitWorktreeManager {
  private baseDir: string;

  constructor(
    private repoRoot: string,
    worktreesBaseDir?: string
  ) {
    this.baseDir = worktreesBaseDir ?? join(repoRoot, '.kiro', 'worktrees');
  }

  async createWorktree(featureName: string, taskId: string): Promise<GitWorktreeInfo> {
    const sanitizedTaskId = taskId.replace(/[^a-zA-Z0-9_\-]/g, '-');
    const branchName = `sdd/${featureName}/task-${sanitizedTaskId}`;
    const worktreePath = join(this.baseDir, featureName, `task-${sanitizedTaskId}`);

    const parentDir = dirname(worktreePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Execute git worktree add
    await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath], {
      cwd: this.repoRoot,
    });

    return {
      worktreePath,
      branchName,
    };
  }

  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    const args = ['worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push(worktreePath);

    try {
      await execFileAsync('git', args, { cwd: this.repoRoot });
    } catch (err) {
      // If directory is already removed or locked, try prune
      await execFileAsync('git', ['worktree', 'prune'], { cwd: this.repoRoot }).catch(() => {});
      throw err;
    }

    await execFileAsync('git', ['worktree', 'prune'], { cwd: this.repoRoot }).catch(() => {});
  }

  async listWorktrees(): Promise<Array<{ path: string; head: string; branch: string }>> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: this.repoRoot,
    });

    const entries = stdout.split('\n\n').filter((e) => e.trim().length > 0);
    const result: Array<{ path: string; head: string; branch: string }> = [];

    for (const entry of entries) {
      const lines = entry.split('\n');
      let path = '';
      let head = '';
      let branch = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) path = line.replace('worktree ', '').trim();
        if (line.startsWith('HEAD ')) head = line.replace('HEAD ', '').trim();
        if (line.startsWith('branch ')) branch = line.replace('branch ', '').trim();
      }

      if (path) {
        result.push({ path, head, branch });
      }
    }

    return result;
  }
}

