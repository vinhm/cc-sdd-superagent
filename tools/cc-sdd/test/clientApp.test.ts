import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { renderWebPanelApp, WebPanelServer, type WebPanelState } from '../src/client/app.js';

describe('BND-SUPERVISION-INTEGRATION: Web Panel on port 3082', () => {
  let tempDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cc-sdd-webpanel-test-'));
    db = initHarnessDatabase(join(tempDir, 'harness.db'));

    db.prepare("INSERT INTO threads (id, title) VALUES ('th-web', 'Web Panel Test Feature')").run();
    db.prepare(`
      INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status)
      VALUES 
        ('tk-normal', 'th-web', '1.1', 'web-feat', 'Normal Running Task', 'DISPATCHED'),
        ('tk-human', 'th-web', '1.2', 'web-feat', 'Urgent Human Decision Task', 'WAITING_FOR_HUMAN')
    `).run();
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('renders all 6 tabs (Overview, Source, Trigger, Eval, Execution, Settings)', () => {
    const state: WebPanelState = {
      activeTab: 'Overview',
      tickets: [],
      sources: [],
      triggers: [],
      evalQueue: [],
      settings: { proactiveMode: 'observe' },
    };

    const html = renderWebPanelApp(state);

    expect(html).toContain('tab-overview');
    expect(html).toContain('tab-source');
    expect(html).toContain('tab-trigger');
    expect(html).toContain('tab-eval');
    expect(html).toContain('tab-execution');
    expect(html).toContain('tab-settings');
  });

  it('prioritizes tickets with WAITING_FOR_HUMAN status at the top of the decision list', () => {
    const tickets = [
      { id: 'tk-normal', taskId: '1.1', title: 'Normal Running Task', status: 'DISPATCHED' },
      { id: 'tk-human', taskId: '1.2', title: 'Urgent Human Decision Task', status: 'WAITING_FOR_HUMAN' },
    ];

    const state: WebPanelState = {
      activeTab: 'Overview',
      tickets,
      sources: [],
      triggers: [],
      evalQueue: [],
      settings: { proactiveMode: 'observe' },
    };

    const html = renderWebPanelApp(state);

    // Verify WAITING_FOR_HUMAN appears first in the list
    const humanIndex = html.indexOf('Urgent Human Decision Task');
    const normalIndex = html.indexOf('Normal Running Task');

    expect(humanIndex).toBeGreaterThan(-1);
    expect(normalIndex).toBeGreaterThan(-1);
    expect(humanIndex).toBeLessThan(normalIndex);

    // Verify stop action button is present
    expect(html).toContain('button-stop-task');
  });

  it('supports comparing versioned prompt templates with fully assembled prompts in Settings/Eval', () => {
    const state: WebPanelState = {
      activeTab: 'Settings',
      tickets: [],
      sources: [],
      triggers: [],
      evalQueue: [],
      settings: {
        proactiveMode: 'auto',
        versionedPrompt: 'ROLE: Implementer v3.0\nTASK: {{TASK_ID}}',
        assembledPrompt: 'ROLE: Implementer v3.0\nTASK: 1.2 (P)\nBOUNDARIES: [src/core/effects.ts]',
      },
    };

    const html = renderWebPanelApp(state);

    expect(html).toContain('prompt-diff-comparison');
    expect(html).toContain('ROLE: Implementer v3.0');
    expect(html).toContain('BOUNDARIES: [src/core/effects.ts]');
    expect(html).toContain('mode-auto');
  });

  it('WebPanelServer manages state and handles stop action on port 3082', async () => {
    const server = new WebPanelServer(db, 3082);
    const stopped = server.stopTask('tk-normal');
    expect(stopped).toBe(true);

    const ticket = db.prepare("SELECT * FROM tickets WHERE id = 'tk-normal'").get() as any;
    expect(ticket.status).toBe('CANCELLED');
  });
});
