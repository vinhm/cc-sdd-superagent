import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface AsyncShellResult {
  status: 'COMPLETED' | 'BACKGROUNDED' | 'FAILED' | 'TIMED_OUT';
  jobId: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  pid?: number;
}

export interface AsyncShellOptions {
  cwd?: string;
  backgroundThresholdMs?: number; // default: 5000ms
  timeoutMs?: number; // default: 30 minutes
  onCompleted?: (result: {
    jobId: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }) => void;
}

interface ActiveJob {
  proc: ChildProcess;
  timeoutTimer?: NodeJS.Timeout;
}

export class AsyncShellRunner {
  private activeJobs = new Map<string, ActiveJob>();

  async runCommand(command: string, options: AsyncShellOptions = {}): Promise<AsyncShellResult> {
    const jobId = `job-${randomUUID()}`;
    const threshold = options.backgroundThresholdMs ?? 5000;
    const timeout = options.timeoutMs ?? 30 * 60 * 1000; // 30 minutes

    const proc = spawn(command, {
      shell: true,
      cwd: options.cwd,
    });

    let stdout = '';
    let stderr = '';
    let isExited = false;
    let exitCode: number | null = null;

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const activeJob: ActiveJob = { proc };
    this.activeJobs.set(jobId, activeJob);

    // 30 minute safety timeout
    activeJob.timeoutTimer = setTimeout(() => {
      if (!isExited) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        this.activeJobs.delete(jobId);
      }
    }, timeout);

    return new Promise<AsyncShellResult>((resolve) => {
      let thresholdElapsed = false;

      const thresholdTimer = setTimeout(() => {
        thresholdElapsed = true;
        resolve({
          status: 'BACKGROUNDED',
          jobId,
          pid: proc.pid,
        });
      }, threshold);

      proc.on('close', (code) => {
        isExited = true;
        exitCode = code;
        clearTimeout(thresholdTimer);
        clearTimeout(activeJob.timeoutTimer);
        this.activeJobs.delete(jobId);

        if (!thresholdElapsed) {
          resolve({
            status: code === 0 ? 'COMPLETED' : 'FAILED',
            jobId,
            exitCode,
            stdout,
            stderr,
            pid: proc.pid,
          });
        } else {
          if (options.onCompleted) {
            options.onCompleted({
              jobId,
              exitCode,
              stdout,
              stderr,
            });
          }
        }
      });

      proc.on('error', (err) => {
        isExited = true;
        clearTimeout(thresholdTimer);
        clearTimeout(activeJob.timeoutTimer);
        this.activeJobs.delete(jobId);

        if (!thresholdElapsed) {
          resolve({
            status: 'FAILED',
            jobId,
            exitCode: -1,
            stdout,
            stderr: `${stderr}\n${err.message}`,
          });
        }
      });
    });
  }

  cancelJob(jobId: string): boolean {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;

    clearTimeout(job.timeoutTimer);
    try {
      job.proc.kill();
    } catch {
      // ignore
    }
    this.activeJobs.delete(jobId);
    return true;
  }
}
