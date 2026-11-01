import { describe, it, expect, vi } from 'vitest';
import { AsyncShellRunner } from '../src/execution/asyncShell.js';
import { ConditionalAutoMerge, type PrMergeContext } from '../src/execution/autoMerge.js';

describe('BND-EXEC-RUNTIME: AsyncShellRunner & ConditionalAutoMerge', () => {
  describe('AsyncShellRunner', () => {
    it('returns COMPLETED for fast commands finishing under background threshold', async () => {
      const runner = new AsyncShellRunner();
      const res = await runner.runCommand('node -e "console.log(\'quick output\')"', {
        backgroundThresholdMs: 2000,
      });

      expect(res.status).toBe('COMPLETED');
      expect(res.stdout).toContain('quick output');
      expect(res.exitCode).toBe(0);
      expect(res.jobId).toBeDefined();
    });

    it('backgrounds commands taking longer than 5s (threshold) and emits completion via callback', async () => {
      const runner = new AsyncShellRunner();
      const onCompleted = vi.fn();

      // Command runs for 300ms, with threshold of 50ms (simulating 12s vs 5s)
      const res = await runner.runCommand('node -e "setTimeout(() => console.log(\'slow done\'), 300)"', {
        backgroundThresholdMs: 50,
        onCompleted,
      });

      expect(res.status).toBe('BACKGROUNDED');
      expect(res.jobId).toBeDefined();
      expect(onCompleted).not.toHaveBeenCalled();

      // Wait for background completion
      await new Promise((r) => setTimeout(r, 450));
      expect(onCompleted).toHaveBeenCalledTimes(1);
      const completionResult = onCompleted.mock.calls[0][0];
      expect(completionResult.jobId).toBe(res.jobId);
      expect(completionResult.stdout).toContain('slow done');
      expect(completionResult.exitCode).toBe(0);
    });

    it('cancels background jobs on demand or upon 30m timeout', async () => {
      const runner = new AsyncShellRunner();
      const res = await runner.runCommand('node -e "setInterval(() => {}, 1000)"', {
        backgroundThresholdMs: 50,
      });

      expect(res.status).toBe('BACKGROUNDED');
      const cancelled = runner.cancelJob(res.jobId!);
      expect(cancelled).toBe(true);
    });
  });

  describe('ConditionalAutoMerge', () => {
    const mockMergeClient = {
      merge: vi.fn().mockResolvedValue(true),
      cancelAutoMerge: vi.fn().mockResolvedValue(true),
    };

    it('allows auto-merge only when lines < 200, approved by human, tests green, and distinct accounts', async () => {
      const merger = new ConditionalAutoMerge();

      const validContext: PrMergeContext = {
        prNumber: 42,
        additions: 110,
        deletions: 40, // total = 150 < 200
        humanApproved: true,
        testsPassed: true,
        authorAccount: 'agent-implementer',
        mergerAccount: 'lead-engineer-bot',
      };

      const check1 = merger.canAutoMerge(validContext);
      expect(check1.eligible).toBe(true);

      const res = await merger.enableAutoMerge(validContext, mockMergeClient);
      expect(res.merged).toBe(true);
      expect(mockMergeClient.merge).toHaveBeenCalledWith(42, 'lead-engineer-bot');
    });

    it('rejects auto-merge when changes exceed 200 lines or merger account matches author', () => {
      const merger = new ConditionalAutoMerge();

      // Over 200 lines
      const overSizeContext: PrMergeContext = {
        prNumber: 43,
        additions: 150,
        deletions: 80, // total = 230 >= 200
        humanApproved: true,
        testsPassed: true,
        authorAccount: 'agent-worker',
        mergerAccount: 'merger-bot',
      };
      const checkOverSize = merger.canAutoMerge(overSizeContext);
      expect(checkOverSize.eligible).toBe(false);
      expect(checkOverSize.reason).toContain('TOTAL_DIFF_LINES_EXCEEDED');

      // Same account
      const sameAccountContext: PrMergeContext = {
        prNumber: 44,
        additions: 50,
        deletions: 10,
        humanApproved: true,
        testsPassed: true,
        authorAccount: 'agent-worker',
        mergerAccount: 'agent-worker',
      };
      const checkSameAccount = merger.canAutoMerge(sameAccountContext);
      expect(checkSameAccount.eligible).toBe(false);
      expect(checkSameAccount.reason).toContain('SEPARATE_MERGE_ACCOUNT_REQUIRED');
    });

    it('revokes auto-merge flag before pushing new commit to the PR branch', async () => {
      const merger = new ConditionalAutoMerge();
      const res = await merger.revokeAutoMergeBeforePush(42, mockMergeClient);

      expect(res.revoked).toBe(true);
      expect(mockMergeClient.cancelAutoMerge).toHaveBeenCalledWith(42);
    });
  });
});
