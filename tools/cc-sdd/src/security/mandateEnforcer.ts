import { randomUUID } from 'node:crypto';

export class MandateViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MandateViolationError';
  }
}

export interface Mandate {
  id: string;
  ticketId: string;
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  allowedCommands: readonly string[];
}

export function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function compileMandateFromBoundary(
  ticketId: string,
  boundaryStr: string,
  fileStructurePlan: string[] = []
): Mandate {
  const fileRegex = /([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_\-]+)/g;
  const matches = boundaryStr.match(fileRegex) || [];

  const candidateFiles = new Set<string>();
  for (const m of matches) {
    // Ignore boundary labels like BND-STATE-ENGINE if matched
    if (!m.startsWith('BND-') && !m.startsWith('REQ-') && m.includes('.')) {
      candidateFiles.add(normalizeFilePath(m));
    }
  }

  for (const f of fileStructurePlan) {
    candidateFiles.add(normalizeFilePath(f));
  }

  const allowedFiles = Object.freeze(Array.from(candidateFiles));
  const forbiddenFiles = Object.freeze([] as string[]);
  const allowedCommands = Object.freeze(['npm test', 'npm run build', 'git status', 'git diff']);

  return {
    id: `mnd-${randomUUID()}`,
    ticketId,
    allowedFiles,
    forbiddenFiles,
    allowedCommands,
  };
}

export class MandateEnforcer {
  constructor(private readonly mandate: Mandate) {}

  getMandate(): Mandate {
    return this.mandate;
  }

  interceptFileWrite(filePath: string): { allowed: boolean } {
    const normalized = normalizeFilePath(filePath);

    const isAllowed = this.mandate.allowedFiles.some((pattern) => {
      if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
        const base = pattern.replace(/\/\*+$/, '');
        return normalized.startsWith(base);
      }
      return normalized === pattern;
    });

    if (!isAllowed) {
      throw new MandateViolationError(
        `MANDATE_BOUNDARY_VIOLATION: Attempted to write to unauthorized file '${normalized}'. ` +
          `Allowed boundaries: [${this.mandate.allowedFiles.join(', ')}]. ` +
          `If this change is necessary, please call handoffToRouter(reason: "UPSTREAM_DEFECT_OR_SCOPE_EXPANSION").`
      );
    }

    return { allowed: true };
  }

  tryExpandFromMessage(_message: string): boolean {
    // Mandates are strictly immutable per REQ-ACC-01. Messages only provide context, never authority.
    return false;
  }
}

export interface ReviewGateEvaluation {
  canCallReview: boolean;
  reason?: string;
}

export class PreLlmReviewGate {
  evaluate(options: {
    testExitCode: number;
    modifiedFiles: string[];
    mandate: Mandate;
  }): ReviewGateEvaluation {
    const { testExitCode, modifiedFiles, mandate } = options;

    if (testExitCode !== 0) {
      return {
        canCallReview: false,
        reason: `TEST_FAILED_MECHANICAL_GATE: Tests exited with code ${testExitCode}. All tests must pass before calling kiro-review.`,
      };
    }

    for (const file of modifiedFiles) {
      const normalized = normalizeFilePath(file);
      const isAllowed = mandate.allowedFiles.some((pattern) => {
        if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
          const base = pattern.replace(/\/\*+$/, '');
          return normalized.startsWith(base);
        }
        return normalized === pattern;
      });

      if (!isAllowed) {
        return {
          canCallReview: false,
          reason: `MANDATE_VIOLATION_IN_DIFF: Modified file '${normalized}' is outside mandate boundary.`,
        };
      }
    }

    return {
      canCallReview: true,
    };
  }
}

