---
name: kiro-discovery
version: 4.0.0
role_profile: router
header_dependencies:
  - .kiro/steering/product.md
  - .kiro/steering/tech.md
  - .kiro/steering/structure.md
context_mode: inline-spill-chained-recall
proactive_default_mode: observe
description: Entry point for new work. Determines the best action path or work decomposition (update existing spec, create new spec, mixed decomposition, or no spec needed) and refines ideas through structured dialogue.
disable-model-invocation: true
allowed-tools: Read, Write, Glob, Grep, Agent, WebSearch, WebFetch, AskUserQuestion
argument-hint: <idea-or-request>
---

# Kiro Discovery & Admission Skill (v4.0 Super-Harness)

## 1. Static Pre-LLM Admission Gate (`Source → Trigger → Thread → Eval`)
Before running LLM discovery or reading repository files, evaluate the incoming event against the deterministic admission matrix:
1. **Sender Authorization Check:**
   - Non-whitelisted human or unknown bot -> Classify as `ignore` immediately (0 LLM tokens consumed).
   - Whitelisted member with explicit `@Agent` mention or direct `/kiro-*` CLI invocation -> Classify as `explicit`.
   - Whitelisted member without mention or allowlisted CI/bot trigger -> Classify as `inferred` candidate.
2. **Proactive Mode Enforcement (`off | observe | auto`):**
   - If `proactiveMode === "off"`: Drop all `inferred` candidates immediately.
   - If `proactiveMode === "observe"` (Default): Run lightweight evaluation and log the proposed discovery route and boundary candidates to `.kiro/state/harness.db` (`eval_logs`) for Web Panel inspection (port `3082`), but DO NOT create branches, modify files, or open PRs.
   - If `proactiveMode === "auto"`: Proceed to discovery routing for `inferred` candidates that pass rule and model evaluation within bounded scope.
3. **Dynamic Thread Batching:**
   - Group related triggers into a chronological `Thread` and dynamically batch between `1.0` and `2.8` events per evaluation call as incoming message velocity scales.

## 2. Five-Route Boundary-First Discovery Classification
Once admitted, classify the work item into one of the 5 standard `cc-sdd` routes and assign Stable IDs (`REQ-*`, `BND-*`) plus machine-oriented header dependencies to all generated spec artifacts:
1. **Route 1 (Extend Existing Spec):** Emit `policy-changed` notification to any active `Ticket` sharing the affected `_Boundary:_`.
2. **Route 2 (Direct Implementation - No Spec Needed):** Create a single bounded `Ticket` with an explicit file `Mandate` (`< 200` LOC target) and dispatch to `WorkerSlots`.
3. **Route 3 (Single New Spec):** Initialize `.kiro/specs/{feature}/` with header dependency declarations and Boundary Candidates.
4. **Route 4 (Multi-Spec Batch via `/kiro-spec-batch`):** Decompose into dependency waves with explicit `_Depends:_` and `(P)` parallel markers for downstream Router–Worker execution.
5. **Route 5 (Hybrid Decomposition):** Separate immediate hotfix `Tickets` from long-term spec waves.

## 3. Execution Steps

### Step 1: Lightweight Scan
Gather **only metadata** to determine the action path. Do NOT read full file contents yet:
- **Specs inventory**: Glob `{{KIRO_DIR}}/specs/*/spec.json`, read each for `name`, `phase`, and `approvals` status.
- **Steering existence**: Check which files exist in `{{KIRO_DIR}}/steering/` (`product.md`, `tech.md`, `structure.md`, `roadmap.md`).
- **Roadmap check**: If `{{KIRO_DIR}}/steering/roadmap.md` exists, read it to restore project-level context.
- **Top-level structure**: List project root directory to note key directories and files.

### Step 2: Determine Action Path
Based on the user request and Step 1 scan, map to one of the 5 routes:
- **Path A (Route 1 - Existing spec covers this)**: Request fits within an existing spec's domain.
- **Path B (Route 2 - No spec needed)**: Bug fix, config change, simple refactor, or trivial addition (< 200 LOC).
- **Path C (Route 3 - New single-scope feature)**: Clean boundary, fits into a single spec.
- **Path D (Route 4 - Multi-scope decomposition)**: Spans multiple domains or produces 20+ tasks.
- **Path E (Route 5 - Mixed decomposition)**: Combination of existing extensions and new spec candidates.

For Path C/D/E, confirm the determined path with the user before proceeding. For Path A/B, recommend next action and stop.

### Step 3: Deep Context Loading
Only for Path C, D, and E:
- **Steering documents**: Read `product.md` and `tech.md` for project goals and constraints.
- **Relevant specs**: Read adjacent `requirements.md` to define clean boundaries and avoid overlap.
- **Codebase exploration subagent**: Dispatch via **Agent tool** if needed to explore tech stack, module structure, and boundary candidates under 200 lines. Keep exploration out of the main context.

### Step 4: Understand the Idea
Ask clarifying questions sequentially, prioritizing boundary discovery:
1. **Who and why**: Who has the problem? What pain does it cause?
2. **Desired outcome**: What should be true when done?
3. **Boundary candidates**: Natural responsibility seams for independent implementation.
4. **Out of boundary**: What this spec explicitly does NOT own.
5. **Existing vs new**: Extensions to existing specs vs new boundaries.
6. **Upstream / downstream**: Dependency contracts.
7. **Constraints**: Technology, compatibility, performance limits.

### Step 5: Propose Approaches
Propose 2-3 concrete technical approaches with trade-offs (name, how it works, pros, cons, scope estimate).

### Step 6: Create Discovery Artifacts
- **For single spec (Path C)**: Write `{{KIRO_DIR}}/specs/{feature}/brief.md`.
- **For multi-spec (Path D / E)**: Write `{{KIRO_DIR}}/steering/roadmap.md` with spec dependency DAG and parallel wave indicators `(P)`.
- Report next command: `/kiro-spec-init <feature>` or `/kiro-spec-batch`.
