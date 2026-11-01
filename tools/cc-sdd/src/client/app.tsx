import { DatabaseSync } from 'node:sqlite';

export function h(tag: any, props: any, ...children: any[]): string {
  const flatChildren = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
  const childStr = flatChildren.join('');
  if (typeof tag === 'function') {
    return tag({ ...(props || {}), children: flatChildren });
  }
  const propEntries = Object.entries(props || {});
  const propStr = propEntries.length > 0
    ? ' ' + propEntries.map(([k, v]) => `${k}="${String(v)}"`).join(' ')
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

  const tabs = ['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'];

  const tabsHtml = tabs
    .map(
      (tab) =>
        `<div id="tab-${tab.toLowerCase()}" class="nav-tab ${state.activeTab === tab ? 'active' : ''}">${tab}</div>`
    )
    .join('\n');

  const ticketRowsHtml = sortedTickets
    .map(
      (t) => `
    <div class="ticket-row ${t.status === 'WAITING_FOR_HUMAN' ? 'urgent-human-priority' : ''}">
      <span class="ticket-id">${t.taskId}</span>
      <span class="ticket-title">${t.title}</span>
      <span class="ticket-status badge-${t.status.toLowerCase()}">${t.status}</span>
      <button class="button-stop-task" data-ticket-id="${t.id}">Stop Task</button>
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
          <pre>${state.settings.versionedPrompt}</pre>
        </div>
        <div class="prompt-pane assembled">
          <h4>Fully Assembled Dynamic Prompt</h4>
          <pre>${state.settings.assembledPrompt}</pre>
        </div>
      </div>
    `;
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
    <div class="mode-badge mode-${state.settings.proactiveMode}">Mode: ${state.settings.proactiveMode.toUpperCase()}</div>
  </header>
  <nav class="tabs-bar" style="padding: 12px 24px; background: #1e293b;">
    ${tabsHtml}
  </nav>
  <main class="container">
    <h3>Active Workload & Attention Queue</h3>
    <div class="tickets-list">
      ${ticketRowsHtml || '<p>No active tasks in progress.</p>'}
    </div>
    ${promptDiffHtml}
  </main>
</body>
</html>
`;
}

export class WebPanelServer {
  constructor(
    private db: DatabaseSync,
    public port = 3082
  ) {}

  getState(): WebPanelState {
    const rawTickets = this.db
      .prepare('SELECT id, task_id, title, status FROM tickets ORDER BY updated_at DESC')
      .all() as any[];

    const tickets: TicketView[] = rawTickets.map((t) => ({
      id: t.id,
      taskId: t.task_id,
      title: t.title,
      status: t.status,
    }));

    return {
      activeTab: 'Overview',
      tickets,
      sources: [],
      triggers: [],
      evalQueue: [],
      settings: {
        proactiveMode: 'observe',
      },
    };
  }

  stopTask(ticketId: string): boolean {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tickets SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
      .run(now, ticketId);
    return true;
  }
}

