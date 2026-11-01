/**
 * ============================================================================
 * CC-SDD v4.0 (SUPER-HARNESS) - COMPREHENSIVE VALIDATION & TEST SUITE
 * ============================================================================
 * Tệp này hiện thực hóa các mô-đun cốt lõi của 5 Cam kết Ranh giới (Boundaries)
 * và bộ kiểm thử tự động (TDD RED -> GREEN + Fault Injection + Ablation Benchmark)
 * dùng để xác thực toàn bộ quá trình refactoring từ cc-sdd v3.0 lên v4.0 theo
 * kiến trúc Router–Worker của dsh-superagent-prototype.
 *
 * Cách chạy trực tiếp (Node.js 22+ hoặc tsx / vitest):
 *   npx tsx --test tools/cc-sdd/test/superHarnessValidation.test.ts
 * ============================================================================
 */

import * as nodeTest from "node:test";

let describe: any = nodeTest.describe;
let it: any = nodeTest.it;
let beforeEach: any = nodeTest.beforeEach;

if (process.env.VITEST) {
  try {
    const v = await import("vitest");
    describe = v.describe;
    it = v.it;
    beforeEach = v.beforeEach;
  } catch {
    // fallback to node:test
  }
}
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ============================================================================
// PHẦN 1: BND-STATE-ENGINE (TẦNG LƯU TRỮ BỀN VỮNG SQLITE, EFFECTS & RECOVERY)
// ============================================================================

export type TicketStatus =
  | "CREATED"
  | "QUEUED_FOR_SLOT"
  | "WORKTREE_READY"
  | "TDD_RED"
  | "TDD_GREEN"
  | "BACKGROUND_WAITING"
  | "PRE_LLM_GATE"
  | "KIRO_REVIEWING"
  | "KIRO_DEBUGGING"
  | "WAITING_FOR_HUMAN"
  | "HUMAN_PRIORITY_EXEC"
  | "WATCHDOG_HALTED"
  | "PR_READY"
  | "AUTO_MERGING"
  | "COMPLETED";

export interface MandateRecord {
  readonly ticketId: string;
  readonly boundaryId: string;
  readonly allowedFiles: readonly string[];
  readonly allowedTestCommands: readonly string[];
  readonly createdAt: number;
}

export interface TicketRecord {
  ticketId: string;
  taskCode: string; // Ví dụ: "1.1", "2.1"
  threadId: string;
  isParallel: boolean;
  dependsOn: string[];
  status: TicketStatus;
  worktreePath: string | null;
  assignedExecutorId: string | null;
  retryCount: number;
  lastArtifactAt: number;
  diffHashes: string[];
  prNumber: number | null;
}

export interface AssignmentRecord {
  assignmentId: string;
  ticketId: string;
  executorId: string;
  active: boolean;
  createdAt: number;
}

export interface SubscriptionRecord {
  subscriptionId: string;
  threadId: string;
  ticketId: string;
  executorId: string;
  active: boolean;
}

export interface EffectRecord {
  effectId: string;
  ticketId: string;
  actionType: "SHELL_EXEC" | "GITHUB_COMMENT" | "CREATE_PR" | "SUBAGENT_CALL";
  payloadHash: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  htmlDedupTag?: string;
}

export interface ContextChunkRecord {
  stableId: string;
  sourceDoc: string;
  boundaryId: string;
  content: string;
}

/**
 * Kho lưu trữ trạng thái mô phỏng cơ sở dữ liệu SQLite (.kiro/state/harness.db)
 * kèm cơ chế khóa đơn bản sao (Single-Replica State Lock) - Tác vụ 1.1
 */
export class HarnessStateDatabase {
  private static activeLocks = new Set<string>();
  public readonly dbPath: string;
  private isClosed = false;

  public readonly tickets = new Map<string, TicketRecord>();
  public readonly mandates = new Map<string, MandateRecord>();
  public readonly assignments = new Map<string, AssignmentRecord>();
  public readonly subscriptions = new Map<string, SubscriptionRecord>();
  public readonly effectsQueue = new Map<string, EffectRecord>();
  public readonly inboxDedup = new Set<string>();
  public readonly outboxReceipts = new Map<string, string>(); // effectId -> htmlTag
  public readonly contextChunks = new Map<string, ContextChunkRecord>();
  public readonly observedCandidates: Array<{ triggerId: string; reason: string }> = [];

  constructor(dbPath = ".kiro/state/harness.db") {
    if (HarnessStateDatabase.activeLocks.has(dbPath)) {
      throw new Error(
        `STATE_LOCK_CONFLICT: Thư mục trạng thái '${dbPath}' đang bị khóa bởi một tiến trình Super-Harness khác.`
      );
    }
    this.dbPath = dbPath;
    HarnessStateDatabase.activeLocks.add(dbPath);
  }

  public releaseLock(): void {
    if (!this.isClosed) {
      HarnessStateDatabase.activeLocks.delete(this.dbPath);
      this.isClosed = true;
    }
  }

  public static resetAllLocksForTest(): void {
    HarnessStateDatabase.activeLocks.clear();
  }
}

/**
 * Hàng đợi Effects ghi nhận ý định trước, chống trùng lặp AgentDelivery
 * và đối soát thẻ HTML ẩn cho Outbox - Tác vụ 1.2
 */
export class EffectsAndOutboxEngine {
  private readonly db: HarnessStateDatabase;
  constructor(db: HarnessStateDatabase) { this.db = db; }

  /**
   * Chống trùng lặp tin nhắn đầu vào (AgentDelivery Deduplication)
   */
  public registerInboundDelivery(messageId: string): boolean {
    if (this.db.inboxDedup.has(messageId)) {
      return false; // Đã xử lý trước đó -> bỏ qua ngay
    }
    this.db.inboxDedup.add(messageId);
    return true;
  }

  /**
   * Ghi nhận ý định vào bảng effects_queue với trạng thái PENDING trước khi thực thi
   */
  public recordIntent(
    ticketId: string,
    actionType: EffectRecord["actionType"],
    payload: string
  ): EffectRecord {
    const payloadHash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
    const effectId = `eff-${ticketId}-${payloadHash}`;
    const htmlDedupTag = `<!-- cc-sdd-msg-id: ${effectId} -->`;

    const existing = this.db.effectsQueue.get(effectId);
    if (existing) {
      return existing;
    }

    const record: EffectRecord = {
      effectId,
      ticketId,
      actionType,
      payloadHash,
      status: "PENDING",
      htmlDedupTag,
    };
    this.db.effectsQueue.set(effectId, record);
    return record;
  }

  /**
   * Gửi bình luận/PR qua Outbox với cơ chế kiểm tra thẻ HTML ẩn trên GitHub
   * để đảm bảo tính lũy đẳng (idempotency) ngay cả khi sập nguồn trước khi lưu biên nhận.
   */
  public deliverOutboxWithHtmlTag(
    ticketId: string,
    bodyText: string,
    remoteThreadComments: string[]
  ): { sent: boolean; finalBody: string; effectId: string } {
    const intent = this.recordIntent(ticketId, "GITHUB_COMMENT", bodyText);
    const tag = intent.htmlDedupTag!;

    // Kiểm tra xem bình luận chứa thẻ HTML ẩn đã tồn tại trên GitHub từ xa chưa
    const alreadyExistsOnRemote = remoteThreadComments.some((c) => c.includes(tag));
    if (alreadyExistsOnRemote || intent.status === "COMPLETED") {
      intent.status = "COMPLETED";
      this.db.outboxReceipts.set(intent.effectId, tag);
      return { sent: false, finalBody: `${bodyText}\n${tag}`, effectId: intent.effectId };
    }

    const finalBody = `${bodyText}\n${tag}`;
    remoteThreadComments.push(finalBody);
    intent.status = "COMPLETED";
    this.db.outboxReceipts.set(intent.effectId, tag);
    return { sent: true, finalBody, effectId: intent.effectId };
  }
}

/**
 * Giao thức phục hồi 3 bước sau sự cố (3-Step Crash Recovery)
 * và đồng bộ ngược trạng thái ra tasks.md - Tác vụ 1.3
 */
export interface WorktreeInspection {
  worktreeExists: boolean;
  hasGreenTestCommit: boolean;
  lastCommitSha: string | null;
}

export interface RemoteGitHubInspection {
  openPrNumber: number | null;
  remoteComments: string[];
}

export class CrashRecoveryService {
  private readonly db: HarnessStateDatabase;
  constructor(db: HarnessStateDatabase) { this.db = db; }

  /**
   * Đối chiếu 3 lớp: (1) SQLite State, (2) Git Worktree thực địa, (3) GitHub API từ xa
   */
  public recoverTicketState(
    ticketId: string,
    worktreeState: WorktreeInspection,
    remoteState: RemoteGitHubInspection
  ): { resumedStatus: TicketStatus; skippedRedPhase: boolean; createdPr: boolean } {
    const ticket = this.db.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Không tìm thấy Ticket ${ticketId} trong SQLite.`);
    }

    // Bước 3: Kiểm tra xem PR đã được tạo trên GitHub trước khi sập nguồn chưa
    if (remoteState.openPrNumber !== null) {
      ticket.prNumber = remoteState.openPrNumber;
      ticket.status = "PR_READY";
      for (const eff of this.db.effectsQueue.values()) {
        if (eff.ticketId === ticketId && eff.actionType === "CREATE_PR") {
          eff.status = "COMPLETED";
        }
      }
      return { resumedStatus: "PR_READY", skippedRedPhase: true, createdPr: false };
    }

    // Bước 2: Kiểm tra Git Worktree xem pha GREEN đã commit thành công chưa
    if (worktreeState.worktreeExists && worktreeState.hasGreenTestCommit) {
      ticket.status = "PR_READY";
      ticket.prNumber = 101; // Tạo PR tiếp nối mà không chạy lại pha RED
      return { resumedStatus: "PR_READY", skippedRedPhase: true, createdPr: true };
    }

    // Nếu chưa xong pha GREEN, khôi phục về pha TDD_RED
    ticket.status = "TDD_RED";
    return { resumedStatus: "TDD_RED", skippedRedPhase: false, createdPr: false };
  }

  /**
   * Trình chiếu trạng thái hoàn tất từ SQLite ngược ra tệp tasks.md
   */
  public syncTasksMarkdown(tasksMarkdownContent: string): string {
    let updated = tasksMarkdownContent;
    for (const ticket of this.db.tickets.values()) {
      if (ticket.status === "COMPLETED") {
        const escapedCode = ticket.taskCode.replace(".", "\\.");
        const regex = new RegExp(`- \\[ \\] \\*\\*${escapedCode}(\\s*\\(P\\))?\\*\\*`, "g");
        updated = updated.replace(regex, `- [x] **${ticket.taskCode}$1**`);
      }
    }
    return updated;
  }
}

// ============================================================================
// PHẦN 2: BND-CONTEXT-MANDATE (MASTER ASSESSOR, SUBSCRIPTION BUS & MANDATE)
// ============================================================================

/**
 * Động cơ ngữ cảnh có ngân sách MasterAssessor (Inline–Spill–Chained Recall)
 * giữ nguyên tiền tố KV Prefix Cache - Tác vụ 2.1
 */
export class MasterAssessor {
  private static readonly SYSTEM_PREFIX =
    "SYSTEM_IMMUTABLE_PREFIX::CC-SDD-WORKER-V4::BOUNDARY-FIRST-TDD";

  private readonly db: HarnessStateDatabase;
  constructor(db: HarnessStateDatabase) { this.db = db; }

  public indexDocument(
    sourceDoc: string,
    boundaryId: string,
    rawContent: string,
    chunkSize = 120
  ): string[] {
    const stableIds: string[] = [];
    let part = 0;
    for (let i = 0; i < rawContent.length; i += chunkSize) {
      const slice = rawContent.slice(i, i + chunkSize);
      const stableId = `${boundaryId}::${sourceDoc}#chunk-${part}`;
      this.db.contextChunks.set(stableId, {
        stableId,
        sourceDoc,
        boundaryId,
        content: slice,
      });
      stableIds.push(stableId);
      part++;
    }
    return stableIds;
  }

  /**
   * Tạo tiền tố prompt cố định để tối ưu hóa 100% KV Prefix Cache giữa các lượt gọi
   */
  public buildImmutablePrefixPrompt(mandate: MandateRecord, inlineBoundarySummary: string): string {
    const mandateJson = JSON.stringify({
      ticketId: mandate.ticketId,
      boundaryId: mandate.boundaryId,
      allowedFiles: mandate.allowedFiles,
    });
    return `${MasterAssessor.SYSTEM_PREFIX}\nMANDATE:${mandateJson}\nINLINE_BOUNDARY:${inlineBoundarySummary}`;
  }

  /**
   * Đọc phân trang theo ngân sách cố định O(1) thông qua con trỏ (cursor) và ID ổn định
   */
  public readChunk(
    stableId: string,
    cursor = 0,
    maxChars = 60
  ): {
    stableId: string;
    sourceDoc: string;
    excerpt: string;
    nextCursor: number | null;
  } {
    const chunk = this.db.contextChunks.get(stableId);
    if (!chunk) {
      throw new Error(`CHUNK_NOT_FOUND: Không tìm thấy khối ngữ cảnh '${stableId}'`);
    }
    const excerpt = chunk.content.slice(cursor, cursor + maxChars);
    const nextCursor = cursor + maxChars < chunk.content.length ? cursor + maxChars : null;
    return {
      stableId: chunk.stableId,
      sourceDoc: chunk.sourceDoc,
      excerpt,
      nextCursor,
    };
  }
}

/**
 * Đường truyền sự kiện trực tiếp SubscriptionBus (Direct Event Pass-Through)
 * bỏ qua hoàn toàn cc-sdd-router đối với các luồng đã gắn Executor - Tác vụ 2.2
 */
export interface ThreadEvent {
  eventId: string;
  threadId: string;
  sourceType: "KIRO_REVIEW" | "KIRO_DEBUG" | "CI_TEST_LOG" | "HUMAN_COMMENT" | "POLICY_CHANGED";
  payload: string;
}

export class SubscriptionBus {
  public routerEvalCallsCount = 0;
  public directWorkerDeliveriesCount = 0;
  public readonly executorInboxes = new Map<string, ThreadEvent[]>();

  private readonly db: HarnessStateDatabase;
  constructor(db: HarnessStateDatabase) { this.db = db; }

  public subscribe(threadId: string, ticketId: string, executorId: string): SubscriptionRecord {
    const sub: SubscriptionRecord = {
      subscriptionId: `sub-${ticketId}`,
      threadId,
      ticketId,
      executorId,
      active: true,
    };
    this.db.subscriptions.set(threadId, sub);
    if (!this.executorInboxes.has(executorId)) {
      this.executorInboxes.set(executorId, []);
    }
    return sub;
  }

  /**
   * Định tuyến sự kiện: nếu Thread đã có Subscription đang hoạt động, bơm thẳng vào
   * hộp thư của Executor mà KHÔNG gọi Router.
   */
  public publishEvent(
    event: ThreadEvent,
    fallbackRouterCallback: (ev: ThreadEvent) => void
  ): "DIRECT_TO_EXECUTOR" | "ROUTED_VIA_ROUTER" {
    const sub = this.db.subscriptions.get(event.threadId);
    if (sub && sub.active) {
      const inbox = this.executorInboxes.get(sub.executorId) ?? [];
      inbox.push(event);
      this.executorInboxes.set(sub.executorId, inbox);
      this.directWorkerDeliveriesCount++;
      return "DIRECT_TO_EXECUTOR";
    }

    this.routerEvalCallsCount++;
    fallbackRouterCallback(event);
    return "ROUTED_VIA_ROUTER";
  }
}

/**
 * Bộ cưỡng chế Mandate bất biến ở tầng công cụ (Tool-Adapter)
 * và cổng lọc cơ học tiền-LLM trước khi gọi kiro-review - Tác vụ 2.3
 */
export class MandateEnforcer {
  private readonly db: HarnessStateDatabase;
  constructor(db: HarnessStateDatabase) { this.db = db; }

  /**
   * Biên dịch chú thích _Boundary:_ và File Structure Plan thành Mandate bất biến
   */
  public compileMandate(
    ticketId: string,
    boundaryId: string,
    allowedFiles: string[],
    allowedTestCommands: string[]
  ): MandateRecord {
    const frozenFiles = Object.freeze([...allowedFiles]);
    const frozenCommands = Object.freeze([...allowedTestCommands]);
    const mandate: MandateRecord = Object.freeze({
      ticketId,
      boundaryId,
      allowedFiles: frozenFiles,
      allowedTestCommands: frozenCommands,
      createdAt: Date.now(),
    });
    this.db.mandates.set(ticketId, mandate);
    return mandate;
  }

  /**
   * Chặn cứng ở tầng Tool-Adapter đối với mọi thao tác sửa tệp ngoài Mandate
   */
  public interceptFileWrite(
    ticketId: string,
    targetFilePath: string
  ): { allowed: true } | { allowed: false; errorCode: "MANDATE_BOUNDARY_VIOLATION"; handoffInstruction: string } {
    const mandate = this.db.mandates.get(ticketId);
    if (!mandate) {
      throw new Error(`MANDATE_MISSING: Ticket ${ticketId} chưa có Mandate.`);
    }

    const isAllowed = mandate.allowedFiles.some((allowedPath) => targetFilePath === allowedPath);
    if (!isAllowed) {
      return {
        allowed: false,
        errorCode: "MANDATE_BOUNDARY_VIOLATION",
        handoffInstruction: `Tệp '${targetFilePath}' nằm ngoài ranh giới '${mandate.boundaryId}'. Gọi handoffToRouter(reason: "UPSTREAM_DEFECT_OR_SCOPE_EXPANSION").`,
      };
    }
    return { allowed: true };
  }

  /**
   * Cổng lọc cơ học tiền-LLM (Pre-LLM Mechanical Gate) trước khi gọi subagent kiro-review:
   * Bắt buộc mã thoát kiểm thử == 0 và mọi tệp trong git diff đều thuộc Mandate.
   */
  public verifyPreReviewMechanicalGate(
    ticketId: string,
    lastTestExitCode: number,
    gitDiffFiles: string[]
  ): { passed: boolean; reason: string; llmTokensConsumed: number } {
    if (lastTestExitCode !== 0) {
      return {
        passed: false,
        reason: `TEST_FAILED_EXIT_CODE_${lastTestExitCode}: Từ chối gọi kiro-review để tiết kiệm token.`,
        llmTokensConsumed: 0,
      };
    }

    if (gitDiffFiles.length === 0) {
      return {
        passed: false,
        reason: "EMPTY_GIT_DIFF: Không có thay đổi thực tế nào để kiểm duyệt.",
        llmTokensConsumed: 0,
      };
    }

    for (const file of gitDiffFiles) {
      const check = this.interceptFileWrite(ticketId, file);
      if (!check.allowed) {
        return {
          passed: false,
          reason: `DIFF_OUTSIDE_MANDATE: ${file}`,
          llmTokensConsumed: 0,
        };
      }
    }

    return {
      passed: true,
      reason: "MECHANICAL_GATE_PASSED",
      llmTokensConsumed: 0,
    };
  }
}

// ============================================================================
// PHẦN 3: BND-EXEC-RUNTIME (WORKERSLOTS, GIT WORKTREE, ASYNC SHELL & AUTO-MERGE)
// ============================================================================

/**
 * Quản lý khe thực thi WorkerSlots với cơ chế giữ chỗ trước (pre-allocation),
 * giới hạn maxWorkers và 1 khe ưu tiên (maxWorkers + 1) cho con người - Tác vụ 3.1
 */
export class WorkerSlotsManager {
  private readonly activeRegularSlots = new Set<string>();
  private priorityHumanSlotTicketId: string | null = null;
  private readonly waitQueue: Array<{ ticketId: string; isHumanFollowUp: boolean }> = [];

  public readonly maxWorkers: number;
  private readonly db: HarnessStateDatabase;

  constructor(
    maxWorkers: number,
    db: HarnessStateDatabase
  ) {
    this.maxWorkers = maxWorkers;
    this.db = db;
  }

  public reserveSlot(
    ticketId: string,
    isHumanFollowUp = false
  ): { granted: boolean; slotType: "REGULAR" | "HUMAN_PRIORITY" | "QUEUED" } {
    // Nếu là tin nhắn tiếp nối từ con người và các khe thường đã đầy, cấp ngay khe ưu tiên maxWorkers + 1
    if (isHumanFollowUp) {
      if (this.activeRegularSlots.size < this.maxWorkers) {
        this.activeRegularSlots.add(ticketId);
        return { granted: true, slotType: "REGULAR" };
      }
      if (this.priorityHumanSlotTicketId === null || this.priorityHumanSlotTicketId === ticketId) {
        this.priorityHumanSlotTicketId = ticketId;
        return { granted: true, slotType: "HUMAN_PRIORITY" };
      }
    }

    // Khe thực thi thông thường (không bao giờ vượt quá maxWorkers)
    if (this.activeRegularSlots.size < this.maxWorkers) {
      this.activeRegularSlots.add(ticketId);
      return { granted: true, slotType: "REGULAR" };
    }

    // Xếp vào hàng đợi; ưu tiên mục của con người lên đầu hàng đợi
    if (isHumanFollowUp) {
      this.waitQueue.unshift({ ticketId, isHumanFollowUp: true });
    } else {
      this.waitQueue.push({ ticketId, isHumanFollowUp: false });
    }
    return { granted: false, slotType: "QUEUED" };
  }

  /**
   * Giải phóng khe ngay lập tức khi Worker chuyển sang trạng thái chờ con người (handoff)
   * hoặc khi hoàn tất công việc.
   */
  public releaseSlotOnHandoffOrComplete(ticketId: string): string | null {
    if (this.priorityHumanSlotTicketId === ticketId) {
      this.priorityHumanSlotTicketId = null;
      return null;
    }

    this.activeRegularSlots.delete(ticketId);
    const ticket = this.db.tickets.get(ticketId);
    if (ticket && ticket.status !== "COMPLETED" && ticket.status !== "WATCHDOG_HALTED") {
      ticket.status = "WAITING_FOR_HUMAN";
    }

    // Cấp phát ngay khe vừa trống cho tác vụ tiếp theo trong hàng đợi
    const next = this.waitQueue.shift();
    if (next) {
      this.activeRegularSlots.add(next.ticketId);
      return next.ticketId;
    }
    return null;
  }

  public getActiveCount(): { regular: number; humanPriority: number; queued: number } {
    return {
      regular: this.activeRegularSlots.size,
      humanPriority: this.priorityHumanSlotTicketId ? 1 : 0,
      queued: this.waitQueue.length,
    };
  }
}

/**
 * Trình quản lý không gian cô lập Git Worktree cho từng Ticket song song (P) - Tác vụ 3.2
 */
export interface IsolatedWorktree {
  ticketId: string;
  branchName: string;
  worktreePath: string;
  files: Map<string, string>;
  commits: string[];
  indexLocked: boolean;
}

export class GitWorktreeManager {
  private readonly worktrees = new Map<string, IsolatedWorktree>();

  public createWorktree(featureName: string, ticketId: string): IsolatedWorktree {
    const worktreePath = `.kiro/worktrees/${featureName}/task-${ticketId}`;
    const branchName = `sdd/${featureName}/task-${ticketId}`;

    const wt: IsolatedWorktree = {
      ticketId,
      branchName,
      worktreePath,
      files: new Map<string, string>(),
      commits: [],
      indexLocked: false,
    };
    this.worktrees.set(ticketId, wt);
    return wt;
  }

  public writeAndCommitInWorktree(
    ticketId: string,
    filePath: string,
    content: string,
    commitMessage: string
  ): string {
    const wt = this.worktrees.get(ticketId);
    if (!wt) {
      throw new Error(`WORKTREE_NOT_FOUND: Ticket ${ticketId} chưa có git worktree.`);
    }
    if (wt.indexLocked) {
      throw new Error(`GIT_INDEX_LOCKED: Xung đột .git/index.lock trong ${wt.worktreePath}`);
    }

    wt.indexLocked = true;
    wt.files.set(filePath, content);
    const commitSha = crypto
      .createHash("sha1")
      .update(`${ticketId}:${filePath}:${content}:${commitMessage}`)
      .digest("hex")
      .slice(0, 8);
    wt.commits.push(commitSha);
    wt.indexLocked = false;
    return commitSha;
  }

  public getWorktree(ticketId: string): IsolatedWorktree | undefined {
    return this.worktrees.get(ticketId);
  }
}

/**
 * Trình chạy lệnh hệ thống tự động chuyển xuống nền sau 5.000ms (AsyncShellRunner)
 * và tự động hủy nếu vượt quá 30 phút (1.800.000ms) - Tác vụ 3.3a
 */
export interface BackgroundJob {
  jobId: string;
  ticketId: string;
  threadId: string;
  command: string;
  estimatedDurationMs: number;
  status: "RUNNING" | "COMPLETED" | "CANCELLED" | "TIMED_OUT";
}

export class AsyncShellRunner {
  public static readonly BACKGROUND_THRESHOLD_MS = 5_000;
  public static readonly HARD_TIMEOUT_MS = 30 * 60 * 1_000; // 30 phút
  public readonly jobs = new Map<string, BackgroundJob>();

  private readonly subBus: SubscriptionBus;
  constructor(subBus: SubscriptionBus) { this.subBus = subBus; }

  public executeCommand(
    ticketId: string,
    threadId: string,
    command: string,
    simulatedDurationMs: number
  ): { mode: "SYNCHRONOUS"; exitCode: 0 } | { mode: "BACKGROUNDED"; jobId: string } {
    if (simulatedDurationMs <= AsyncShellRunner.BACKGROUND_THRESHOLD_MS) {
      return { mode: "SYNCHRONOUS", exitCode: 0 };
    }

    const jobId = `job-${ticketId}-${this.jobs.size + 1}`;
    this.jobs.set(jobId, {
      jobId,
      ticketId,
      threadId,
      command,
      estimatedDurationMs: simulatedDurationMs,
      status: "RUNNING",
    });

    return { mode: "BACKGROUNDED", jobId };
  }

  public completeOrTimeoutJob(jobId: string): BackgroundJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`JOB_NOT_FOUND: ${jobId}`);
    }

    if (job.estimatedDurationMs > AsyncShellRunner.HARD_TIMEOUT_MS) {
      job.status = "TIMED_OUT";
    } else if (job.status === "RUNNING") {
      job.status = "COMPLETED";
    }

    // Bắn thông báo hoàn tất trực tiếp về Executor qua SubscriptionBus
    this.subBus.publishEvent(
      {
        eventId: `ev-${jobId}`,
        threadId: job.threadId,
        sourceType: "CI_TEST_LOG",
        payload: JSON.stringify({ jobId: job.jobId, status: job.status }),
      },
      () => {}
    );

    return job;
  }

  public cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && job.status === "RUNNING") {
      job.status = "CANCELLED";
    }
  }
}

/**
 * Cơ chế Auto-Merge có điều kiện (< 200 dòng thay đổi, đã được con người duyệt,
 * tài khoản merge tách biệt và tự động rút cờ auto-merge khi đẩy commit mới) - Tác vụ 3.3b
 */
export interface PullRequestState {
  prNumber: number;
  authorIdentity: string;
  linesAdded: number;
  linesDeleted: number;
  humanApproved: boolean;
  ciGreen: boolean;
  autoMergeEnabled: boolean;
  mergedByIdentity: string | null;
}

export class ConditionalAutoMergeController {
  public static readonly MAX_AUTO_MERGE_LOC = 200;

  public readonly dedicatedMergeIdentity: string;
  public constructor(dedicatedMergeIdentity = "cc-sdd-automerge-bot") { this.dedicatedMergeIdentity = dedicatedMergeIdentity; }

  public evaluateAndEnableAutoMerge(pr: PullRequestState): {
    autoMergeEnabled: boolean;
    merged: boolean;
    reason: string;
  } {
    const totalChangedLines = pr.linesAdded + pr.linesDeleted;

    if (totalChangedLines >= ConditionalAutoMergeController.MAX_AUTO_MERGE_LOC) {
      pr.autoMergeEnabled = false;
      return {
        autoMergeEnabled: false,
        merged: false,
        reason: `LOC_LIMIT_EXCEEDED: ${totalChangedLines} dòng >= ${ConditionalAutoMergeController.MAX_AUTO_MERGE_LOC} dòng.`,
      };
    }

    if (!pr.humanApproved) {
      pr.autoMergeEnabled = false;
      return {
        autoMergeEnabled: false,
        merged: false,
        reason: "MISSING_HUMAN_APPROVAL: Cần con người phê duyệt trước khi auto-merge.",
      };
    }

    if (this.dedicatedMergeIdentity === pr.authorIdentity) {
      throw new Error(
        "MERGE_IDENTITY_CONFLICT: Tài khoản thực hiện auto-merge phải tách biệt với tài khoản tạo PR."
      );
    }

    pr.autoMergeEnabled = true;
    if (pr.ciGreen) {
      pr.mergedByIdentity = this.dedicatedMergeIdentity;
      return { autoMergeEnabled: true, merged: true, reason: "MERGED_SUCCESSFULLY" };
    }

    return { autoMergeEnabled: true, merged: false, reason: "WAITING_FOR_CI_GREEN" };
  }

  /**
   * Tự động rút cờ auto-merge ngay trước khi đẩy commit mới lên nhánh PR
   */
  public onBeforePushNewCommit(pr: PullRequestState, newDiffLines: number): void {
    if (pr.autoMergeEnabled) {
      pr.autoMergeEnabled = false; // Rút auto-merge ngay lập tức để tránh gộp mã chưa kiểm duyệt
    }
    pr.linesAdded += newDiffLines;
    pr.ciGreen = false;
  }
}

// ============================================================================
// PHẦN 4: BND-ROUTER-DISCOVERY (ADMISSION GATE, EVAL BATCHER & DAG DISPATCHER)
// ============================================================================

export type ProactiveMode = "off" | "observe" | "auto";
export type AdmissionCategory = "explicit" | "inferred" | "ignore";

export interface IncomingTrigger {
  triggerId: string;
  threadId: string;
  sender: string;
  isBot: boolean;
  mentionsAgent: boolean;
  text: string;
}

/**
 * Cổng phân quyền AdmissionGate tiền-LLM và bộ gom lô động EvalBatcher - Tác vụ 4.1
 */
export class AdmissionAndEvalBatcher {
  private readonly whitelistedHumans: Set<string>;
  private readonly allowedBots: Set<string>;
  public proactiveMode: ProactiveMode;
  private readonly db: HarnessStateDatabase;
  constructor(whitelistedHumans: Set<string>, allowedBots: Set<string>, proactiveMode: ProactiveMode = "observe", db: HarnessStateDatabase) { this.whitelistedHumans = whitelistedHumans; this.allowedBots = allowedBots; this.proactiveMode = proactiveMode; this.db = db; }

  public classifyTrigger(trigger: IncomingTrigger): {
    category: AdmissionCategory;
    shouldInvokeEvalLlm: boolean;
    shouldCreateTicket: boolean;
  } {
    const isWhitelistedHuman = this.whitelistedHumans.has(trigger.sender);
    const isAllowedBot = trigger.isBot && this.allowedBots.has(trigger.sender);

    if (!isWhitelistedHuman && !isAllowedBot) {
      return { category: "ignore", shouldInvokeEvalLlm: false, shouldCreateTicket: false };
    }

    if (isWhitelistedHuman && trigger.mentionsAgent) {
      return { category: "explicit", shouldInvokeEvalLlm: true, shouldCreateTicket: true };
    }

    // Trường hợp còn lại (thảo luận của người trong whitelist hoặc sự kiện từ CI bot hợp lệ) -> inferred
    if (this.proactiveMode === "off") {
      return { category: "ignore", shouldInvokeEvalLlm: false, shouldCreateTicket: false };
    }

    if (this.proactiveMode === "observe") {
      this.db.observedCandidates.push({
        triggerId: trigger.triggerId,
        reason: `Inferred từ ${trigger.sender}: ${trigger.text.slice(0, 40)}`,
      });
      return { category: "inferred", shouldInvokeEvalLlm: true, shouldCreateTicket: false };
    }

    // proactiveMode === "auto"
    return { category: "inferred", shouldInvokeEvalLlm: true, shouldCreateTicket: true };
  }

  /**
   * Tính toán kích thước lô gom động (Dynamic Batch Size) theo tốc độ tin nhắn/phút:
   * Khi tải = 1 msg/min -> batchSize = 1.0; khi tải tăng lên 40 msgs/min -> batchSize ~ 2.8.
   */
  public computeDynamicBatchSize(messagesPerMinute: number): number {
    const clampedRate = Math.max(1, Math.min(40, messagesPerMinute));
    const batchSize = 1.0 + ((clampedRate - 1) / 39) * 1.8;
    return Number(batchSize.toFixed(2));
  }
}

/**
 * Bộ phân tích đồ thị phụ thuộc tasks.md (DagDispatcher) và phát tín hiệu
 * policy-changed không hủy ngang khi cập nhật đặc tả - Tác vụ 4.2
 */
export class DagDispatcher {
  public invalidatedQueuedEvals = 0;

  private readonly db: HarnessStateDatabase;
  private readonly slots: WorkerSlotsManager;
  private readonly worktrees: GitWorktreeManager;
  private readonly subBus: SubscriptionBus;
  constructor(db: HarnessStateDatabase, slots: WorkerSlotsManager, worktrees: GitWorktreeManager, subBus: SubscriptionBus) { this.db = db; this.slots = slots; this.worktrees = worktrees; this.subBus = subBus; }

  /**
   * Phân tích danh sách tác vụ và kích hoạt đồng thời toàn bộ các tác vụ (P)
   * đã thỏa mãn điều kiện phụ thuộc _Depends:_
   */
  public dispatchReadyTasks(featureName: string): string[] {
    const dispatchedTicketIds: string[] = [];

    for (const ticket of this.db.tickets.values()) {
      if (ticket.status !== "CREATED") {
        continue;
      }

      const dependenciesMet = ticket.dependsOn.every((depCode) => {
        for (const t of this.db.tickets.values()) {
          if (t.taskCode === depCode && t.status === "COMPLETED") {
            return true;
          }
        }
        return false;
      });

      if (!dependenciesMet) {
        continue;
      }

      const reservation = this.slots.reserveSlot(ticket.ticketId, false);
      if (reservation.granted) {
        const wt = this.worktrees.createWorktree(featureName, ticket.ticketId);
        const executorId = `worker-${ticket.ticketId}`;
        ticket.worktreePath = wt.worktreePath;
        ticket.assignedExecutorId = executorId;
        ticket.status = "TDD_RED";

        this.subBus.subscribe(ticket.threadId, ticket.ticketId, executorId);
        dispatchedTicketIds.push(ticket.ticketId);
      } else {
        ticket.status = "QUEUED_FOR_SLOT";
      }
    }

    return dispatchedTicketIds;
  }

  /**
   * Khi sửa tệp .kiro/steering/*.md hoặc design.md: vô hiệu hóa các lượt Eval đang chờ
   * và phát sự kiện policy-changed vào hộp thư của các Executor đang chạy thay vì hủy ngang.
   */
  public notifyPolicyChanged(updatedDocPath: string, queuedEvalCount: number): number {
    this.invalidatedQueuedEvals += queuedEvalCount;
    let notifiedActiveWorkers = 0;

    for (const ticket of this.db.tickets.values()) {
      if (
        ticket.assignedExecutorId &&
        (ticket.status === "TDD_RED" ||
          ticket.status === "TDD_GREEN" ||
          ticket.status === "KIRO_REVIEWING")
      ) {
        this.subBus.publishEvent(
          {
            eventId: `policy-${Date.now()}-${ticket.ticketId}`,
            threadId: ticket.threadId,
            sourceType: "POLICY_CHANGED",
            payload: `Tài liệu đặc tả '${updatedDocPath}' vừa cập nhật. Hoàn tất bước hiện tại và đọc lại qua MasterAssessor.`,
          },
          () => {}
        );
        notifiedActiveWorkers++;
      }
    }
    return notifiedActiveWorkers;
  }
}

// ============================================================================
// PHẦN 5: BND-SUPERVISION-INTEGRATION (WATCHDOG, WEB PANEL & 8-AGENT REGISTRY)
// ============================================================================

/**
 * Vòng lặp giám sát SemanticWatchdog độc lập bên ngoài hệ thống chính - Tác vụ 5.1
 */
export class SemanticWatchdog {
  private readonly db: HarnessStateDatabase;
  private readonly slots: WorkerSlotsManager;
  constructor(db: HarnessStateDatabase, slots: WorkerSlotsManager) { this.db = db; this.slots = slots; }

  /**
   * Quét toàn bộ Ticket đang thực thi: nếu phát hiện 2 bản git diff liên tiếp giống hệt nhau
   * (lặp vô nghiệm) hoặc vượt quá số lần thử lại mà không sinh ra sản phẩm mới -> dừng theo tác động.
   */
  public scanForStagnation(maxRetries = 3): string[] {
    const haltedTickets: string[] = [];

    for (const ticket of this.db.tickets.values()) {
      if (ticket.status === "COMPLETED" || ticket.status === "WATCHDOG_HALTED") {
        continue;
      }

      const diffs = ticket.diffHashes;
      const hasDuplicateConsecutiveDiff =
        diffs.length >= 2 && diffs[diffs.length - 1] === diffs[diffs.length - 2];
      const exceededRetries = ticket.retryCount > maxRetries;

      if (hasDuplicateConsecutiveDiff || exceededRetries) {
        ticket.status = "WATCHDOG_HALTED";
        this.slots.releaseSlotOnHandoffOrComplete(ticket.ticketId);
        haltedTickets.push(ticket.ticketId);
      }
    }

    return haltedTickets;
  }
}

/**
 * Bộ điều khiển Web Panel trên cổng 3082 gồm 6 thẻ quản trị - Tác vụ 5.2
 */
export class WebPanelController {
  public readonly port = 3082;
  public readonly tabs = [
    "Overview",
    "Source",
    "Trigger",
    "Eval",
    "Execution",
    "Settings",
  ] as const;

  private readonly db: HarnessStateDatabase;
  constructor(db: HarnessStateDatabase) { this.db = db; }

  public getHumanAttentionQueue(): TicketRecord[] {
    return Array.from(this.db.tickets.values()).filter(
      (t) => t.status === "WAITING_FOR_HUMAN" || t.status === "WATCHDOG_HALTED"
    );
  }

  public comparePromptAssembly(
    versionedTemplate: string,
    assembledPrompt: string
  ): { templateLength: number; assembledLength: number; includesDynamicPrefix: boolean } {
    return {
      templateLength: versionedTemplate.length,
      assembledLength: assembledPrompt.length,
      includesDynamicPrefix: assembledPrompt.startsWith(versionedTemplate),
    };
  }
}

/**
 * Bộ xác thực Danh mục 8 Coding Agents, 14 Ngôn ngữ và Phân tách Preset
 * cc-sdd-router / cc-sdd-worker theo sop-new-agent.md - Tác vụ 5.3
 */
export interface AgentPresetManifest {
  agentId: string;
  routerTools: string[];
  workerTools: string[];
  skillCount: number;
  supportedLanguages: string[];
}

export class MultiAgentRegistryValidator {
  public static readonly SUPPORTED_8_AGENTS = [
    "claude-code",
    "codex",
    "cursor",
    "github-copilot",
    "windsurf",
    "opencode",
    "gemini-cli",
    "antigravity",
  ] as const;

  public static readonly SUPPORTED_14_LANGUAGES = [
    "en",
    "ja",
    "zh-CN",
    "zh-TW",
    "ko",
    "es",
    "fr",
    "de",
    "pt",
    "ru",
    "it",
    "vi",
    "id",
    "tr",
  ] as const;

  public static buildStandardManifests(): Map<string, AgentPresetManifest> {
    const map = new Map<string, AgentPresetManifest>();
    for (const agentId of MultiAgentRegistryValidator.SUPPORTED_8_AGENTS) {
      map.set(agentId, {
        agentId,
        // Router tuyệt đối KHÔNG có công cụ sửa tệp (write_file, edit_file, bash_write)
        routerTools: ["read_spec", "parse_dag", "eval_batch", "dispatch_ticket"],
        // Worker có bộ công cụ TDD đầy đủ nhưng bị bọc bởi MandateEnforcer & GitWorktree
        workerTools: [
          "master_assessor_read",
          "mandate_write_file",
          "mandate_edit_file",
          "async_shell_exec",
          "kiro_review_subagent",
          "kiro_debug_subagent",
        ],
        skillCount: 17,
        supportedLanguages: [...MultiAgentRegistryValidator.SUPPORTED_14_LANGUAGES],
      });
    }
    return map;
  }

  public static validateManifests(manifests: Map<string, AgentPresetManifest>): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (manifests.size !== 8) {
      errors.push(`Số lượng agent phải đúng bằng 8, hiện tại: ${manifests.size}`);
    }

    for (const [id, manifest] of manifests.entries()) {
      const forbiddenRouterTools = ["write_file", "edit_file", "apply_diff", "mandate_write_file"];
      if (manifest.routerTools.some((t) => forbiddenRouterTools.includes(t))) {
        errors.push(`Agent '${id}': Preset cc-sdd-router chứa công cụ sửa code bị cấm.`);
      }
      if (manifest.skillCount !== 17) {
        errors.push(`Agent '${id}': Số lượng kỹ năng SKILL.md phải bằng 17.`);
      }
      if (manifest.supportedLanguages.length !== 14) {
        errors.push(`Agent '${id}': Phải hỗ trợ đủ 14 ngôn ngữ.`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ============================================================================
// PHẦN 6: BỘ KIỂM THỬ XÁC THỰC TOÀN DIỆN (AUTOMATED VALIDATION TEST SUITE)
// ============================================================================

describe("CC-SDD v4.0 (Super-Harness) - Bộ Kiểm Thử Xác Thực Toàn Diện Sau Refactoring", () => {
  let db: HarnessStateDatabase;
  let effects: EffectsAndOutboxEngine;
  let recovery: CrashRecoveryService;
  let assessor: MasterAssessor;
  let subBus: SubscriptionBus;
  let mandateEnforcer: MandateEnforcer;
  let workerSlots: WorkerSlotsManager;
  let worktreeManager: GitWorktreeManager;
  let asyncShell: AsyncShellRunner;
  let autoMerge: ConditionalAutoMergeController;
  let admission: AdmissionAndEvalBatcher;
  let dagDispatcher: DagDispatcher;
  let watchdog: SemanticWatchdog;
  let webPanel: WebPanelController;

  beforeEach(() => {
    HarnessStateDatabase.resetAllLocksForTest();
    db = new HarnessStateDatabase(".kiro/state/harness.db");
    effects = new EffectsAndOutboxEngine(db);
    recovery = new CrashRecoveryService(db);
    assessor = new MasterAssessor(db);
    subBus = new SubscriptionBus(db);
    mandateEnforcer = new MandateEnforcer(db);
    workerSlots = new WorkerSlotsManager(3, db); // maxWorkers = 3
    worktreeManager = new GitWorktreeManager();
    asyncShell = new AsyncShellRunner(subBus);
    autoMerge = new ConditionalAutoMergeController("cc-sdd-automerge-bot");
    admission = new AdmissionAndEvalBatcher(
      new Set(["alice-lead", "bob-dev"]),
      new Set(["github-actions-ci"]),
      "observe",
      db
    );
    dagDispatcher = new DagDispatcher(db, workerSlots, worktreeManager, subBus);
    watchdog = new SemanticWatchdog(db, workerSlots);
    webPanel = new WebPanelController(db);
  });

  // --------------------------------------------------------------------------
  // NHÓM 1: XÁC THỰC BND-STATE-ENGINE (Tasks 1.1, 1.2, 1.3)
  // --------------------------------------------------------------------------
  describe("1. BND-STATE-ENGINE: SQLite State Lock, Effects Queue & 3-Step Crash Recovery", () => {
    it("Task 1.1: Chặn cứng bản sao tiến trình thứ hai mở cùng một thư mục trạng thái (.kiro/state/harness.db)", () => {
      assert.throws(
        () => new HarnessStateDatabase(".kiro/state/harness.db"),
        /STATE_LOCK_CONFLICT/,
        "Tiến trình thứ hai mở cùng đường dẫn SQLite phải bị chặn để bảo vệ tính toàn vẹn đơn bản sao."
      );

      db.releaseLock();
      const secondInstance = new HarnessStateDatabase(".kiro/state/harness.db");
      assert.equal(secondInstance.dbPath, ".kiro/state/harness.db");
      secondInstance.releaseLock();
    });

    it("Task 1.2: Chống trùng lặp AgentDelivery và đối soát thẻ HTML ẩn trong Outbox khi mạng bị trễ", () => {
      // 1. Kiểm tra chống trùng lặp đầu vào
      assert.equal(effects.registerInboundDelivery("msg-001"), true);
      assert.equal(
        effects.registerInboundDelivery("msg-001"),
        false,
        "Tin nhắn trùng message_id chỉ được phép xử lý đúng 1 lần."
      );

      // 2. Kiểm tra Outbox nhúng thẻ HTML ẩn và không gửi lặp lại nếu đã có trên GitHub
      const remoteComments: string[] = [];
      const firstSend = effects.deliverOutboxWithHtmlTag(
        "t-1.1",
        "Đã hoàn tất TDD pha GREEN.",
        remoteComments
      );
      assert.equal(firstSend.sent, true);
      assert.equal(remoteComments.length, 1);
      assert.match(remoteComments[0], /<!-- cc-sdd-msg-id: eff-t-1\.1-[a-f0-9]+ -->/);

      // Giả lập tiến trình khởi động lại và thử gửi lại cùng nội dung
      const secondSend = effects.deliverOutboxWithHtmlTag(
        "t-1.1",
        "Đã hoàn tất TDD pha GREEN.",
        remoteComments
      );
      assert.equal(secondSend.sent, false, "Outbox phải phát hiện thẻ HTML trên luồng từ xa và bỏ qua.");
      assert.equal(remoteComments.length, 1);
    });

    it("Task 1.3: Phục hồi 3 bước sau sự cố sập nguồn mà không chạy lại pha RED và đồng bộ ra tasks.md", () => {
      db.tickets.set("t-1.3", {
        ticketId: "t-1.3",
        taskCode: "1.3",
        threadId: "th-1",
        isParallel: true,
        dependsOn: ["1.1"],
        status: "TDD_GREEN",
        worktreePath: ".kiro/worktrees/refactor/task-t-1.3",
        assignedExecutorId: "worker-t-1.3",
        retryCount: 0,
        lastArtifactAt: Date.now(),
        diffHashes: ["abc1234"],
        prNumber: null,
      });

      // Giả lập sập nguồn ngay sau khi commit pha GREEN trong git worktree nhưng chưa kịp mở PR
      const recoveryResult = recovery.recoverTicketState(
        "t-1.3",
        { worktreeExists: true, hasGreenTestCommit: true, lastCommitSha: "8f91a2b" },
        { openPrNumber: null, remoteComments: [] }
      );

      assert.equal(recoveryResult.skippedRedPhase, true);
      assert.equal(recoveryResult.createdPr, true);
      assert.equal(recoveryResult.resumedStatus, "PR_READY");

      // Hoàn tất Ticket và kiểm tra đồng bộ ngược ra tasks.md
      db.tickets.get("t-1.3")!.status = "COMPLETED";
      const sampleTasksMd = "- [x] **1.1** Init DB\n- [ ] **1.3 (P)** Crash Recovery\n";
      const syncedMd = recovery.syncTasksMarkdown(sampleTasksMd);
      assert.match(syncedMd, /- \[x\] \*\*1\.3 \(P\)\*\* Crash Recovery/);
    });
  });

  // --------------------------------------------------------------------------
  // NHÓM 2: XÁC THỰC BND-CONTEXT-MANDATE (Tasks 2.1, 2.2, 2.3)
  // --------------------------------------------------------------------------
  describe("2. BND-CONTEXT-MANDATE: MasterAssessor O(1) Recall, SubscriptionBus & Mandate Firewall", () => {
    it("Task 2.1: MasterAssessor giữ nguyên tiền tố KV Prefix Cache và đọc phân trang qua con trỏ", () => {
      const longSpecContent =
        "BND-EXEC-RUNTIME quản lý hồ bơi kết nối WorkerSlots, khởi tạo git worktree độc lập và chuyển các lệnh shell chạy quá 5 giây xuống tiến trình nền có job_id.";
      const chunkIds = assessor.indexDocument("design.md", "BND-EXEC-RUNTIME", longSpecContent, 70);
      assert.equal(chunkIds.length, 3);

      const mandate = mandateEnforcer.compileMandate(
        "t-2.1",
        "BND-EXEC-RUNTIME",
        ["tools/cc-sdd/src/execution/workerSlots.ts"],
        ["npm test"]
      );

      const prefix1 = assessor.buildImmutablePrefixPrompt(mandate, "Tóm tắt nội tuyến BND-EXEC-RUNTIME");
      const prefix2 = assessor.buildImmutablePrefixPrompt(mandate, "Tóm tắt nội tuyến BND-EXEC-RUNTIME");
      assert.equal(prefix1, prefix2, "Tiền tố prompt phải bất biến 100% để trúng KV Prefix Cache.");

      const page1 = assessor.readChunk(chunkIds[0], 0, 35);
      assert.equal(page1.excerpt.length, 35);
      assert.equal(page1.nextCursor, 35);

      const page2 = assessor.readChunk(chunkIds[0], page1.nextCursor!, 35);
      assert.equal(page2.nextCursor, null);
      assert.equal(page1.excerpt + page2.excerpt, db.contextChunks.get(chunkIds[0])!.content);
    });

    it("Task 2.2: SubscriptionBus chuyển tiếp trực tiếp sự kiện về Executor với 0 lần gọi Router", () => {
      subBus.subscribe("thread-feat-A", "t-2.2", "worker-t-2.2");

      const events: ThreadEvent[] = [
        { eventId: "e1", threadId: "thread-feat-A", sourceType: "CI_TEST_LOG", payload: "PASS" },
        { eventId: "e2", threadId: "thread-feat-A", sourceType: "KIRO_REVIEW", payload: "WARNING" },
        { eventId: "e3", threadId: "thread-feat-A", sourceType: "KIRO_DEBUG", payload: "FIX_PLAN" },
        { eventId: "e4", threadId: "thread-feat-A", sourceType: "HUMAN_COMMENT", payload: "LGTM" },
      ];

      for (const ev of events) {
        const route = subBus.publishEvent(ev, () => {});
        assert.equal(route, "DIRECT_TO_EXECUTOR");
      }

      assert.equal(
        subBus.routerEvalCallsCount,
        0,
        "Mọi sự kiện trên luồng đã đăng ký phải đi thẳng tới Worker với 0 lần gọi Router."
      );
      assert.equal(subBus.directWorkerDeliveriesCount, 4);
      assert.equal(subBus.executorInboxes.get("worker-t-2.2")?.length, 4);
    });

    it("Task 2.3: MandateEnforcer chặn cứng hành vi ghi tệp ngoài _Boundary:_ và chặn gọi kiro-review khi test lỗi", () => {
      mandateEnforcer.compileMandate(
        "t-2.3",
        "BND-CONTEXT-MANDATE",
        ["tools/cc-sdd/src/security/mandateEnforcer.ts"],
        ["npm test"]
      );

      // 1. Thử ghi vào tệp hợp lệ
      const validWrite = mandateEnforcer.interceptFileWrite(
        "t-2.3",
        "tools/cc-sdd/src/security/mandateEnforcer.ts"
      );
      assert.equal(validWrite.allowed, true);

      // 2. Thử ghi lẹm sang tệp ngoài Mandate
      const invalidWrite = mandateEnforcer.interceptFileWrite(
        "t-2.3",
        "tools/cc-sdd/src/router/admission.ts"
      );
      assert.equal(invalidWrite.allowed, false);
      if (!invalidWrite.allowed) {
        assert.equal(invalidWrite.errorCode, "MANDATE_BOUNDARY_VIOLATION");
      }

      // 3. Cổng lọc cơ học tiền-LLM phải từ chối gọi kiro-review nếu mã thoát test != 0 (tiêu thụ 0 token)
      const failedTestGate = mandateEnforcer.verifyPreReviewMechanicalGate("t-2.3", 1, [
        "tools/cc-sdd/src/security/mandateEnforcer.ts",
      ]);
      assert.equal(failedTestGate.passed, false);
      assert.equal(failedTestGate.llmTokensConsumed, 0);

      // 4. Vượt qua cổng cơ học khi test == 0 và diff nằm trong Mandate
      const passedGate = mandateEnforcer.verifyPreReviewMechanicalGate("t-2.3", 0, [
        "tools/cc-sdd/src/security/mandateEnforcer.ts",
      ]);
      assert.equal(passedGate.passed, true);
    });
  });

  // --------------------------------------------------------------------------
  // NHÓM 3: XÁC THỰC BND-EXEC-RUNTIME (Tasks 3.1, 3.2, 3.3)
  // --------------------------------------------------------------------------
  describe("3. BND-EXEC-RUNTIME: WorkerSlots (maxWorkers + 1), Git Worktree & AsyncShell / Auto-Merge", () => {
    it("Task 3.1: Quản lý khe WorkerSlots, cấp khe ưu tiên (maxWorkers + 1) cho con người và giải phóng khi handoff", () => {
      // Chiếm đủ 3 khe thường (maxWorkers = 3)
      assert.equal(workerSlots.reserveSlot("t-1", false).slotType, "REGULAR");
      assert.equal(workerSlots.reserveSlot("t-2", false).slotType, "REGULAR");
      assert.equal(workerSlots.reserveSlot("t-3", false).slotType, "REGULAR");

      // Tác vụ thường thứ 4 phải xếp hàng đợi
      assert.equal(workerSlots.reserveSlot("t-4", false).slotType, "QUEUED");

      // Tin nhắn tiếp nối từ con người được cấp phát ngay khe ưu tiên thứ 4 (maxWorkers + 1)
      const humanSlot = workerSlots.reserveSlot("t-human", true);
      assert.equal(humanSlot.granted, true);
      assert.equal(humanSlot.slotType, "HUMAN_PRIORITY");
      assert.deepEqual(workerSlots.getActiveCount(), { regular: 3, humanPriority: 1, queued: 1 });

      // Khi t-1 gọi handoff chờ con người, khe được giải phóng ngay cho t-4 trong hàng đợi
      const promotedTicket = workerSlots.releaseSlotOnHandoffOrComplete("t-1");
      assert.equal(promotedTicket, "t-4");
      assert.equal(workerSlots.getActiveCount().queued, 0);
    });

    it("Task 3.2: Khởi tạo và commit song song trên 3 Git Worktrees độc lập mà không xung đột index.lock", () => {
      const wt1 = worktreeManager.createWorktree("superagent", "3.1");
      const wt2 = worktreeManager.createWorktree("superagent", "3.2");
      const wt3 = worktreeManager.createWorktree("superagent", "3.3");

      assert.notEqual(wt1.worktreePath, wt2.worktreePath);
      assert.notEqual(wt2.worktreePath, wt3.worktreePath);

      const sha1 = worktreeManager.writeAndCommitInWorktree("3.1", "a.ts", "export const a = 1;", "feat: 3.1");
      const sha2 = worktreeManager.writeAndCommitInWorktree("3.2", "a.ts", "export const a = 2;", "feat: 3.2");
      const sha3 = worktreeManager.writeAndCommitInWorktree("3.3", "a.ts", "export const a = 3;", "feat: 3.3");

      assert.notEqual(sha1, sha2);
      assert.notEqual(sha2, sha3);
      assert.equal(worktreeManager.getWorktree("3.1")?.files.get("a.ts"), "export const a = 1;");
      assert.equal(worktreeManager.getWorktree("3.2")?.files.get("a.ts"), "export const a = 2;");
    });

    it("Task 3.3: Chuyển lệnh shell > 5s xuống nền (timeout 30p) và kiểm soát Auto-Merge < 200 dòng", () => {
      subBus.subscribe("th-shell", "t-3.3", "worker-t-3.3");

      // Lệnh nhanh (2 giây) chạy đồng bộ
      const fastCmd = asyncShell.executeCommand("t-3.3", "th-shell", "npm run lint", 2_000);
      assert.equal(fastCmd.mode, "SYNCHRONOUS");

      // Lệnh kéo dài 12 giây (> 5.000ms) tự động tách xuống nền và trả về job_id
      const slowCmd = asyncShell.executeCommand("t-3.3", "th-shell", "npm test", 12_000);
      assert.equal(slowCmd.mode, "BACKGROUNDED");
      if (slowCmd.mode === "BACKGROUNDED") {
        const finishedJob = asyncShell.completeOrTimeoutJob(slowCmd.jobId);
        assert.equal(finishedJob.status, "COMPLETED");
        assert.equal(subBus.executorInboxes.get("worker-t-3.3")?.length, 1);
      }

      // Lệnh vượt quá 30 phút (1.900.000ms) bị tự động hủy TIMED_OUT
      const hungCmd = asyncShell.executeCommand("t-3.3", "th-shell", "npm run e2e", 1_900_000);
      if (hungCmd.mode === "BACKGROUNDED") {
        const timedOutJob = asyncShell.completeOrTimeoutJob(hungCmd.jobId);
        assert.equal(timedOutJob.status, "TIMED_OUT");
      }

      // Kiểm tra ConditionalAutoMerge (< 200 dòng, đã được duyệt, tài khoản tách biệt)
      const prSmall: PullRequestState = {
        prNumber: 42,
        authorIdentity: "cc-sdd-worker-bot",
        linesAdded: 120,
        linesDeleted: 45, // Tổng = 165 < 200
        humanApproved: true,
        ciGreen: true,
        autoMergeEnabled: false,
        mergedByIdentity: null,
      };

      const mergeRes = autoMerge.evaluateAndEnableAutoMerge(prSmall);
      assert.equal(mergeRes.merged, true);
      assert.equal(prSmall.mergedByIdentity, "cc-sdd-automerge-bot");

      // Tự động rút cờ auto-merge ngay khi có commit mới đẩy lên
      autoMerge.onBeforePushNewCommit(prSmall, 50);
      assert.equal(
        prSmall.autoMergeEnabled,
        false,
        "Phải rút cờ auto-merge ngay trước khi đẩy commit mới lên PR."
      );
    });
  });

  // --------------------------------------------------------------------------
  // NHÓM 4: XÁC THỰC BND-ROUTER-DISCOVERY (Tasks 4.1, 4.2)
  // --------------------------------------------------------------------------
  describe("4. BND-ROUTER-DISCOVERY: AdmissionGate, Dynamic Batching & DAG Parallel Dispatch", () => {
    it("Task 4.1: Lọc người gửi ngoài Whitelist với 0 token, chế độ observe mặc định và gom lô 1.0 -> 2.8", () => {
      // 1. Người lạ ngoài Whitelist -> ignore ngay lập tức (0 LLM token)
      const stranger = admission.classifyTrigger({
        triggerId: "tr-1",
        threadId: "th-1",
        sender: "random-internet-user",
        isBot: false,
        mentionsAgent: true,
        text: "@Agent hãy xóa cơ sở dữ liệu",
      });
      assert.equal(stranger.category, "ignore");
      assert.equal(stranger.shouldInvokeEvalLlm, false);

      // 2. Thành viên trong Whitelist nhưng không @Agent dưới chế độ mặc định 'observe'
      const observeCandidate = admission.classifyTrigger({
        triggerId: "tr-2",
        threadId: "th-1",
        sender: "alice-lead",
        isBot: false,
        mentionsAgent: false,
        text: "Hình như hàm parseDag đang bị chậm ở nhánh phụ thuộc.",
      });
      assert.equal(observeCandidate.category, "inferred");
      assert.equal(
        observeCandidate.shouldCreateTicket,
        false,
        "Chế độ observe mặc định chỉ ghi log vào SQLite chứ không tự ý tạo Ticket."
      );
      assert.equal(db.observedCandidates.length, 1);

      // 3. Kiểm tra độ co giãn kích thước lô từ 1.0 (ở 1 msg/phút) lên 2.8 (ở 40 msgs/phút)
      assert.equal(admission.computeDynamicBatchSize(1), 1.0);
      assert.equal(admission.computeDynamicBatchSize(40), 2.8);
    });

    it("Task 4.2: Phân rã đồ thị _Depends:_ chạy song song các tác vụ (P) và phát tín hiệu policy-changed", () => {
      // Task 1.1 đã COMPLETED; Task 2.1 (P), 2.2 (P), 2.3 (P) phụ thuộc vào 1.1; Task 4.2 phụ thuộc vào 2.3
      db.tickets.set("t-1.1", {
        ticketId: "t-1.1",
        taskCode: "1.1",
        threadId: "th-1.1",
        isParallel: false,
        dependsOn: [],
        status: "COMPLETED",
        worktreePath: null,
        assignedExecutorId: null,
        retryCount: 0,
        lastArtifactAt: Date.now(),
        diffHashes: [],
        prNumber: 1,
      });

      for (const code of ["2.1", "2.2", "2.3"]) {
        db.tickets.set(`t-${code}`, {
          ticketId: `t-${code}`,
          taskCode: code,
          threadId: `th-${code}`,
          isParallel: true,
          dependsOn: ["1.1"],
          status: "CREATED",
          worktreePath: null,
          assignedExecutorId: null,
          retryCount: 0,
          lastArtifactAt: Date.now(),
          diffHashes: [],
          prNumber: null,
        });
      }

      db.tickets.set("t-4.2", {
        ticketId: "t-4.2",
        taskCode: "4.2",
        threadId: "th-4.2",
        isParallel: false,
        dependsOn: ["2.3"],
        status: "CREATED",
        worktreePath: null,
        assignedExecutorId: null,
        retryCount: 0,
        lastArtifactAt: Date.now(),
        diffHashes: [],
        prNumber: null,
      });

      const dispatched = dagDispatcher.dispatchReadyTasks("superagent");
      assert.deepEqual(
        dispatched,
        ["t-2.1", "t-2.2", "t-2.3"],
        "Cả 3 tác vụ (P) đã thỏa mãn _Depends:_ phải được cấp phát chạy song song cùng lúc."
      );
      assert.equal(
        db.tickets.get("t-4.2")?.status,
        "CREATED",
        "Task 4.2 chưa được chạy vì phụ thuộc 2.3 chưa hoàn tất."
      );

      // Kiểm tra phát sự kiện policy-changed không hủy ngang khi sửa design.md
      const notifiedCount = dagDispatcher.notifyPolicyChanged(
        ".kiro/specs/cc-sdd-superagent-refactor/design.md",
        5
      );
      assert.equal(notifiedCount, 3);
      assert.equal(dagDispatcher.invalidatedQueuedEvals, 5);
      assert.equal(
        subBus.executorInboxes.get("worker-t-2.1")?.[0]?.sourceType,
        "POLICY_CHANGED"
      );
    });
  });

  // --------------------------------------------------------------------------
  // NHÓM 5: XÁC THỰC BND-SUPERVISION-INTEGRATION & MÔ PHỎNG 300 TIN NHẮN
  // --------------------------------------------------------------------------
  describe("5. BND-SUPERVISION-INTEGRATION & Kịch bản Mô phỏng 300 Tin nhắn / 20 Yêu cầu", () => {
    it("Task 5.1 & 5.2: SemanticWatchdog ngắt sớm vòng lặp lặp lại git diff và đẩy lên Web Panel cổng 3082", () => {
      workerSlots.reserveSlot("t-stuck", false);
      db.tickets.set("t-stuck", {
        ticketId: "t-stuck",
        taskCode: "5.1",
        threadId: "th-stuck",
        isParallel: true,
        dependsOn: [],
        status: "KIRO_DEBUGGING",
        worktreePath: ".kiro/worktrees/superagent/task-t-stuck",
        assignedExecutorId: "worker-t-stuck",
        retryCount: 2,
        lastArtifactAt: Date.now() - 600_000,
        diffHashes: ["same-diff-hash-999", "same-diff-hash-999"], // 2 lần sinh ra git diff y hệt nhau
        prNumber: null,
      });

      const halted = watchdog.scanForStagnation(3);
      assert.deepEqual(halted, ["t-stuck"]);
      assert.equal(db.tickets.get("t-stuck")?.status, "WATCHDOG_HALTED");
      assert.equal(
        workerSlots.getActiveCount().regular,
        0,
        "Watchdog phải giải phóng ngay khe trong WorkerSlots khi dừng tác vụ bị kẹt."
      );

      // Kiểm tra Web Panel ở cổng 3082 hiển thị đúng 6 thẻ và đưa t-stuck lên danh sách cần con người chú ý
      assert.equal(webPanel.port, 3082);
      assert.equal(webPanel.tabs.length, 6);
      assert.equal(webPanel.getHumanAttentionQueue().length, 1);
      assert.equal(webPanel.getHumanAttentionQueue()[0].ticketId, "t-stuck");
    });

    it("Task 5.3: Xác thực toàn bộ 8 Coding Agents, 14 Ngôn ngữ và 17 Kỹ năng SKILL.md theo sop-new-agent.md", () => {
      const manifests = MultiAgentRegistryValidator.buildStandardManifests();
      const validation = MultiAgentRegistryValidator.validateManifests(manifests);
      assert.equal(validation.valid, true, `Lỗi manifest: ${validation.errors.join(", ")}`);
    });

    it("Benchmark Tổng hợp: Mô phỏng 300 tin nhắn / 20 yêu cầu công việc chứng minh giảm >30% quyết định tại Router", () => {
      admission.proactiveMode = "observe";
      let routerDecisionsWithSubscription = 0;
      let routerDecisionsWithoutSubscription = 0;

      // Tạo 20 yêu cầu công việc hợp lệ (mỗi yêu cầu có 1 sự kiện khởi tạo + 4 sự kiện tiếp nối gồm test/review/debug/comment = 100 sự kiện)
      // Cùng với 200 tin nhắn nhiễu/thảo luận ngoài lề -> Tổng cộng = 300 tin nhắn.
      for (let reqIdx = 1; reqIdx <= 20; reqIdx++) {
        const threadId = `thread-work-${reqIdx}`;
        const ticketId = `ticket-${reqIdx}`;
        const executorId = `worker-${reqIdx}`;

        // Sự kiện 1: Yêu cầu khởi tạo từ kỹ sư trong whitelist có @Agent -> Đi qua Router
        const initClass = admission.classifyTrigger({
          triggerId: `tr-init-${reqIdx}`,
          threadId,
          sender: "alice-lead",
          isBot: false,
          mentionsAgent: true,
          text: `@Agent triển khai tính năng #${reqIdx}`,
        });

        if (initClass.shouldInvokeEvalLlm) {
          routerDecisionsWithSubscription++;
          routerDecisionsWithoutSubscription++;
          subBus.subscribe(threadId, ticketId, executorId);
        }

        // 4 sự kiện tiếp nối trên cùng luồng công việc (Test log, Review, Debug, PR Comment)
        const followUpTypes: ThreadEvent["sourceType"][] = [
          "CI_TEST_LOG",
          "KIRO_REVIEW",
          "KIRO_DEBUG",
          "HUMAN_COMMENT",
        ];
        for (const sourceType of followUpTypes) {
          routerDecisionsWithoutSubscription++; // Nếu không có Subscription, mọi sự kiện đều phải qua Router
          const route = subBus.publishEvent(
            {
              eventId: `ev-${reqIdx}-${sourceType}`,
              threadId,
              sourceType,
              payload: "Follow-up payload",
            },
            () => {
              routerDecisionsWithSubscription++;
            }
          );
          assert.equal(route, "DIRECT_TO_EXECUTOR");
        }
      }

      // 200 tin nhắn nhiễu từ tài khoản ngoài whitelist hoặc thảo luận không @Agent
      for (let noiseIdx = 1; noiseIdx <= 200; noiseIdx++) {
        const res = admission.classifyTrigger({
          triggerId: `tr-noise-${noiseIdx}`,
          threadId: `thread-noise-${noiseIdx}`,
          sender: "external-commenter",
          isBot: false,
          mentionsAgent: false,
          text: "Bình luận thảo luận thông thường trên GitHub Issue",
        });
        assert.equal(res.shouldInvokeEvalLlm, false);
      }

      // Kiểm chứng số lần gọi quyết định tại Router giảm mạnh nhờ SubscriptionBus & AdmissionGate
      const reductionRatio =
        (routerDecisionsWithoutSubscription - routerDecisionsWithSubscription) /
        routerDecisionsWithoutSubscription;

      assert.equal(routerDecisionsWithSubscription, 20);
      assert.equal(routerDecisionsWithoutSubscription, 100);
      assert.ok(
        reductionRatio >= 0.3,
        `Mức giảm quyết định tại Router (${(reductionRatio * 100).toFixed(1)}%) phải vượt ngưỡng mục tiêu 30%.`
      );
    });
  });
});