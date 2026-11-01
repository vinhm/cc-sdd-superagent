import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { branchNameFor } from './naming.js';
import { EffectsQueue } from './effects.js';

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
  /** Effects that were PENDING/IN_PROGRESS for this ticket when recovery ran (write-ahead intents). */
  pendingEffectIds: string[];
}

interface TicketRow {
  id: string;
  feature_name: string;
  task_id: string;
  status: string;
  current_phase: string | null;
}

interface PendingEffectRow {
  id: string;
  effect_type: string;
}

const RECOVERABLE_STATUSES = ['DISPATCHED', 'RUNNING', 'IN_PROGRESS'];

export class RecoveryEngine {
  constructor(
    private db: DatabaseSync,
    private gitProvider: GitProvider
  ) {}

  /**
   * Startup protocol: re-queue effects that were IN_PROGRESS when the process died, then reconcile
   * every ticket that was still running.
   */
  async recoverAll(): Promise<{ requeuedEffects: number; decisions: RecoveryDecision[] }> {
    const requeued = new EffectsQueue(this.db).recoverInterrupted();

    const placeholders = RECOVERABLE_STATUSES.map(() => '?').join(', ');
    const tickets = this.db
      .prepare(`SELECT id FROM tickets WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...RECOVERABLE_STATUSES) as unknown as Array<{ id: string }>;

    const decisions: RecoveryDecision[] = [];
    for (const t of tickets) {
      decisions.push(await this.recoverTicket(t.id));
    }
    return { requeuedEffects: requeued.length, decisions };
  }

  async recoverTicket(ticketId: string): Promise<RecoveryDecision> {
    // Step 1: SQLite state (tickets + assignments + the effects queue)
    const ticket = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as TicketRow | undefined;
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const assignment = this.db
      .prepare("SELECT * FROM assignments WHERE ticket_id = ? AND status = 'ACTIVE' ORDER BY assigned_at DESC LIMIT 1")
      .get(ticketId) as any;

    const pendingEffects = this.db
      .prepare(
        "SELECT id, effect_type FROM effects_queue WHERE ticket_id = ? AND status IN ('PENDING', 'IN_PROGRESS') ORDER BY created_at ASC"
      )
      .all(ticketId) as unknown as PendingEffectRow[];
    const pendingEffectIds = pendingEffects.map((e) => e.id);
    const hasPendingPrEffect = pendingEffects.some((e) => e.effect_type === 'CREATE_PR');

    const worktreePath: string | undefined = assignment?.worktree_path;
    // Must match the branch created by GitWorktreeManager (same naming helper).
    const branchName = branchNameFor(ticket.feature_name, ticket.task_id);

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
        pendingEffectIds,
      };
    }

    const greenWithCommits = ticket.current_phase === 'GREEN' && worktreeStatus.commitsAhead > 0;
    if (!prStatus.exists && (greenWithCommits || (hasPendingPrEffect && worktreeStatus.commitsAhead > 0))) {
      return {
        ticketId,
        nextAction: 'CREATE_PR',
        skipRedPhase: true,
        worktreePath,
        reason: hasPendingPrEffect
          ? 'A CREATE_PR effect was recorded but no PR exists remotely; replaying it.'
          : 'GREEN phase completed with commits ahead, but PR not yet created.',
        pendingEffectIds,
      };
    }

    if (worktreeStatus.hasUncommittedChanges) {
      return {
        ticketId,
        nextAction: 'RESUME_TDD',
        skipRedPhase: ticket.current_phase === 'GREEN',
        worktreePath,
        reason: 'Worktree has uncommitted changes, resume TDD implementation.',
        pendingEffectIds,
      };
    }

    return {
      ticketId,
      nextAction: 'START_TASK',
      skipRedPhase: false,
      worktreePath,
      reason: 'Standard resumption from beginning of task.',
      pendingEffectIds,
    };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Projects completed tickets onto `tasks.md` checkboxes. Understands both the cc-sdd template format
 * (`- [ ] 1.1 (P) Title`, `- [ ]* 1.2 ...`) and the bold format (`* [ ] **1.1 (P)** Title`).
 * Pass `featureName` so tickets of other features that reuse the same task numbers are ignored.
 */
export async function syncStateToTasksMarkdown(
  db: DatabaseSync,
  tasksMarkdownPath: string,
  featureName?: string
): Promise<{ updatedCount: number }> {
  const content = await readFile(tasksMarkdownPath, 'utf8');
  const tickets = (
    featureName === undefined
      ? db.prepare("SELECT task_id, status FROM tickets WHERE status IN ('COMPLETED', 'APPROVED')").all()
      : db
          .prepare("SELECT task_id, status FROM tickets WHERE status IN ('COMPLETED', 'APPROVED') AND feature_name = ?")
          .all(featureName)
  ) as unknown as { task_id: string; status: string }[];

  let updatedContent = content;
  let updatedCount = 0;

  for (const t of tickets) {
    const id = escapeRegex(t.task_id);
    // [bullet + "[" ] [space] ["]" + optional "*" + optional bold + id + optional (P) + optional bold + boundary]
    const regex = new RegExp(
      `^(\\s*[*-]\\s*\\[)[ ](\\]\\*?\\s*(?:\\*\\*)?${id}(?:\\s*\\(P\\))?(?:\\*\\*)?(?![0-9]|\\.[0-9]))`,
      'm'
    );

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
