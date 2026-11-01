import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { WorkerSlotsManager } from '../execution/workerSlots.js';

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function h(tag: any, props: any, ...children: any[]): string {
  const flatChildren = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
  const childStr = flatChildren.join('');
  if (typeof tag === 'function') {
    return tag({ ...(props || {}), children: flatChildren });
  }
  const propEntries = Object.entries(props || {});
  const propStr = propEntries.length > 0
    ? ' ' + propEntries.map(([k, v]) => `${escapeHtml(k)}="${escapeHtml(v)}"`).join(' ')
    : '';

  return `<${tag}${propStr}>${childStr}</${tag}>`;
}

export function Fragment(_props: any, ...children: any[]): string {
  return children.flat().join('');
}

export interface TicketView {
  id: string;
  taskId: string;
  title: string;
  status: string;
}

export interface WebPanelSettings {
  proactiveMode: 'off' | 'observe' | 'auto';
  versionedPrompt?: string;
  assembledPrompt?: string;
}

export interface WebPanelState {
  activeTab: 'Overview' | 'Source' | 'Trigger' | 'Eval' | 'Execution' | 'Settings';
  tickets: TicketView[];
  sources: any[];
  triggers: any[];
  evalQueue: any[];
  settings: WebPanelSettings;
}

export function renderWebPanelApp(state: WebPanelState): string {
  // Sort tickets: WAITING_FOR_HUMAN prioritized at the very top
  const sortedTickets = [...state.tickets].sort((a, b) => {
    if (a.status === 'WAITING_FOR_HUMAN' && b.status !== 'WAITING_FOR_HUMAN') return -1;
    if (b.status === 'WAITING_FOR_HUMAN' && a.status !== 'WAITING_FOR_HUMAN') return 1;
    return 0;
  });

  const tabs = ['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'] as const;

  const tabsHtml = tabs
    .map(
      (tab) =>
        `<div id="tab-${tab.toLowerCase()}" class="nav-tab ${state.activeTab === tab ? 'active' : ''}">${escapeHtml(tab)}</div>`
    )
    .join('\n');

  const ticketRowsHtml = sortedTickets
    .map(
      (t) => `
    <div class="ticket-row ${t.status === 'WAITING_FOR_HUMAN' ? 'urgent-human-priority' : ''}">
      <span class="ticket-id">${escapeHtml(t.taskId)}</span>
      <span class="ticket-title">${escapeHtml(t.title)}</span>
      <span class="ticket-status badge-${escapeHtml(t.status.toLowerCase())}">${escapeHtml(t.status)}</span>
      <button class="button-stop-task" data-ticket-id="${escapeHtml(t.id)}">Stop Task</button>
    </div>
  `
    )
    .join('\n');

  let promptDiffHtml = '';
  if (state.settings.versionedPrompt && state.settings.assembledPrompt) {
    promptDiffHtml = `
      <div class="prompt-diff-comparison">
        <div class="prompt-pane versioned">
          <h4>Versioned Template Prompt</h4>
          <pre>${escapeHtml(state.settings.versionedPrompt)}</pre>
        </div>
        <div class="prompt-pane assembled">
          <h4>Fully Assembled Dynamic Prompt</h4>
          <pre>${escapeHtml(state.settings.assembledPrompt)}</pre>
        </div>
      </div>
    `;
  }

  // Render tab-specific sections
  let mainContentHtml = '';
  switch (state.activeTab) {
    case 'Source':
      mainContentHtml = `
        <h3>Registered Sources</h3>
        <div class="sources-list">
          ${
            state.sources.length > 0
              ? state.sources
                  .map((s) => `<div class="source-item"><b>${escapeHtml(s.type)}</b>: ${escapeHtml(s.name)}</div>`)
                  .join('')
              : '<p>No external sources configured yet.</p>'
          }
        </div>
      `;
      break;

    case 'Trigger':
      mainContentHtml = `
        <h3>Recent Triggers</h3>
        <div class="triggers-list">
          ${
            state.triggers.length > 0
              ? state.triggers
                  .map((tr) => `<div class="trigger-item">${escapeHtml(tr.event_type)} (${escapeHtml(tr.created_at)})</div>`)
                  .join('')
              : '<p>No triggers recorded yet.</p>'
          }
        </div>
      `;
      break;

    case 'Eval':
      mainContentHtml = `
        <h3>Eval Queue & Decisions</h3>
        <div class="eval-list">
          ${
            state.evalQueue.length > 0
              ? state.evalQueue
                  .map((eq) => `<div class="eval-item">${escapeHtml(eq.id)}: ${escapeHtml(eq.status)} (${escapeHtml(eq.reason ?? '')})</div>`)
                  .join('')
              : '<p>Eval queue is empty.</p>'
          }
        </div>
        ${promptDiffHtml}
      `;
      break;

    case 'Execution':
      mainContentHtml = `
        <h3>Active Execution Pool</h3>
        <div class="tickets-list">
          ${ticketRowsHtml || '<p>No active execution tasks.</p>'}
        </div>
      `;
      break;

    case 'Settings':
      mainContentHtml = `
        <h3>Harness Configuration</h3>
        <div class="settings-box">
          <p>Proactive Mode: <b>${escapeHtml(state.settings.proactiveMode.toUpperCase())}</b></p>
          <div class="mode-actions">
            <button class="btn-mode" data-mode="off">Off</button>
            <button class="btn-mode" data-mode="observe">Observe</button>
            <button class="btn-mode" data-mode="auto">Auto</button>
          </div>
        </div>
        ${promptDiffHtml}
      `;
      break;

    case 'Overview':
    default:
      mainContentHtml = `
        <h3>Active Workload & Attention Queue</h3>
        <div class="tickets-list">
          ${ticketRowsHtml || '<p>No active tasks in progress.</p>'}
        </div>
        ${promptDiffHtml}
      `;
      break;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>cc-sdd Super-Harness Web Panel</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #f8fafc; }
    header { background: #1e293b; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
    .tabs-bar { display: flex; gap: 8px; }
    .nav-tab { padding: 8px 16px; border-radius: 6px; cursor: pointer; background: #334155; }
    .nav-tab.active { background: #3b82f6; font-weight: bold; }
    .container { padding: 24px; }
    .ticket-row { display: flex; align-items: center; justify-content: space-between; background: #1e293b; padding: 12px 16px; border-radius: 8px; margin-bottom: 8px; }
    .urgent-human-priority { border-left: 4px solid #ef4444; background: #450a0a; }
    .button-stop-task { background: #dc2626; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    .prompt-diff-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
    .prompt-pane { background: #1e293b; padding: 12px; border-radius: 6px; }
    pre { white-space: pre-wrap; font-family: monospace; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <h2>cc-sdd Super-Harness Control Panel (Port 3082)</h2>
    <div class="mode-badge mode-${escapeHtml(state.settings.proactiveMode)}">Mode: ${escapeHtml(state.settings.proactiveMode.toUpperCase())}</div>
  </header>
  <nav class="tabs-bar" style="padding: 12px 24px; background: #1e293b;">
    ${tabsHtml}
  </nav>
  <main class="container">
    ${mainContentHtml}
  </main>
</body>
</html>
`;
}

export class WebPanelServer {
  private server: Server | null = null;
  private proactiveMode: 'off' | 'observe' | 'auto' = 'observe';

  constructor(
    private db: DatabaseSync,
    public port = 3082,
    private workerSlots?: WorkerSlotsManager
  ) {}

  setProactiveMode(mode: 'off' | 'observe' | 'auto'): void {
    this.proactiveMode = mode;
  }

  getState(tab: WebPanelState['activeTab'] = 'Overview'): WebPanelState {
    const rawTickets = this.db
      .prepare('SELECT id, task_id, title, status FROM tickets ORDER BY updated_at DESC')
      .all() as any[];

    const tickets: TicketView[] = rawTickets.map((t) => ({
      id: t.id,
      taskId: t.task_id,
      title: t.title,
      status: t.status,
    }));

    const sources = this.db.prepare('SELECT * FROM sources ORDER BY created_at DESC LIMIT 50').all() as any[];
    const triggers = this.db.prepare('SELECT * FROM triggers ORDER BY created_at DESC LIMIT 50').all() as any[];

    let evalQueue: any[] = [];
    try {
      evalQueue = this.db.prepare('SELECT * FROM eval_queue ORDER BY created_at DESC LIMIT 50').all() as any[];
    } catch {
      // eval_queue table may not exist in legacy dbs
    }

    return {
      activeTab: tab,
      tickets,
      sources,
      triggers,
      evalQueue,
      settings: {
        proactiveMode: this.proactiveMode,
      },
    };
  }

  stopTask(ticketId: string): boolean {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tickets SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
      .run(now, ticketId);

    if (this.workerSlots) {
      this.workerSlots.releaseSlot(ticketId);
    }
    return true;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const tabParam = url.searchParams.get('tab');
        const validTabs: WebPanelState['activeTab'][] = ['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'];
        const activeTab = validTabs.find((t) => t.toLowerCase() === (tabParam ?? '').toLowerCase()) ?? 'Overview';

        const state = this.getState(activeTab);
        const html = renderWebPanelApp(state);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getState()));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.ticketId) {
              this.stopTask(data.ticketId);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ticketId: data.ticketId }));
              return;
            }
          } catch {
            // invalid json
          }
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ticketId' }));
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.proactiveMode && ['off', 'observe', 'auto'].includes(data.proactiveMode)) {
              this.setProactiveMode(data.proactiveMode);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, proactiveMode: this.proactiveMode }));
              return;
            }
          } catch {
            // invalid json
          }
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid proactiveMode' }));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => resolve());
      this.server!.once('error', reject);
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
