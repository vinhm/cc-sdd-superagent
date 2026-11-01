import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface ContextChunkRecord {
  id: string;
  stable_id: string;
  source_file: string;
  chunk_type: string;
  content: string;
  char_length: number;
}

export interface BudgetedReadResult {
  stableId: string;
  sourceFile: string;
  chunkType: string;
  content: string;
  cursor: number;
  nextCursor: number | null;
  totalLength: number;
  citation: string;
}

export class SpecChunker {
  constructor(private db: DatabaseSync) {}

  indexDocument(
    sourceFile: string,
    content: string,
    chunkType: 'requirements' | 'design' | 'steering' | 'implementation_notes'
  ): ContextChunkRecord[] {
    const sections = content.split(/(?=^#{1,4}\s+)/m).filter((s) => s.trim().length > 0);
    const results: ContextChunkRecord[] = [];
    const now = new Date().toISOString();

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i].trim();
      const firstLine = section.split('\n')[0] || '';

      // Determine stable ID
      let stableId = '';
      const reqMatch = firstLine.match(/REQ-[A-Za-z0-9_\-]+/);
      const bndMatch = firstLine.match(/BND-[A-Za-z0-9_\-]+/);
      const secMatch = firstLine.match(/^#{1,4}\s+(\d+(?:\.\d+)*)/);

      if (reqMatch) {
        stableId = reqMatch[0];
      } else if (bndMatch) {
        stableId = bndMatch[0];
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

      const id = `chk-${randomUUID()}`;
      const charLength = section.length;

      this.db
        .prepare(
          `INSERT INTO context_chunks (id, stable_id, source_file, chunk_type, content, char_length, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(stable_id) DO UPDATE SET
             content = excluded.content,
             char_length = excluded.char_length,
             source_file = excluded.source_file,
             chunk_type = excluded.chunk_type`
        )
        .run(id, stableId, sourceFile, chunkType, section, charLength, now);

      results.push({
        id,
        stable_id: stableId,
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

  readChunk(stableId: string, cursor = 0, maxChars = 500): BudgetedReadResult {
    const row = this.db.prepare('SELECT * FROM context_chunks WHERE stable_id = ?').get(stableId) as any;
    if (!row) {
      throw new Error(`Context chunk not found for stableId: ${stableId}`);
    }

    const totalLength = row.content.length;
    const end = Math.min(cursor + maxChars, totalLength);
    const slice = row.content.slice(cursor, end);
    const nextCursor = end < totalLength ? end : null;
    const citation = `[${row.source_file}#${row.stable_id}](file:///${row.source_file})`;

    return {
      stableId,
      sourceFile: row.source_file,
      chunkType: row.chunk_type,
      content: slice,
      cursor,
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
