import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface ContextChunkRecord {
  id: string;
  stable_id: string;
  scope: string;
  source_file: string;
  chunk_type: string;
  content: string;
  char_length: number;
}

export interface BudgetedReadResult {
  stableId: string;
  scope: string;
  sourceFile: string;
  chunkType: string;
  content: string;
  cursor: number;
  nextCursor: number | null;
  totalLength: number;
  citation: string;
}

export type ChunkType = 'requirements' | 'design' | 'steering' | 'implementation_notes';

interface Section {
  text: string;
  heading: string;
}

/** Strips a leading YAML frontmatter block, returning its raw body and the remaining markdown. */
function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

/**
 * Reads machine-oriented dependency headers (`depends_on:` / `dependencies:` list in YAML frontmatter).
 */
export function parseDocumentDependencies(content: string): string[] {
  const { frontmatter } = splitFrontmatter(content);
  if (!frontmatter) return [];

  const deps: string[] = [];
  const lines = frontmatter.split(/\r?\n/);
  let inList = false;
  for (const line of lines) {
    const inline = line.match(/^(?:depends_on|dependencies)\s*:\s*\[(.*)\]\s*$/);
    if (inline) {
      deps.push(...inline[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
      inList = false;
      continue;
    }
    if (/^(?:depends_on|dependencies)\s*:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        deps.push(item[1].replace(/^['"]|['"]$/g, ''));
      } else if (line.trim().length > 0) {
        inList = false;
      }
    }
  }
  return deps;
}

/** Splits markdown on headings (levels 1-4) while ignoring `#` lines that live inside code fences. */
function splitByHeadings(body: string): Section[] {
  const sections: Section[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = current.join('\n').trim();
    if (text.length > 0) {
      sections.push({ text, heading: text.split('\n')[0] ?? '' });
    }
    current = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    if (!inFence && /^#{1,4}\s+/.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return sections;
}

/** Splits an `## Implementation Notes` body into one chunk per top-level list item / heading. */
function splitNotes(body: string): Section[] {
  const sections: Section[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = current.join('\n').trim();
    if (text.length > 0) {
      sections.push({ text, heading: text.split('\n')[0] ?? '' });
    }
    current = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    if (!inFence && (/^#{1,4}\s+/.test(line) || /^[-*]\s+/.test(line))) {
      flush();
    }
    current.push(line);
  }
  flush();
  return sections.filter((s) => !/^#{1,4}\s+Implementation Notes\s*$/i.test(s.text));
}

export class SpecChunker {
  constructor(private db: DatabaseSync) {}

  extractDependencies(content: string): string[] {
    return parseDocumentDependencies(content);
  }

  /**
   * Indexes a document into `context_chunks`.
   *
   * Stable IDs are only unique within a `scope`. The scope defaults to the source file so identical
   * section numbers (`SEC-1.1`) in `requirements.md` and `design.md`, or `REQ-1` across features,
   * never overwrite each other. Pass the feature directory as `scope` to share IDs between its files.
   */
  indexDocument(
    sourceFile: string,
    content: string,
    chunkType: ChunkType,
    scope: string = sourceFile
  ): ContextChunkRecord[] {
    const { body } = splitFrontmatter(content);
    const sections = chunkType === 'implementation_notes' ? splitNotes(body) : splitByHeadings(body);
    const results: ContextChunkRecord[] = [];
    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i].text;
      const firstLine = sections[i].heading;

      let stableId = '';
      const reqMatch = firstLine.match(/REQ-[A-Za-z0-9_\-\.]+/);
      const bndMatch = firstLine.match(/BND-[A-Za-z0-9_\-\.]+/);
      const noteMatch = firstLine.match(/NOTE-[A-Za-z0-9_\-\.]+/);
      const explicitSecMatch = firstLine.match(/SEC-[A-Za-z0-9_\-\.]+/);
      const secMatch = firstLine.match(/^#{1,4}\s+(\d+(?:\.\d+)*)/);

      if (reqMatch) {
        stableId = reqMatch[0];
      } else if (bndMatch) {
        stableId = bndMatch[0];
      } else if (noteMatch) {
        stableId = noteMatch[0];
      } else if (explicitSecMatch) {
        stableId = explicitSecMatch[0];
      } else if (chunkType === 'implementation_notes') {
        stableId = `NOTE-${String(i + 1).padStart(2, '0')}`;
      } else if (secMatch) {
        stableId = `SEC-${secMatch[1]}`;
      } else {
        const slug = firstLine
          .replace(/^#{1,4}\s+/, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 30);
        stableId = slug.length > 0 ? `${chunkType.toUpperCase()}-${slug}` : `${chunkType.toUpperCase()}-CHUNK-${i + 1}`;
      }

      // Guarantee uniqueness inside one document so a repeated heading cannot overwrite its sibling.
      if (seen.has(stableId)) {
        let n = 2;
        while (seen.has(`${stableId}~${n}`)) n++;
        stableId = `${stableId}~${n}`;
      }
      seen.add(stableId);

      const id = `chk-${randomUUID()}`;
      const charLength = section.length;

      this.db
        .prepare(
          `INSERT INTO context_chunks (id, stable_id, scope, source_file, chunk_type, content, char_length, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, stable_id) DO UPDATE SET
             content = excluded.content,
             char_length = excluded.char_length,
             source_file = excluded.source_file,
             chunk_type = excluded.chunk_type`
        )
        .run(id, stableId, scope, sourceFile, chunkType, section, charLength, now);

      results.push({
        id,
        stable_id: stableId,
        scope,
        source_file: sourceFile,
        chunk_type: chunkType,
        content: section,
        char_length: charLength,
      });
    }

    return results;
  }
}

export class MasterAssessor {
  constructor(private db: DatabaseSync) {}

  /**
   * Budgeted read of a chunk. `scope` may be a document path or a directory prefix (e.g. a feature
   * folder). When omitted and the ID exists in more than one scope the call fails instead of guessing.
   */
  readChunk(stableId: string, cursor = 0, maxChars = 500, scope?: string): BudgetedReadResult {
    const rows = (
      scope === undefined
        ? this.db.prepare('SELECT * FROM context_chunks WHERE stable_id = ?').all(stableId)
        : this.db
            .prepare('SELECT * FROM context_chunks WHERE stable_id = ? AND (scope = ? OR scope LIKE ?)')
            .all(stableId, scope, `${scope.replace(/\/+$/, '')}/%`)
    ) as any[];

    if (rows.length === 0) {
      throw new Error(`Context chunk not found for stableId: ${stableId}`);
    }
    if (rows.length > 1) {
      const scopes = rows.map((r) => r.scope).join(', ');
      throw new Error(`Ambiguous stableId '${stableId}' exists in multiple scopes: ${scopes}. Pass a scope.`);
    }

    const row = rows[0];
    const start = Math.max(0, cursor);
    const budget = Math.max(0, maxChars);
    const totalLength = row.content.length;
    const end = Math.min(start + budget, totalLength);
    const slice = row.content.slice(start, end);
    const nextCursor = end < totalLength ? end : null;
    const citation = `[${row.source_file}#${row.stable_id}](file:///${row.source_file})`;

    return {
      stableId,
      scope: row.scope,
      sourceFile: row.source_file,
      chunkType: row.chunk_type,
      content: slice,
      cursor: start,
      nextCursor,
      totalLength,
      citation,
    };
  }

  assembleInlinePrompt(
    staticPrefix: string,
    boundaryFiles: string[],
    taskDescription: string,
    relatedStableIds: string[]
  ): string {
    const boundaryList = boundaryFiles.map((f) => `- ${f}`).join('\n');
    const recallList = relatedStableIds.map((id) => `- ID: ${id} (Call MasterAssessor.readChunk('${id}'))`).join('\n');

    return `${staticPrefix}

## Current Task Scope & Boundaries
${boundaryList}

## Task Description
${taskDescription}

## Available context for Chained Recall via MasterAssessor:
${recallList}
`;
  }
}
