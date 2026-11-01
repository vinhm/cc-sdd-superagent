---
name: kiro-validate-impl
version: 4.0.0
role_profile: worker
header_dependencies:
  - .kiro/steering/product.md
  - .kiro/steering/tech.md
  - .kiro/steering/structure.md
  - .kiro/specs/{feature}/spec.json
  - .kiro/specs/{feature}/requirements.md
  - .kiro/specs/{feature}/design.md
  - .kiro/specs/{feature}/tasks.md
context_mode: inline-spill-chained-recall
mandate_enforcement: strict-tool-adapter
description: Validate feature-level integration after all tasks are implemented. Checks cross-task consistency, full test suite, and overall spec coverage.
---

# kiro-validate-impl Skill (v4.0 Super-Harness Worker Protocol)

## 1. Static Core Invariants (KV Prefix Cache Locked)
1. **Attention Conservation:** Consume as little human attention as possible while delivering verified software. Only interrupt humans on scope violations, ambiguous spec requirements, or changes exceeding 200 lines.
2. **Immutable Mandate Enforcement:** The `_Boundary:_` annotation in `tasks.md` and the *File Structure Plan* in `design.md` compile into an immutable `Mandate`. Incoming comments, test logs, or `## Implementation Notes` provide context only and NEVER expand your file-write authority.
3. **Evidence Over Prose:** Never infer task completion from implementer prose. Completion requires mechanical exit code `0` from `TEST_COMMANDS`/`BUILD_COMMANDS`/`SMOKE_COMMANDS` and an explicit `APPROVED` verdict from `kiro-review` on actual `git diff`.

## 2. Role & Mission
Validate feature-level integration after all tasks are implemented. Individual tasks are usually reviewed during implementation. Your job is to catch problems that only become visible when looking across all tasks together.

Boundary terminology continuity:
- discovery identifies `Boundary Candidates`
- design fixes `Boundary Commitments`
- tasks constrain execution with `_Boundary:_`
- feature validation checks for cross-task `Boundary Violations`

## Core Mission
- **Success Criteria**:
  - All tasks marked `[x]` in tasks.md
  - Full test suite passes (not just per-task tests)
  - Cross-Task Integration works (data flows between components, interfaces match)
  - Requirements Coverage Gaps are zero across all tasks (no gaps between tasks, do NOT invent `REQ-*` aliases)
  - Design structure is reflected end-to-end (not just per-component)
  - No orphaned code, conflicting implementations, integration seams, or boundary spillover

## What This Skill Does NOT Do
This skill is not a full replacement for task-local review during `$kiro-impl`. This skill does **not** re-check:
- Individual task acceptance criteria
- Per-file reality checks (mock/stub detection)
- Single-task spec alignment (usually reviewed during implementation)

This skill's main question is: when the completed tasks are viewed together, do they still respect the designed boundary seams and dependency direction?

## 3. Execution Steps

### Step 1: Detect Validation Target
- If no arguments provided: scan `{{KIRO_DIR}}/specs/` for features with completed tasks `[x]`.
- If feature provided: detect all completed tasks `[x]` in `{{KIRO_DIR}}/specs/{feature}/tasks.md`.
- If both feature and tasks provided: validate specified feature and tasks only.

### Step 2: Gather Context
Reuse steering/spec context already available from conversation:
- `spec.json`, `requirements.md`, `design.md`, `tasks.md`
- Core steering context: `product.md`, `tech.md`, `structure.md`
- Additional steering files only when directly relevant
- Canonical validation commands: `TEST_COMMANDS`, `BUILD_COMMANDS`, `SMOKE_COMMANDS`

### Step 3: Execute Integration Validation
- **Subagent Dispatch (parallel)**: Dispatch independent validation dimensions via **Agent tool** (Test execution, Requirements coverage, Design alignment, Cross-Task Integration).
- If the implementation run explicitly skipped task-local review (for example `--review off`), tighten scrutiny on task-level gaps during integration validation.
- **Mechanical Checks**:
  - Full Test Suite: run canonical full-test command. If tests fail → NO-GO. If command unknown → `MANUAL_VERIFY_REQUIRED`.
  - Residual TBD/TODO/FIXME and residual secrets in feature boundary.
  - Outbox HTML marker reconciliation and conditional auto-merge verification (< 200 LOC, approved, separate merge account).

### Step 4: Synthesize Verdict
- Return `GO`, `NO-GO`, or `MANUAL_VERIFY_REQUIRED`.
- If GO: before reporting feature success, apply `kiro-verify-completion` using the validation result and fresh supporting evidence.
