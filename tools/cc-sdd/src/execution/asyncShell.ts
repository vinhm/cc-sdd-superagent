import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SubscriptionBus } from '../context/subscriptionBus.js';
import type { EffectsQueue } from '../core/effects.js';

export type AsyncShellStatus = 'COMPLETED' | 'BACKGROUNDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';

export interface AsyncShellResult {
  status: AsyncShellStatus;
  jobId: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  pid?: number;
}

export interface AsyncShellCompletion {
  jobId: string;
  status: Exclude<AsyncShellStatus, 'BACKGROUNDED'>;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface AsyncShellOptions {
  cwd?: string;
  backgroundThresholdMs?: number; // default: 5000ms
  timeoutMs?: number; // default: 30 minutes
  /** Max characters kept per stream (the tail is kept). Default 1,000,000. */
  maxOutputChars?: number;
  onCompleted?: (result: AsyncShellCompletion) => void;
  /** Write-ahead intent: the command is recorded in the effects queue before it is spawned. */
  effects?: { queue: EffectsQueue; ticketId: string | null };
}

export interface AsyncShellJobInfo {
  jobId: string;
  command: string;
  pid?: number;
  startedAt: string;
  backgrounded: boolean;
}

interface ActiveJob {
  proc: ChildProcess;
  command: string;
  startedAt: string;
  backgrounded: boolean;
  timeoutTimer?: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
}

const DEFAULT_MAX_OUTPUT = 1_000_000;

function appendCapped(current: string, chunk: string, max: number): string {
  const next = current + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Kills the whole process tree: `shell: true` would otherwise orphan the real test/build process. */
function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    return;
  }

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL'); // detached => its own process group
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

export class AsyncShellRunner {
  private activeJobs = new Map<string, ActiveJob>();

  async runCommand(command: string, options: AsyncShellOptions = {}): Promise<AsyncShellResult> {
    const jobId = `job-${randomUUID()}`;
    const threshold = options.backgroundThresholdMs ?? 5000;
    const timeout = options.timeoutMs ?? 30 * 60 * 1000; // 30 minutes
    const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;

    const effectId = options.effects
      ? options.effects.queue.enqueue(options.effects.ticketId, 'RUN_SHELL', { jobId, command, cwd: options.cwd }).id
      : undefined;
    if (effectId) options.effects!.queue.markInProgress(effectId);

    const finishEffect = (status: AsyncShellCompletion['status']) => {
      if (!effectId || !options.effects) return;
      if (status === 'COMPLETED') options.effects.queue.markCompleted(effectId);
      else options.effects.queue.markFailed(effectId, status);
    };

    const proc = spawn(command, {
      shell: true,
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout = appendCapped(stdout, data.toString(), maxOutput);
    });

    proc.stderr?.on('data', (data) => {
      stderr = appendCapped(stderr, data.toString(), maxOutput);
    });

    const job: ActiveJob = {
      proc,
      command,
      startedAt: new Date().toISOString(),
      backgrounded: false,
      cancelled: false,
      timedOut: false,
    };
    this.activeJobs.set(jobId, job);

    // 30 minute safety timeout: kill the whole tree; the `close` handler reports TIMED_OUT.
    job.timeoutTimer = setTimeout(() => {
      job.timedOut = true;
      killProcessTree(proc);
    }, timeout);

    return new Promise<AsyncShellResult>((resolve) => {
      let settled = false;

      const thresholdTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        job.backgrounded = true;
        resolve({
          status: 'BACKGROUNDED',
          jobId,
          pid: proc.pid,
        });
      }, threshold);

      const finish = (code: number | null, spawnError?: Error) => {
        clearTimeout(thresholdTimer);
        clearTimeout(job.timeoutTimer);
        this.activeJobs.delete(jobId);

        const status: AsyncShellCompletion['status'] = job.timedOut
          ? 'TIMED_OUT'
          : job.cancelled
            ? 'CANCELLED'
            : code === 0 && !spawnError
              ? 'COMPLETED'
              : 'FAILED';
        const errText = spawnError ? `${stderr}\n${spawnError.message}` : stderr;
        const exitCode = spawnError ? -1 : code;

        finishEffect(status);

        if (!settled) {
          settled = true;
          resolve({ status, jobId, exitCode, stdout, stderr: errText, pid: proc.pid });
        } else {
          options.onCompleted?.({ jobId, status, exitCode, stdout, stderr: errText });
        }
      };

      proc.on('close', (code) => finish(code));
      proc.on('error', (err) => finish(-1, err));
    });
  }

  getJob(jobId: string): AsyncShellJobInfo | undefined {
    const job = this.activeJobs.get(jobId);
    if (!job) return undefined;
    return { jobId, command: job.command, pid: job.proc.pid, startedAt: job.startedAt, backgrounded: job.backgrounded };
  }

  listJobs(): AsyncShellJobInfo[] {
    return Array.from(this.activeJobs.keys()).map((id) => this.getJob(id)!);
  }

  /** Cancels a running job (kills its process tree). The completion callback reports `CANCELLED`. */
  cancelJob(jobId: string): boolean {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;

    job.cancelled = true;
    killProcessTree(job.proc);
    return true;
  }
}

/**
 * Bridges background-command completion into the owning executor's inbox (REQ-TOK-01), so the
 * worker is woken by an event instead of polling.
 */
export function shellCompletionToBus(
  bus: SubscriptionBus,
  target: { threadId: string; ticketId?: string }
): (result: AsyncShellCompletion) => void {
  return (result) => {
    void bus.dispatchThreadEvent({
      id: `ev-shell-${result.jobId}`,
      threadId: target.threadId,
      ticketId: target.ticketId,
      eventType: 'SHELL_COMPLETED',
      payload: result,
    });
  };
}
