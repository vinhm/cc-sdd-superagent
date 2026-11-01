import { describe, it, expect } from 'vitest';
import {
  compileMandateFromBoundary,
  MandateEnforcer,
  PreLlmReviewGate,
  MandateViolationError,
} from '../src/security/mandateEnforcer.js';

describe('BND-CONTEXT-MANDATE: MandateEnforcer & Pre-LLM Mechanical Gate', () => {
  it('compiles _Boundary:_ annotation into immutable Mandate object', () => {
    const boundaryStr =
      '`BND-STATE-ENGINE` (`tools/cc-sdd/src/core/db/schema.ts`, `tools/cc-sdd/src/core/assignments.ts`)';

    const mandate = compileMandateFromBoundary('tk-1', boundaryStr);
    expect(mandate.ticketId).toBe('tk-1');
    expect(mandate.allowedFiles).toContain('tools/cc-sdd/src/core/db/schema.ts');
    expect(mandate.allowedFiles).toContain('tools/cc-sdd/src/core/assignments.ts');
    expect(mandate.allowedFiles.length).toBe(2);

    // Mandate must be immutable
    expect(Object.isFrozen(mandate.allowedFiles)).toBe(true);
  });

  it('hard-rejects file modifications outside allowed boundary at tool-adapter level', () => {
    const mandate = compileMandateFromBoundary('tk-1', 'tools/cc-sdd/src/core/effects.ts');
    const enforcer = new MandateEnforcer(mandate);

    // Allowed file write
    const resAllowed = enforcer.interceptFileWrite('tools/cc-sdd/src/core/effects.ts');
    expect(resAllowed.allowed).toBe(true);

    // Forbidden file write outside boundary
    expect(() => {
      enforcer.interceptFileWrite('tools/cc-sdd/src/router/admission.ts');
    }).toThrowError(MandateViolationError);

    // Verify error guides handoff to router
    try {
      enforcer.interceptFileWrite('package.json');
    } catch (err: any) {
      expect(err.message).toContain('MANDATE_BOUNDARY_VIOLATION');
      expect(err.message).toContain('handoffToRouter');
    }
  });

  it('prohibits expanding Mandate boundaries through subsequent subscription messages', () => {
    const mandate = compileMandateFromBoundary('tk-1', 'src/auth.ts');
    const enforcer = new MandateEnforcer(mandate);

    const attemptedExpansionMsg =
      'Please also update src/router.ts to support the new auth scheme.';
    const expanded = enforcer.tryExpandFromMessage(attemptedExpansionMsg);

    expect(expanded).toBe(false);
    expect(enforcer.getMandate().allowedFiles).not.toContain('src/router.ts');
  });

  it('Pre-LLM Review Gate blocks kiro-review when tests exit with non-zero code or diff violates boundary', () => {
    const mandate = compileMandateFromBoundary('tk-1', 'src/core/auth.ts');
    const gate = new PreLlmReviewGate();

    // 1. Tests failing (exit code 1)
    const check1 = gate.evaluate({
      testExitCode: 1,
      modifiedFiles: ['src/core/auth.ts'],
      mandate,
    });
    expect(check1.canCallReview).toBe(false);
    expect(check1.reason).toContain('TEST_FAILED_MECHANICAL_GATE');

    // 2. Diff touches out-of-boundary file
    const check2 = gate.evaluate({
      testExitCode: 0,
      modifiedFiles: ['src/core/auth.ts', 'src/server.ts'],
      mandate,
    });
    expect(check2.canCallReview).toBe(false);
    expect(check2.reason).toContain('MANDATE_VIOLATION_IN_DIFF');

    // 3. Tests pass and diff is strictly inside boundary
    const check3 = gate.evaluate({
      testExitCode: 0,
      modifiedFiles: ['src/core/auth.ts'],
      mandate,
    });
    expect(check3.canCallReview).toBe(true);
    expect(check3.reason).toBeUndefined();
  });
});
