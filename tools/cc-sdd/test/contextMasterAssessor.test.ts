import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { SpecChunker, MasterAssessor } from '../src/context/masterAssessor.js';

describe('BND-CONTEXT-MANDATE: MasterAssessor & Budgeted Read Interface', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-assessor-test-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('indexes markdown documents into stable ID chunks in context_chunks table', () => {
    const chunker = new SpecChunker(db);

    const requirementsContent = `
# Requirements: Feature Alpha

### 1.1 Intent
Core philosophy text for alpha.

### REQ-AUTH-01: Authentication
User must sign in using JWT bearer token with expiry.

### REQ-AUTH-02: RBAC
Role based access control with admin and member roles.
`;

    const chunks = chunker.indexDocument('requirements.md', requirementsContent, 'requirements');
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const chunk1 = db.prepare("SELECT * FROM context_chunks WHERE stable_id = 'REQ-AUTH-01'").get() as any;
    expect(chunk1).toBeDefined();
    expect(chunk1.content).toContain('User must sign in using JWT bearer token');
    expect(chunk1.chunk_type).toBe('requirements');
  });

  it('reads chunks with strict budget, pagination cursor and source citations', () => {
    const chunker = new SpecChunker(db);
    const longContent = 'A'.repeat(1200);
    chunker.indexDocument('design.md', `### BND-CORE-01: Core Boundary\n${longContent}`, 'design');

    const assessor = new MasterAssessor(db);

    // Read first page (maxChars: 500)
    const page1 = assessor.readChunk('BND-CORE-01', 0, 500);
    expect(page1.stableId).toBe('BND-CORE-01');
    expect(page1.content.length).toBe(500);
    expect(page1.cursor).toBe(0);
    expect(page1.nextCursor).toBe(500);
    expect(page1.totalLength).toBeGreaterThan(1200);
    expect(page1.citation).toContain('design.md#BND-CORE-01');

    // Read second page
    const page2 = assessor.readChunk('BND-CORE-01', page1.nextCursor!, 500);
    expect(page2.cursor).toBe(500);
    expect(page2.nextCursor).toBe(1000);

    // Read third page (tail)
    const page3 = assessor.readChunk('BND-CORE-01', page2.nextCursor!, 500);
    expect(page3.cursor).toBe(1000);
    expect(page3.nextCursor).toBeNull();
  });

  it('assembles inline prompt with prefix cache alignment and chained recall references', () => {
    const assessor = new MasterAssessor(db);
    const staticPrefix = 'STATIC_RULE_PREFIX_V1';
    const boundaryFiles = ['src/core/auth.ts', 'test/auth.test.ts'];
    const taskDesc = 'Implement JWT verification';
    const relatedIds = ['REQ-AUTH-01', 'BND-CORE-01'];

    const prompt = assessor.assembleInlinePrompt(staticPrefix, boundaryFiles, taskDesc, relatedIds);

    // Static prefix MUST be exactly at the beginning for KV Prefix Caching
    expect(prompt.startsWith(staticPrefix)).toBe(true);
    expect(prompt).toContain('src/core/auth.ts');
    expect(prompt).toContain('Implement JWT verification');
    expect(prompt).toContain('Available context for Chained Recall via MasterAssessor:');
    expect(prompt).toContain('REQ-AUTH-01');
    expect(prompt).toContain('BND-CORE-01');
  });
});
