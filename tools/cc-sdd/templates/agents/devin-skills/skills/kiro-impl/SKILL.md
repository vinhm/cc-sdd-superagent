---
name: kiro-impl
version: 4.0.0
role_profile: hybrid-router-worker
header_dependencies:
  - .kiro/steering/product.md
  - .kiro/steering/tech.md
  - .kiro/steering/structure.md
  - .kiro/specs/{feature}/spec.json
  - .kiro/specs/{feature}/design.md#file-structure-plan
  - .kiro/specs/{feature}/tasks.md
context_mode: inline-spill-chained-recall
mandate_enforcement: strict-tool-adapter
state_backend: .kiro/state/harness.db
description: Implement approved tasks using TDD with native subagent dispatch. Runs all pending tasks autonomously or selected tasks manually.
---

# Kiro Implementation Skill (v4.0 Super-Harness Router–Worker Protocol)

## 1. Static Core Invariants (KV Prefix Cache Locked)
1. **Attention Conservation:** Consume as little human attention as possible while delivering verified software. Only interrupt humans on scope violations, ambiguous spec requirements, or changes exceeding 200 lines.
2. **Immutable Mandate Enforcement:** The `_Boundary:_` annotation in `tasks.md` and the *File Structure Plan* in `design.md` compile into an immutable `Mandate`. Incoming comments, test logs, or `## Implementation Notes` provide context only and NEVER expand your file-write authority.
3. **Evidence Over Prose:** Never infer task completion from implementer prose. Completion requires mechanical exit code `0` from `TEST_COMMANDS`/`BUILD_COMMANDS`/`SMOKE_COMMANDS` and an explicit `APPROVED` verdict from `kiro-review` on actual `git diff`.

## Role & Modes
You operate in two modes:
- **Autonomous mode** (no task numbers): Router DAG wave scheduling + WorkerSlots dispatch to isolated git worktrees
- **Manual mode** (task numbers provided): Execute selected tasks directly in the main context

## Core Mission
- **Success Criteria**:
  - All tests written before implementation code
  - Code passes all tests with no regressions
  - Tasks marked as completed in tasks.md
  - Implementation aligns with design and requirements
  - Task completion follows the selected review mode

## Review Mode
- Default review mode is `required` (Default is `required`)
- Accept explicit forms: `--review required|inline|off`
- Also accept clear natural-language opt-outs such as `skip review` or `without review` as `off`
- If the request is ambiguous, keep `required`
- If review mode is `off`, skip task-local review and proceed to verification gate

## Architecture (V4 Router-Worker Engine)
- **Router-Worker Separation (REQ-SPD-01)**:
  - `cc-sdd-router`: Read-only coordination preset. Analyzes tasks DAG, batches eval events, schedules parallel `(P)` waves, and allocates `WorkerSlots`. Never modifies source code directly.
  - `cc-sdd-worker`: Isolated TDD execution preset. Runs in isolated git worktrees (`.kiro/worktrees/<feature>/task-<X-Y>`), executes RED->GREEN test cycles, strictly bounded by `MandateEnforcer` and monitored by `SemanticWatchdog`.
- **Parallel Dispatch & Worktrees (REQ-SPD-02)**: Tasks marked with `(P)` whose dependencies `_Depends:_` are fulfilled are dispatched concurrently to separate worker slots and worktrees.
- **WorkerSlots Concurrency**: Manages worker pool with `maxWorkers` slots, plus 1 reserved priority slot for human follow-ups (`maxWorkers + 1`).
- **Async Backgrounding**: Shell commands taking >5000ms transition to async background processes via `AsyncShellRunner` (30-minute timeout per turn).
- **Direct Event Routing (REQ-TOK-01)**: Review verdicts, test outputs, and debugging cycles route directly to the active worker via `SubscriptionBus` without re-evaluating the parent router.

## 2. Mode A: Router Orchestration (`cc-sdd-router` — No File Edit Tools)
When invoked as `/kiro-impl` (autonomous wave execution) or after a crash restart:
1. **3-Step Crash Recovery Check:** Before dispatching, reconcile (a) `.kiro/state/harness.db` (`tickets` and `effects_queue` tables), (b) uncommitted files and `git log` inside existing `.kiro/worktrees/`, and (c) remote PR/branch state on GitHub. Resume interrupted tickets from their last recorded effect without repeating completed TDD phases.
2. **DAG Wave Resolution:**
   - Parse `tasks.md` for unchecked sub-tasks (`- [ ] X.Y`).
   - Group all tasks marked with `(P)` whose `_Depends:_` prerequisites are `[x]` into a parallel execution wave.
   - Respect `_Boundary:_` annotations to ensure disjoint work areas.
3. **Pre-Allocated WorkerSlots Dispatch:**
   - Reserve a slot in `WorkerSlots` (`maxWorkers` limit) BEFORE waking or spawning a `cc-sdd-worker` session.
   - Maintain 1 dedicated overflow slot (`maxWorkers + 1`) strictly reserved for human follow-up messages.
   - Provision an isolated workspace via `git worktree add .kiro/worktrees/{feature}/task-{X-Y}`.
   - Bind a `Subscription` so all subsequent review, debug, and test events route directly to `worker-task-{X-Y}` without re-entering the Router.
4. **Non-Disruptive Policy Updates:** If `.kiro/steering/*.md`, `requirements.md`, or `design.md` changes during execution, invalidate pending `Eval` items and emit a `policy-changed` event to active Workers; do NOT abruptly kill active Worker processes.
5. **Dispatch Flow per Task**:
   - For every dispatch below, use Devin's available `run_subagent` tool with the `subagent_general` profile and its actual schema. Prefer foreground execution so required tool approvals can be surfaced. Pass the exact checkout, absolute spec/protocol paths, and task-relevant guidance; do not rely on inherited conversation history. Use a fresh worker for independent implementation and review. Collect its completed result with the host's native lifecycle (`read_subagent` when needed) before advancing. A background permission denial is not a completed task; use the foreground approval flow without granting permissions automatically.
   - Keep orchestration in the parent. Built-in Devin children cannot spawn further children by default. If this skill is running in a child without delegation tools, use the manual flow with inline review and report that limitation.
   - Read `templates/implementer-prompt.md` and construct prompt with task description, boundary scope, and validation commands.
   - Dispatch via **Agent tool** as a fresh subagent.
   - **Strict Handoff Parsing**: Parse implementer status only from the exact `## Status Report` block and `- STATUS:` field (`READY_FOR_REVIEW | BLOCKED | NEEDS_CONTEXT`). If missing or prose, re-dispatch once.
   - **Review Dispatch**:
     - Read `templates/reviewer-prompt.md` and pass `REVIEW_PROTOCOL_PATH` pointing to `../kiro-review/SKILL.md`.
     - Dispatch via **Agent tool** as a fresh subagent.
     - Parse reviewer verdict only from the exact `## Review Verdict` block and `- VERDICT:` field (`APPROVED | REJECTED`).
     - **Bounded Remediation**: Max 2 implementer re-dispatches per rejection, then dispatch debugger.
   - **Debug Dispatch**:
     - Triggered by `BLOCKED`, `NEEDS_CONTEXT` unresolved, or `REJECTED` after 2 remediation rounds.
     - Read `templates/debugger-prompt.md` and pass `DEBUG_PROTOCOL_PATH` pointing to `../kiro-debug/SKILL.md`.
     - Dispatch via **Agent tool** as a fresh subagent.
     - Require a `## Debug Report` and parse its exact `- NEXT_ACTION:` field (`RETRY_TASK | BLOCK_TASK | STOP_FOR_HUMAN`).
     - If `NEXT_ACTION: STOP_FOR_HUMAN` → append `_Blocked: <ROOT_CAUSE>_` to `tasks.md`, stop the feature run, and report that human review is required.
     - **No Destructive Reset**: Never use `git checkout .`, `git reset --hard`, or similar destructive rollback inside the loop.
     - Max 2 debug rounds per task.
   - **Selective Commit**:
     - Only after review returns `APPROVED`, apply `kiro-verify-completion` using fresh evidence from the current code state.
     - Mark task `[x]` in `tasks.md`.
     - Stage only the explicit files permitted by `Mandate`: `git add <file1> <file2>`. NEVER use `git add -A` or `git add .`.

## 3. Mode B: Worker Execution (`cc-sdd-worker` — Isolated Git Worktree)
When executing an assigned `Ticket` (`task-X.Y`) inside your dedicated `git worktree`:
1. **Budgeted Context Recall (`MasterAssessor`):** Do NOT load full spec files or monolithic `## Implementation Notes`. Read only the inline `_Boundary:_` payload and invoke `MasterAssessor` pagination cursors by Stable ID (`Task ID -> Boundary ID -> Design Section -> Note ID`) when deeper context is needed.
2. **Feature-Flag TDD & 5-Second Async Shell:**
   - Follow the **Feature Flag Protocol** for behavioral changes:
     1. Add flag defaulting OFF.
     2. RED: Write tests failing with flag OFF. Run tests and capture failing output (`RED_PHASE_OUTPUT`).
     3. GREEN: Enable flag, implement minimal code strictly within files permitted by `Mandate` until tests pass.
     4. Remove flag and confirm tests still pass.
   - Any execution of `TEST_COMMANDS`, `BUILD_COMMANDS`, or `SMOKE_COMMANDS` exceeding 5 seconds automatically moves to a background job (`job_id`, 30-minute timeout per turn) via `AsyncShellRunner` so your session remains responsive to `Subscription` events.
3. **Pre-LLM Mechanical Gate & Direct Review Loop:**
   - Before invoking `kiro-review`, run the mechanical gate: verify test exit code is `0` and `git diff --name-only` contains zero out-of-mandate paths.
   - Receive `kiro-review` and `kiro-debug` feedback directly via `Subscription`.
   - Record each remediation attempt in the SQLite `Effects` queue for external semantic `Watchdog` monitoring.
4. **Upstream Defect Handoff & Slot Release:**
   - If passing TDD requires modifying a shared contract outside your `Mandate`, STOP immediately, call `handoff(reason: "UPSTREAM_DEFECT")` to `cc-sdd-router`, halt child subagents, and release your `WorkerSlots` slot immediately.
5. **Idempotent Outbox & Conditional Auto-Merge:**
   - Record intent in the SQLite `Effects` queue before committing or posting to GitHub. Embed hidden HTML message ID markers in `Outbox` comments (`<!-- cc-sdd-outbox: <id> -->`) and scan remote threads first to prevent duplicate reports after network retries.
   - Project `[x]` back to `tasks.md` only after `kiro-verify-completion` succeeds.
   - Enable conditional auto-merge ONLY if total changed lines `< 200`, human approval is present, and a separate merge account is configured; automatically retract auto-merge before pushing any new commits.

## Manual Mode (main context)
When task numbers are provided (e.g., `/kiro-impl 1.1`):
1. **Build Task Brief**: Synthesize acceptance criteria, completion definition, design constraints, and verification method from the relevant spec sections.
2. **Execute TDD Cycle**: RED → GREEN → REFACTOR.
3. **Review**:
   - `required`: Apply `kiro-review` before marking complete.
   - `inline`: Apply `kiro-review` in main context.
   - `off`: If review mode is `off`, skip review and proceed directly to completion verification.
4. **Mark Complete**: Only after review returns `APPROVED` (or after verification if review is off), apply `kiro-verify-completion`, then update checkbox from `- [ ]` to `- [x]` in `tasks.md`.

## Step 4: Final Validation
- Run `/kiro-validate-impl {feature}` as a GO/NO-GO gate.
- If validation returns GO → apply `kiro-verify-completion` before reporting feature success.
- If validation returns NO-GO: Fix only concrete findings from the validation report. Cap remediation at 3 rounds; if still NO-GO, stop and report remaining findings.
- If validation returns MANUAL_VERIFY_REQUIRED → stop and report the missing verification step.

## Safety & Fallback
- **Tasks Not Approved**: Stop execution if spec.json approvals are missing.
- **Test Failures**: Fix failing tests before continuing.
- **All Tasks Blocked**: Stop and report all blocked tasks with reasons; human review needed to resolve blockers.
- **Spec Conflicts with Reality**: Block the task with `_Blocked: <reason>_` -- do not silently work around it.
- **Upstream Ownership Detected**: Route fix back to owning upstream spec, keep downstream task blocked.
- **Task Plan Invalidated During Implementation**: If debug returns `NEXT_ACTION: STOP_FOR_HUMAN`, stop and return for human review of `tasks.md`.
