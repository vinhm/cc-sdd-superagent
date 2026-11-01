import { describe, it, expect } from 'vitest';
import { agentDefinitions, getAgentDefinition, defaultAgentPresets, type AgentType } from '../src/agents/registry.js';
import { runCli } from '../src/index.js';

describe('BND-SUPERVISION-INTEGRATION: Agent Presets cc-sdd-router and cc-sdd-worker', () => {
  it('defines cc-sdd-router preset without code-writing tools', () => {
    const routerDef = getAgentDefinition('cc-sdd-router' as AgentType);
    expect(routerDef).toBeDefined();
    expect(routerDef.label).toContain('Router');
    expect(routerDef.presets?.router.role).toBe('router');
    expect(routerDef.presets?.router.allowedTools).not.toContain('write_file');
    expect(routerDef.presets?.router.allowedTools).not.toContain('edit_file');
  });

  it('defines cc-sdd-worker preset with full isolated TDD toolset', () => {
    const workerDef = getAgentDefinition('cc-sdd-worker' as AgentType);
    expect(workerDef).toBeDefined();
    expect(workerDef.label).toContain('Worker');
    expect(workerDef.presets?.worker.role).toBe('worker');
    expect(workerDef.presets?.worker.allowedTools).toContain('write_file');
    expect(workerDef.presets?.worker.allowedTools).toContain('edit_file');
  });

  it('attaches router and worker presets to all 8 core skills agent definitions', () => {
    const skillsAgents: AgentType[] = [
      'claude-code-skills',
      'codex-skills',
      'cursor-skills',
      'github-copilot-skills',
      'gemini-cli-skills',
      'devin-skills',
      'opencode-skills',
      'antigravity-skills',
    ];

    for (const agentId of skillsAgents) {
      const def = getAgentDefinition(agentId);
      expect(def.presets).toBeDefined();
      expect(def.presets?.router.name).toBe('cc-sdd-router');
      expect(def.presets?.worker.name).toBe('cc-sdd-worker');
    }
  });

  it('executes dry-run CLI successfully for router and worker presets', async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const io = {
      log: (m: string) => logs.push(m),
      error: (m: string) => {
        errs.push(m);
        console.error('CLI ERROR:', m);
      },
      exit: () => {},
    };

    const codeRouter = await runCli(['--agent', 'cc-sdd-router', '--dry-run'], { platform: 'darwin' }, io, {});
    expect(codeRouter).toBe(0);

    const codeWorker = await runCli(['--agent', 'cc-sdd-worker', '--dry-run'], { platform: 'darwin' }, io, {});
    expect(codeWorker).toBe(0);
  });
});
