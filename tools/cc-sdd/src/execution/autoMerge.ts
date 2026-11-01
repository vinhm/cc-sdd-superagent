export interface PrMergeContext {
  prNumber: number;
  additions: number;
  deletions: number;
  humanApproved: boolean;
  testsPassed: boolean;
  authorAccount: string;
  mergerAccount: string;
  approverAccount?: string;
}

export interface GitMergeClient {
  merge(prNumber: number, mergeAccount: string): Promise<boolean>;
  cancelAutoMerge(prNumber: number): Promise<boolean>;
}

export interface AutoMergeEligibility {
  eligible: boolean;
  reason?: string;
}

export class ConditionalAutoMerge {
  private enabledPrs = new Set<number>();

  isAutoMergeEnabled(prNumber: number): boolean {
    return this.enabledPrs.has(prNumber);
  }

  canAutoMerge(context: PrMergeContext): AutoMergeEligibility {
    const totalLines = context.additions + context.deletions;

    if (totalLines >= 200) {
      return {
        eligible: false,
        reason: `TOTAL_DIFF_LINES_EXCEEDED: Total changes (${totalLines}) must be strictly under 200 lines for auto-merge.`,
      };
    }

    if (!context.humanApproved) {
      return {
        eligible: false,
        reason: 'HUMAN_APPROVAL_REQUIRED: PR requires human approval before auto-merge.',
      };
    }

    if (context.approverAccount && context.approverAccount === context.authorAccount) {
      return {
        eligible: false,
        reason: 'APPROVER_CANNOT_BE_AUTHOR: Human approver account must be distinct from PR author account.',
      };
    }

    if (!context.testsPassed) {
      return {
        eligible: false,
        reason: 'TESTS_NOT_PASSED: All TDD and CI tests must be passing (GREEN).',
      };
    }

    if (context.mergerAccount === context.authorAccount) {
      return {
        eligible: false,
        reason: 'SEPARATE_MERGE_ACCOUNT_REQUIRED: Merger account must be distinct from author account.',
      };
    }

    return {
      eligible: true,
    };
  }

  async enableAutoMerge(
    context: PrMergeContext,
    client: GitMergeClient
  ): Promise<{ merged: boolean; status: string }> {
    const check = this.canAutoMerge(context);
    if (!check.eligible) {
      throw new Error(`Cannot auto-merge PR #${context.prNumber}: ${check.reason}`);
    }

    this.enabledPrs.add(context.prNumber);
    const merged = await client.merge(context.prNumber, context.mergerAccount);
    return {
      merged,
      status: merged ? 'AUTO_MERGED' : 'FAILED',
    };
  }

  async revokeAutoMergeBeforePush(
    prNumber: number,
    client: GitMergeClient
  ): Promise<{ revoked: boolean }> {
    this.enabledPrs.delete(prNumber);
    const revoked = await client.cancelAutoMerge(prNumber);
    return { revoked };
  }
}


