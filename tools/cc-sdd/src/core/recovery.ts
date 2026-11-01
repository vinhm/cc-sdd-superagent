import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';

export interface GitWorktreeStatus {
  hasUncommittedChanges: boolean;
  lastCommitMessage: string;
  commitsAhead: number;
}

export interface RemotePrStatus {
  exists: boolean;
  prNumber?: number;
  url?: string;
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
}

export interface GitProvider {
  getWorktreeStatus(worktreePath: string): Promise<GitWorktreeStatus>;
  getRemotePrStatus(branchName: string): Promise<RemotePrStatus>;
}

export interface RecoveryDecision {
  ticketId: string;
  nextAction: 'CREATE_PR' | 'RESUME_TDD' | 'CLEANUP_WORKTREE' | 'START_TASK';
  skipRedPhase: boolean;
  worktreePath?: string;
  reason: string;
}

export class RecoveryEngine {
  constructor(
    private db: DatabaseSync,
    private gitProvider: GitProvider
  ) {}

  async recoverTicket(ticketId: string): Promise<RecoveryDecision> {
    // Step 1: Query SQLite state
    const ticket = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const assignment = this.db
      .prepare("SELECT * FROM assignments WHERE ticket_id = ? AND status = 'ACTIVE' ORDER BY assigned_at DESC LIMIT 1")
      .get(ticketId) as any;

    const worktreePath = assignment?.worktree_path;
    const branchName = `sdd/${ticket.feature_name}/task-${ticket.task_id}`;

    // Step 2 & 3: Check worktree and remote PR
    let worktreeStatus: GitWorktreeStatus = { hasUncommittedChanges: false, lastCommitMessage: '', commitsAhead: 0 };
    if (worktreePath) {
      worktreeStatus = await this.gitProvider.getWorktreeStatus(worktreePath);
    }

    const prStatus = await this.gitProvider.getRemotePrStatus(branchName);

    // Decision Logic
    if (prStatus.exists && prStatus.state === 'MERGED') {
      return {
        ticketId,
        nextAction: 'CLEANUP_WORKTREE',
        skipRedPhase: true,
        worktreePath,
        reason: 'PR already merged remotely. Need to cleanup worktree and close ticket.',
      };
    }

    if (ticket.current_phase === 'GREEN' && worktreeStatus.commitsAhead > 0 && !prStatus.exists) {
      return {
        ticketId,
        nextAction: 'CREATE_PR',
        skipRedPhase: true,
        worktreePath,
        reason: 'GREEN phase completed with commits ahead, but PR not yet created.',
      };
    }

    if (worktreeStatus.hasUncommittedChanges) {
      return {
        ticketId,
        nextAction: 'RESUME_TDD',
        skipRedPhase: ticket.current_phase === 'GREEN',
        worktreePath,
        reason: 'Worktree has uncommitted changes, resume TDD implementation.',
      };
    }

    return {
      ticketId,
      nextAction: 'START_TASK',
      skipRedPhase: false,
      worktreePath,
      reason: 'Standard resumption from beginning of task.',
    };
  }
}

export async function syncStateToTasksMarkdown(
  db: DatabaseSync,
  tasksMarkdownPath: string
): Promise<{ updatedCount: number }> {
  const content = await readFile(tasksMarkdownPath, 'utf8');
  const tickets = db
    .prepare("SELECT task_id, status FROM tickets WHERE status IN ('COMPLETED', 'APPROVED')")
    .all() as { task_id: string; status: string }[];

  let updatedContent = content;
  let updatedCount = 0;

  for (const t of tickets) {
    const escapedId = t.task_id.replace(/\./g, '\\.');
    // Match: * [ ] **1.1** or * [ ] **1.2 (P)** or - [ ] **1.1**
    const regex = new RegExp(`([*\\-]\\s*\\[)\\s*(\\]\\s*\\*\\*${escapedId}(?:\\s*\\(P\\))?\\*\\*)`, 'g');

    if (regex.test(updatedContent)) {
      updatedContent = updatedContent.replace(regex, '$1x$2');
      updatedCount++;
    }
  }

  if (updatedCount > 0) {
    await writeFile(tasksMarkdownPath, updatedContent, 'utf8');
  }

  return { updatedCount };
}

