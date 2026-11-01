import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { branchNameFor, worktreeDirNameFor } from '../core/naming.js';
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

  /**
   * Creates (or resumes) the isolated worktree for a ticket. Idempotent so a crashed run can be
   * resumed: an already registered worktree is returned as-is, and an existing branch whose worktree
   * directory is gone is re-attached instead of failing on `-b`.
   */
  async createWorktree(featureName: string, taskId: string): Promise<GitWorktreeInfo> {
    const branchName = branchNameFor(featureName, taskId);
    const worktreePath = join(this.baseDir, featureName, worktreeDirNameFor(taskId));

    const parentDir = dirname(worktreePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    const normalize = (p: string) => resolve(p).replace(/\\/g, '/').toLowerCase();
    const registered = (await this.listWorktrees()).some((w) => normalize(w.path) === normalize(worktreePath));
    if (registered && existsSync(worktreePath)) {
      return { worktreePath, branchName };
    }

    // Drop registrations whose directory disappeared (crash, manual deletion).
    await execFileAsync('git', ['worktree', 'prune'], { cwd: this.repoRoot }).catch(() => {});

    const branchExists = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: this.repoRoot,
    })
      .then(() => true)
      .catch(() => false);

    const args = branchExists
      ? ['worktree', 'add', worktreePath, branchName]
      : ['worktree', 'add', '-b', branchName, worktreePath];
    await execFileAsync('git', args, { cwd: this.repoRoot });

    return {
      worktreePath,
      branchName,
    };
  }

  /**
   * Removes a worktree. When `branchName` is given the branch is deleted too, but only if it is fully
   * merged (`git branch -d`) unless `force` is set; an unmerged branch is kept and reported.
   */
  async removeWorktree(worktreePath: string, force = false, branchName?: string): Promise<{ branchDeleted: boolean }> {
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

    if (!branchName) return { branchDeleted: false };
    const branchDeleted = await execFileAsync('git', ['branch', force ? '-D' : '-d', branchName], {
      cwd: this.repoRoot,
    })
      .then(() => true)
      .catch(() => false);
    return { branchDeleted };
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

