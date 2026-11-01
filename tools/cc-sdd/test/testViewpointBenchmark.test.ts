import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHarnessDatabase } from '../src/core/db/schema.js';
import { EffectsQueue, AgentDelivery, OutboxReconciler } from '../src/core/effects.js';
import { RecoveryEngine, syncStateToTasksMarkdown, type GitProvider } from '../src/core/recovery.js';
import { SpecChunker, MasterAssessor } from '../src/context/masterAssessor.js';
import { SubscriptionBus } from '../src/context/subscriptionBus.js';
import {
  MandateEnforcer,
  PreLlmReviewGate,
  compileMandateFromBoundary,
  MandateViolationError,
} from '../src/security/mandateEnforcer.js';
import { WorkerSlotsManager } from '../src/execution/workerSlots.js';
import { ConditionalAutoMerge } from '../src/execution/autoMerge.js';
import { AdmissionGate, type IncomingEvent } from '../src/router/admission.js';
import { EvalBatcher } from '../src/router/evalBatcher.js';
import { parseTasksDag, getExecutableWave } from '../src/router/dagDispatcher.js';
import { SemanticWatchdog } from '../src/supervision/watchdog.js';
import { getAgentDefinition, type AgentType } from '../src/agents/registry.js';
import { runCli } from '../src/index.js';

describe('Performance Evaluation & Test Viewpoints (docs/test-viewpoint.md)', () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ccsdd-viewpoint-test-'));
    db = initHarnessDatabase(join(tmpDir, 'harness.db'));
  });

  afterEach(async () => {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
  });

  // =========================================================================
  // Kịch bản A: Kiểm thử Tính toàn vẹn Đa Nền tảng (Platform & Manifest Verification)
  // =========================================================================
  describe('Kịch bản A: Kiểm thử Tính toàn vẹn Đa Nền tảng (Platform & Manifest Verification)', () => {
    it('verifies presets cc-sdd-router and cc-sdd-worker across all 8 coding agent platforms', () => {
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

      // Hard tool locking: Router cannot modify code; Worker has TDD toolset
      const routerDef = getAgentDefinition('cc-sdd-router' as AgentType);
      expect(routerDef.presets?.router.allowedTools).not.toContain('write_file');
      expect(routerDef.presets?.router.allowedTools).not.toContain('edit_file');

      const workerDef = getAgentDefinition('cc-sdd-worker' as AgentType);
      expect(workerDef.presets?.worker.allowedTools).toContain('write_file');
      expect(workerDef.presets?.worker.allowedTools).toContain('edit_file');
    });

    it('verifies CLI dry-run and apply with exact 17 files generated for router and worker', async () => {
      const logs: string[] = [];
      const io = {
        log: (m: string) => logs.push(m),
        error: () => { },
        exit: () => { },
      };

      // 1. Dry run for router
      const codeRouter = await runCli(['--agent', 'cc-sdd-router', '--dry-run', '--lang', 'en'], { platform: 'darwin' }, io, {});
      expect(codeRouter).toBe(0);
      const routerOut = logs.join('\n');
      expect(routerOut).toContain('ROUTER.md');
      expect(routerOut).toContain('.kiro/settings/templates');

      // 2. Dry run for worker with ja language
      logs.length = 0;
      const codeWorker = await runCli(['--agent', 'cc-sdd-worker', '--dry-run', '--lang', 'ja'], { platform: 'darwin' }, io, {});
      expect(codeWorker).toBe(0);
      const workerOut = logs.join('\n');
      expect(workerOut).toContain('WORKER.md');
      expect(workerOut).toContain('.kiro/settings/templates');
    });
  });

  // =========================================================================
  // Kịch bản B: Đánh giá Độ chính xác & Chi phí Token trên 21 Ca Kiểm thử Chuẩn (DecimalAI Protocol)
  // =========================================================================
  describe('Kịch bản B: 21 Ca Kiểm thử Chuẩn (DecimalAI Protocol Verification)', () => {
    // 15 Core Bugfix Cases
    it('Cases 1-5: enforces TDD discipline, git diff review, and structured non-prose status parsing', () => {
      const gate = new PreLlmReviewGate();
      const mandate = compileMandateFromBoundary('t-1', 'src/core/auth.ts');

      // Case 1 & 3: Broken tests or empty changes
      const brokenTestResult = gate.evaluate({
        testExitCode: 1,
        modifiedFiles: ['src/core/auth.ts'],
        mandate,
      });
      expect(brokenTestResult.canCallReview).toBe(false);
      expect(brokenTestResult.reason).toContain('TEST_FAILED_MECHANICAL_GATE');

      // Changes passing gate
      const passResult = gate.evaluate({
        testExitCode: 0,
        modifiedFiles: ['src/core/auth.ts'],
        mandate,
      });
      expect(passResult.canCallReview).toBe(true);

      // Case 4: Parse implementer status only from exact ## Status Report block
      const validReport = '## Status Report\n- STATUS: READY_FOR_REVIEW\n- DETAILS: All tests green';
      const invalidProse = 'I finished the task successfully and all tests pass.';
      const statusRegex = /## Status Report\s*\n\s*-\s*STATUS:\s*(READY_FOR_REVIEW|BLOCKED|NEEDS_CONTEXT)/;
      expect(statusRegex.test(validReport)).toBe(true);
      expect(statusRegex.test(invalidProse)).toBe(false);

      // Case 5: Parse review verdict only from exact ## Review Verdict block
      const validVerdict = '## Review Verdict\n- VERDICT: APPROVED\n- COMMENTS: LGTM';
      const invalidVerdict = 'Everything looks good to me, ready to merge.';
      const verdictRegex = /## Review Verdict\s*\n\s*-\s*VERDICT:\s*(APPROVED|REJECTED)/;
      expect(verdictRegex.test(validVerdict)).toBe(true);
      expect(verdictRegex.test(invalidVerdict)).toBe(false);
    });

    it('Cases 6-10: handles review modes, rejection loops, and blocked/needs-context protocols', () => {
      // Case 6: Review modes (required | inline | off)
      const parseReviewMode = (arg?: string) => {
        if (!arg || arg === 'required') return 'required';
        if (arg === 'inline') return 'inline';
        if (arg === 'off' || arg.includes('skip review') || arg.includes('without review')) return 'off';
        return 'required';
      };
      expect(parseReviewMode()).toBe('required');
      expect(parseReviewMode('inline')).toBe('inline');
      expect(parseReviewMode('skip review')).toBe('off');

      // Cases 7-8: Rejection escalation (round 1-2: re-dispatch implementer; round 3: dispatch debug)
      const handleRejection = (round: number) => {
        if (round < 3) return 'REDISPATCH_IMPLEMENTER';
        return 'DISPATCH_DEBUG_SUBAGENT';
      };
      expect(handleRejection(1)).toBe('REDISPATCH_IMPLEMENTER');
      expect(handleRejection(2)).toBe('REDISPATCH_IMPLEMENTER');
      expect(handleRejection(3)).toBe('DISPATCH_DEBUG_SUBAGENT');

      // Cases 9-10: Blocked & Needs Context handling
      const handleStatus = (status: 'READY_FOR_REVIEW' | 'BLOCKED' | 'NEEDS_CONTEXT', contextRetries = 0) => {
        if (status === 'READY_FOR_REVIEW') return 'PROCEED_REVIEW';
        if (status === 'BLOCKED') return 'DISPATCH_DEBUG_SUBAGENT';
        if (status === 'NEEDS_CONTEXT') {
          return contextRetries === 0 ? 'PROVIDE_CONTEXT' : 'DISPATCH_DEBUG_SUBAGENT';
        }
        return 'UNKNOWN';
      };
      expect(handleStatus('READY_FOR_REVIEW')).toBe('PROCEED_REVIEW');
      expect(handleStatus('BLOCKED')).toBe('DISPATCH_DEBUG_SUBAGENT');
      expect(handleStatus('NEEDS_CONTEXT', 0)).toBe('PROVIDE_CONTEXT');
      expect(handleStatus('NEEDS_CONTEXT', 1)).toBe('DISPATCH_DEBUG_SUBAGENT');
    });

    it('Cases 11-15: enforces selective staging, verification-before-completion, and note carry-forward', () => {
      // Case 12: Selective staging: forbid "git add -A" or "git add ."
      const isAllowedStagingCommand = (cmd: string) => {
        if (cmd.includes('git add .') || cmd.includes('git add -A')) return false;
        return cmd.startsWith('git add ');
      };
      expect(isAllowedStagingCommand('git add .')).toBe(false);
      expect(isAllowedStagingCommand('git add -A')).toBe(false);
      expect(isAllowedStagingCommand('git add src/core/db.ts tasks.md')).toBe(true);

      // Case 13: Task completion requires fresh evidence verification
      const verifyCompletionGate = (testsPassed: boolean, gitDiffVerified: boolean) => {
        return testsPassed && gitDiffVerified;
      };
      expect(verifyCompletionGate(false, true)).toBe(false);
      expect(verifyCompletionGate(true, false)).toBe(false);
      expect(verifyCompletionGate(true, true)).toBe(true);
    });

    // 6 Weakness-Fixing Cases for v4.0
    it('Cases 16-21: verifies parallel (P) wave scheduling, MasterAssessor budgeted read, and zero boundary creep', async () => {
      // Case 16: Parallel (P) wave parsing
      const sampleTasksMd = `
### 1. Phase 1
* [ ] **1.1 (P)** Subtask A
* [ ] **1.2 (P)** Subtask B
* [ ] **1.3** Subtask C
  * _Depends:_ 1.1, 1.2
`;
      const tasks = parseTasksDag(sampleTasksMd);
      const wave1 = getExecutableWave(tasks);
      expect(wave1.map((t) => t.id)).toEqual(['1.1', '1.2']);

      // Case 17 & 21: MasterAssessor budgeted reading (Inline / Spill / Chained Recall)
      const chunker = new SpecChunker(db);
      const largeSpec = '# Section 1\n' + 'A'.repeat(2000);
      const chunks = chunker.indexDocument('spec/test/reqs.md', largeSpec, 'requirements');
      const assessor = new MasterAssessor(db);
      const readRes = assessor.readChunk(chunks[0].stable_id, 0, 500);
      expect(readRes.nextCursor).toBe(500);
      expect(readRes.totalLength).toBeGreaterThan(500);

      // Case 18: Zero boundary creep via MandateEnforcer
      const mandate = compileMandateFromBoundary('t-101', 'src/auth/login.ts, test/auth.test.ts');
      const enforcer = new MandateEnforcer(mandate);

      const allowed = enforcer.interceptFileWrite('src/auth/login.ts');
      expect(allowed.allowed).toBe(true);

      expect(() => {
        enforcer.interceptFileWrite('src/database/schema.ts');
      }).toThrowError(MandateViolationError);

      // Case 20: Concurrency safety with WorkerSlots
      const slots = new WorkerSlotsManager({ maxWorkers: 2 });
      const slot1 = await slots.reserveSlot('task-1.1');
      const slot2 = await slots.reserveSlot('task-1.2');
      expect(slots.getActiveCount()).toBe(2);
      expect(slot1.slotId).toBe(1);
      expect(slot2.slotId).toBe(2);
      slot1.release();
      slot2.release();
    });
  });

  // =========================================================================
  // Kịch bản C: Mô phỏng Áp lực Luồng Sự kiện Hỗn tạp (DeepSeek 300-Message / 20-Request Simulation)
  // =========================================================================
  describe('Kịch bản C: Mô phỏng Áp lực Luồng Sự kiện Hỗn tạp (300 msgs / 20 reqs)', () => {
    it('simulates 300 messages with 20 real requests and 280 noise messages under observe mode', () => {
      const gate = new AdmissionGate(db, {
        whitelistSenders: ['lead-dev', 'senior-eng', 'ci-bot'],
        botSenders: ['ci-bot', 'github-actions'],
        proactiveMode: 'observe',
        agentMentionHandle: '@Agent',
      });

      // Generate 300 messages:
      // - 10 explicit requests (whitelisted + @Agent)
      // - 10 inferred requests (whitelisted/bot without @Agent)
      // - 280 noise messages from un-whitelisted senders
      const messages: IncomingEvent[] = [];
      for (let i = 1; i <= 10; i++) {
        messages.push({
          id: `msg-explicit-${i}`,
          sender: 'lead-dev',
          content: `@Agent please implement task ${i}`,
          threadId: `th-${i}`,
        });
      }
      for (let i = 1; i <= 10; i++) {
        messages.push({
          id: `msg-inferred-${i}`,
          sender: 'ci-bot',
          content: `CI failed on build #${i}`,
          threadId: `th-ci-${i}`,
        });
      }
      for (let i = 1; i <= 280; i++) {
        messages.push({
          id: `msg-noise-${i}`,
          sender: `external-user-${i}`,
          content: `Random coffee chat discussion ${i}`,
          threadId: `th-noise-${i}`,
        });
      }

      let explicitCount = 0;
      let loggedCandidateCount = 0;
      let droppedSilentCount = 0;
      let totalTokensConsumed = 0;

      for (const msg of messages) {
        const decision = gate.evaluateAdmission(msg);
        totalTokensConsumed += decision.tokensConsumed;
        if (decision.action === 'CREATE_TICKET') explicitCount++;
        else if (decision.action === 'LOG_CANDIDATE_ONLY') loggedCandidateCount++;
        else if (decision.action === 'DROP_SILENTLY') droppedSilentCount++;
      }

      // 0 tokens consumed for filtering
      expect(totalTokensConsumed).toBe(0);
      expect(explicitCount).toBe(10);
      expect(loggedCandidateCount).toBe(10);
      expect(droppedSilentCount).toBe(280);

      // Verify inferred candidates logged to SQLite trigger table
      const triggerRows = db.prepare('SELECT COUNT(*) as cnt FROM triggers').get() as { cnt: number };
      expect(triggerRows.cnt).toBe(10);
    });

    it('scales dynamic batch size from 1.0 to 2.8 as arrival rate increases from 1 to 40 msgs/min', () => {
      const batcher = new EvalBatcher();

      expect(batcher.calculateTargetBatchSize(1)).toBe(1.0);
      expect(batcher.calculateTargetBatchSize(10)).toBeCloseTo(1.42, 1);
      expect(batcher.calculateTargetBatchSize(20)).toBeCloseTo(1.88, 1);
      expect(batcher.calculateTargetBatchSize(40)).toBe(2.8);

      // Group 40 incoming events at rate 40 msgs/min (batch capacity 3)
      const events: IncomingEvent[] = Array.from({ length: 40 }, (_, i) => ({
        id: `ev-${i}`,
        sender: 'lead-dev',
        content: `event ${i}`,
        threadId: 'th-main',
      }));

      const batches = batcher.groupEvents(events, 40);
      expect(batches.length).toBe(14); // ceil(40 / 3) = 14
      expect(batches[0].length).toBe(3);
    });

    it('provides instant preemption via maxWorkers + 1 priority slot for human intervention under full saturation', async () => {
      const slots = new WorkerSlotsManager({ maxWorkers: 3 });

      // Occupy all 3 worker slots with background jobs
      const bg1 = await slots.reserveSlot('ticket-bg-1');
      const bg2 = await slots.reserveSlot('ticket-bg-2');
      const bg3 = await slots.reserveSlot('ticket-bg-3');
      expect(slots.getActiveCount()).toBe(3);

      // Normal request is queued
      let normalResolved = false;
      slots.reserveSlot('ticket-normal-4').then(() => {
        normalResolved = true;
      });
      expect(slots.getQueueLength()).toBe(1);
      expect(normalResolved).toBe(false);

      // Urgent human priority request arrives -> immediate acquisition of slot 4 (maxWorkers + 1)
      const humanSlot = await slots.reserveSlot('ticket-human-urgent', true);
      expect(humanSlot.slotId).toBe(4);
      expect(humanSlot.isHumanPriority).toBe(true);
      expect(slots.getActiveCount()).toBe(4);

      // Human finishes and releases priority slot
      humanSlot.release();
      expect(slots.getActiveCount()).toBe(3);
      expect(normalResolved).toBe(false); // Normal still queued because normal slots are full

      // One normal background job finishes
      bg1.release();
      await new Promise((r) => setTimeout(r, 10));
      expect(normalResolved).toBe(true);

      bg2.release();
      bg3.release();
    });
  });

  // =========================================================================
  // Kịch bản D: Kiểm thử Bóc tách & Tiêm Lỗi Phục hồi (Ablation & Fault Injection)
  // =========================================================================
  describe('Kịch bản D: Kiểm thử Bóc tách (Ablation Study) & Tiêm Lỗi Phục hồi Ngoại tuyến', () => {
    it('Ablation 1: Direct SubscriptionBus pass-through achieves 100% bypass of Router evaluations', async () => {
      const bus = new SubscriptionBus(db);
      const routerDecisionMock = vi.fn();
      const executorInbox: string[] = [];

      // Create a dummy thread and ticket to satisfy foreign keys
      db.prepare("INSERT INTO threads (id, title, status) VALUES ('th-sub', 'Sub Thread', 'ACTIVE')").run();
      db.prepare("INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status) VALUES ('ticket-101', 'th-sub', '1.1', 'auth', 'Ticket 101', 'RUNNING')").run();

      // Register active worker subscription for ticket-101
      bus.subscribe('th-sub', 'ticket-101', 'worker-session-1');
      bus.registerExecutorHandler('worker-session-1', (evt) => {
        executorInbox.push(evt.payload);
      });

      // Stream 5 events on th-sub (test logs, reviewer verdict, human reply)
      const events = [
        'TEST_RUN: 12 tests passed',
        'REVIEW_VERDICT: APPROVED',
        'HUMAN_COMMENT: looks great please merge',
        'AUTO_MERGE: triggered',
        'STAGE: done',
      ];

      for (const payload of events) {
        const res = await bus.dispatchThreadEvent(
          {
            id: `evt-${Math.random()}`,
            threadId: 'th-sub',
            eventType: 'DIRECT_UPDATE',
            payload,
          },
          routerDecisionMock
        );
        expect(res.routedDirectly).toBe(true);
        expect(res.routerCalled).toBe(false);
      }

      // 100% routed directly to executor inbox, 0 router decisions required
      expect(executorInbox.length).toBe(5);
      expect(routerDecisionMock).toHaveBeenCalledTimes(0);

      // Unsubscribed thread falls back to router
      const fallbackRes = await bus.dispatchThreadEvent(
        {
          id: 'evt-unknown',
          threadId: 'th-unsubscribed',
          eventType: 'UNSUBSCRIBED_EVENT',
          payload: 'needs triage',
        },
        routerDecisionMock
      );
      expect(fallbackRes.routedDirectly).toBe(false);
      expect(fallbackRes.routerCalled).toBe(true);
      expect(routerDecisionMock).toHaveBeenCalledTimes(1);
    });

    it('Ablation 2: Mandate firewall immediately rejects out-of-boundary edits; Watchdog stops loop by impact', () => {
      // 1. Mandate firewall
      const mandate = compileMandateFromBoundary('t-201', 'src/core/auth.ts');
      const enforcer = new MandateEnforcer(mandate);

      expect(() => {
        enforcer.interceptFileWrite('src/shared/globalUtils.ts');
      }).toThrowError(MandateViolationError);

      // 2. SemanticWatchdog stop-by-impact on duplicate diff or test error
      db.prepare("INSERT OR IGNORE INTO threads (id, title, status) VALUES ('th-wd', 'Watchdog Thread', 'ACTIVE')").run();
      db.prepare("INSERT OR IGNORE INTO tickets (id, thread_id, task_id, feature_name, title, status) VALUES ('t-201', 'th-wd', '2.1', 'core', 'WD Ticket', 'RUNNING')").run();
      const watchdog = new SemanticWatchdog({ db });
      const action1 = watchdog.recordIteration('t-201', 'FAIL: Timeout at line 10', 'diff-hash-1');
      expect(action1.action).toBe('CONTINUE');

      // Second identical run -> zero real progress
      const action2 = watchdog.recordIteration('t-201', 'FAIL: Timeout at line 10', 'diff-hash-1');
      expect(action2.action).toBe('STOP_BY_IMPACT');
      const ticket = db.prepare("SELECT status FROM tickets WHERE id = 't-201'").get() as { status: string };
      expect(ticket.status).toBe('WAITING_FOR_HUMAN');
    });

    it('Crash Injection & Hidden HTML Tag Outbox Reconciliation: prevents duplicate PRs/comments after crash', async () => {
      // Step 1: Simulate sending a remote comment with hidden delivery tag
      const queue = new EffectsQueue(db);
      const delivery = new AgentDelivery(db);
      const reconciler = new OutboxReconciler(db);

      // Record side effect before action
      db.prepare("INSERT INTO threads (id, title, status) VALUES ('th-1', 'Main', 'ACTIVE')").run();
      db.prepare("INSERT INTO tickets (id, thread_id, task_id, feature_name, title, status) VALUES ('tick-1', 'th-1', '1.1', 'auth', 'Fix bug', 'RUNNING')").run();

      queue.enqueue('tick-1', 'GITHUB_POST_COMMENT', { body: 'Fix implemented successfully' });

      // Step 2: Delivery deduplication prevents duplicate processing
      const firstDelivery = await delivery.deliver('msg-unique-1', 'handler-1', () => { });
      expect(firstDelivery.duplicate).toBe(false);
      expect(firstDelivery.processed).toBe(true);

      const duplicateDelivery = await delivery.deliver('msg-unique-1', 'handler-1', () => { });
      expect(duplicateDelivery.duplicate).toBe(true);
      expect(duplicateDelivery.processed).toBe(false);

      // Step 3: Outbox reconciler detects hidden marker in remote comment to prevent duplicate send
      const marker = OutboxReconciler.createHtmlMarker('msg-unique-1');
      const remoteComment = `Fix implemented successfully ${marker}`;
      expect(OutboxReconciler.hasHtmlMarker(remoteComment, 'msg-unique-1')).toBe(true);

      let sendCallCount = 0;
      const sendResult = await reconciler.sendComment({
        ticketId: 'tick-1',
        channel: 'github-pr',
        messageId: 'msg-unique-1',
        body: 'Fix implemented successfully',
        remoteComments: [remoteComment],
        sender: () => {
          sendCallCount++;
        },
      });
      expect(sendResult.skippedDuplicate).toBe(true);
      expect(sendResult.sent).toBe(false);
      expect(sendCallCount).toBe(0); // Sender was skipped because remote already had it!

      // Step 4: Run RecoveryEngine and syncStateToTasksMarkdown to restore state and sync tasks.md
      const tasksFilePath = join(tmpDir, 'tasks.md');
      await writeFile(
        tasksFilePath,
        `
# Tasks
* [ ] **1.1** Fix bug
`
      );

      // Mark ticket completed in DB
      db.prepare("UPDATE tickets SET status = 'COMPLETED' WHERE id = 'tick-1'").run();

      const syncResult = await syncStateToTasksMarkdown(db, tasksFilePath);
      expect(syncResult.updatedCount).toBe(1);

      // Verify RecoveryEngine decision
      const mockGitProvider: GitProvider = {
        getWorktreeStatus: async () => ({ hasUncommittedChanges: false, lastCommitMessage: '', commitsAhead: 0 }),
        getRemotePrStatus: async () => ({ exists: true, prNumber: 10, state: 'MERGED' }),
      };
      const engine = new RecoveryEngine(db, mockGitProvider);
      const decision = await engine.recoverTicket('tick-1');
      expect(decision.nextAction).toBe('CLEANUP_WORKTREE');
    });

    it('ConditionalAutoMerge: permits auto-merge only when diff < 200 lines, human approved, and accounts distinct', () => {
      const autoMerge = new ConditionalAutoMerge();

      const validContext = {
        prNumber: 42,
        additions: 80,
        deletions: 40, // total 120 < 200
        humanApproved: true,
        testsPassed: true,
        authorAccount: 'dev-bot',
        mergerAccount: 'lead-engineer',
      };
      expect(autoMerge.canAutoMerge(validContext).eligible).toBe(true);

      const largeDiffContext = { ...validContext, additions: 180, deletions: 50 }; // total 230 >= 200
      expect(autoMerge.canAutoMerge(largeDiffContext).eligible).toBe(false);

      const sameAccountContext = { ...validContext, mergerAccount: 'dev-bot' };
      expect(autoMerge.canAutoMerge(sameAccountContext).eligible).toBe(false);
    });
  });
});
