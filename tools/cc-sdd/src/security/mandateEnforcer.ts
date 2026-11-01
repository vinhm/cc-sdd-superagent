import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

export class MandateViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MandateViolationError';
  }
}

export interface Mandate {
  readonly id: string;
  readonly ticketId: string;
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles: readonly string[];
  readonly allowedCommands: readonly string[];
}

export function normalizeFilePath(p: string): string {
  const unified = p.replace(/\\/g, '/').trim();
  if (unified.length === 0) return unified;
  return posix.normalize(unified).replace(/^\.\//, '');
}

/**
 * Converts a path requested by a tool call into a canonical workspace-relative path.
 * Returns null when the path escapes the workspace (`..`) or is absolute and cannot be
 * relativized, so that callers fail closed.
 */
export function resolveToolPath(p: string, workspaceRoot?: string): string | null {
  let normalized = normalizeFilePath(p);
  if (normalized.length === 0) return null;

  const isAbsolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  if (isAbsolute) {
    if (!workspaceRoot) return null;
    const root = normalizeFilePath(workspaceRoot).replace(/\/+$/, '');
    const caseInsensitive = /^[a-zA-Z]:\//.test(root);
    const lhs = caseInsensitive ? normalized.toLowerCase() : normalized;
    const rhs = caseInsensitive ? root.toLowerCase() : root;
    if (lhs !== rhs && !lhs.startsWith(`${rhs}/`)) return null;
    normalized = normalized.slice(root.length).replace(/^\/+/, '');
    if (normalized.length === 0) return null;
  }

  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') return null;
  return normalized;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

/** Segment-aware match of a canonical path against a mandate pattern. */
export function matchesMandatePattern(pattern: string, canonicalPath: string): boolean {
  const pat = normalizeFilePath(pattern);

  // Directory scope: `dir/*` or `dir/**` (or `dir/`) covers everything below `dir/`.
  const dirMatch = pat.match(/^(.*?)\/(?:\*\*?)?$/);
  if (dirMatch && !dirMatch[1].includes('*')) {
    const base = dirMatch[1];
    return canonicalPath === base || canonicalPath.startsWith(`${base}/`);
  }

  if (pat.includes('*')) {
    return globToRegex(pat).test(canonicalPath);
  }
  return canonicalPath === pat;
}

export function isPathAllowedByMandate(mandate: Mandate, filePath: string, workspaceRoot?: string): boolean {
  const canonical = resolveToolPath(filePath, workspaceRoot);
  if (canonical === null) return false;
  if (mandate.forbiddenFiles.some((pattern) => matchesMandatePattern(pattern, canonical))) return false;
  return mandate.allowedFiles.some((pattern) => matchesMandatePattern(pattern, canonical));
}

const PATH_TOKEN_SPLIT = /[\s,;`()\[\]'"]+/;

function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  if (/^(BND|REQ|NOTE)-/.test(token)) return false;
  if (token.includes('/')) return true;
  return /\.[A-Za-z][A-Za-z0-9]*$/.test(token);
}

export interface CompileMandateOptions {
  allowedCommands?: readonly string[];
  forbiddenFiles?: readonly string[];
}

export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = ['npm test', 'npm run build', 'git status', 'git diff'];

/** Extracts file paths / globs mentioned in a `_Boundary:_` annotation (component names yield none). */
export function extractBoundaryPaths(boundaryStr: string): string[] {
  const paths = new Set<string>();
  for (const raw of boundaryStr.split(PATH_TOKEN_SPLIT)) {
    const token = raw.replace(/[.:]+$/, '');
    if (looksLikePath(token)) {
      const normalized = normalizeFilePath(token);
      if (normalized.length > 0 && !normalized.startsWith('../')) paths.add(normalized);
    }
  }
  return Array.from(paths);
}

export function compileMandateFromBoundary(
  ticketId: string,
  boundaryStr: string,
  fileStructurePlan: string[] = [],
  options: CompileMandateOptions = {}
): Mandate {
  const candidateFiles = new Set<string>(extractBoundaryPaths(boundaryStr));

  for (const f of fileStructurePlan) {
    const normalized = normalizeFilePath(f);
    if (normalized.length > 0 && !normalized.startsWith('../')) candidateFiles.add(normalized);
  }

  return Object.freeze({
    id: `mnd-${randomUUID()}`,
    ticketId,
    allowedFiles: Object.freeze(Array.from(candidateFiles)),
    forbiddenFiles: Object.freeze((options.forbiddenFiles ?? []).map(normalizeFilePath)),
    allowedCommands: Object.freeze([...(options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS)]),
  });
}
const SHELL_META = /[;&|`<>\r\n]|\$\(/;

export class MandateEnforcer {
  constructor(
    private readonly mandate: Mandate,
    private readonly workspaceRoot?: string
  ) {}

  getMandate(): Mandate {
    return this.mandate;
  }

  interceptFileWrite(filePath: string): { allowed: boolean } {
    if (!isPathAllowedByMandate(this.mandate, filePath, this.workspaceRoot)) {
      const shown = resolveToolPath(filePath, this.workspaceRoot) ?? normalizeFilePath(filePath);
      throw new MandateViolationError(
        `MANDATE_BOUNDARY_VIOLATION: Attempted to write to unauthorized file '${shown}'. ` +
          `Allowed boundaries: [${this.mandate.allowedFiles.join(', ')}]. ` +
          `If this change is necessary, please call handoffToRouter(reason: "UPSTREAM_DEFECT_OR_SCOPE_EXPANSION").`
      );
    }

    return { allowed: true };
  }

  interceptCommand(command: string): { allowed: boolean } {
    const trimmed = command.trim().replace(/\s+/g, ' ');
    const permitted =
      trimmed.length > 0 &&
      !SHELL_META.test(trimmed) &&
      this.mandate.allowedCommands.some((allowed) => trimmed === allowed || trimmed.startsWith(`${allowed} `));

    if (!permitted) {
      throw new MandateViolationError(
        `MANDATE_COMMAND_VIOLATION: Command '${trimmed}' is not permitted by the mandate. ` +
          `Allowed commands: [${this.mandate.allowedCommands.join(', ')}]. ` +
          `If this command is necessary, please call handoffToRouter(reason: "UPSTREAM_DEFECT_OR_SCOPE_EXPANSION").`
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
    workspaceRoot?: string;
  }): ReviewGateEvaluation {
    const { testExitCode, modifiedFiles, mandate, workspaceRoot } = options;

    if (testExitCode !== 0) {
      return {
        canCallReview: false,
        reason: `TEST_FAILED_MECHANICAL_GATE: Tests exited with code ${testExitCode}. All tests must pass before calling kiro-review.`,
      };
    }

    for (const file of modifiedFiles) {
      if (!isPathAllowedByMandate(mandate, file, workspaceRoot)) {
        return {
          canCallReview: false,
          reason: `MANDATE_VIOLATION_IN_DIFF: Modified file '${normalizeFilePath(file)}' is outside mandate boundary.`,
        };
      }
    }

    return {
      canCallReview: true,
    };
  }
}
