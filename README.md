# cc-sdd-superagent: Super-Harness v4.0 for Autonomous Spec-Driven Development

<!-- npm badges -->
[![npm version](https://img.shields.io/npm/v/cc-sdd?logo=npm)](https://www.npmjs.com/package/cc-sdd?activeTab=readme)
[![install size](https://packagephobia.com/badge?p=cc-sdd)](https://packagephobia.com/result?p=cc-sdd)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

<div align="center" style="font-size: 1.1rem; margin-bottom: 1rem;"><sub>
Package README: <a href="./tools/cc-sdd/README.md">English</a> | <a href="./tools/cc-sdd/README_ja.md">日本語</a> | <a href="./tools/cc-sdd/README_zh-TW.md">繁體中文</a>
</sub></div>

## Turn approved specs into high-performance autonomous implementation

`cc-sdd-superagent` transforms AI coding agents into a coordinated **Super-Harness v4.0 Router–Worker Architecture**. One command installs a complete agentic SDLC workflow as Agent Skills across 8 AI coding agents: discovery, requirements, design, tasks, DAG wave dispatch, isolated worktrees, and autonomous TDD execution with pre-LLM gates.

👻 **Kiro-inspired.** Preserves the spec-driven, agentic SDLC style of Kiro IDE. Existing Kiro specs remain 100% compatible and portable.

---

## 🚀 What's New in Super-Harness v4.0

cc-sdd v4.0 introduces the **Super-Harness Router–Worker Architecture**, resolving the context explosion, sequential bottlenecks, and prompt bloat of single-session agents:

### 1. Router–Worker Separation (`REQ-TPL-01`)
- **`cc-sdd-router`**: Read-only coordination profile. Analyzes the task DAG, manages `WorkerSlots`, batches events via an Admission Gate, and dispatches tickets. Source-code modification tools (`Edit`/`Write`) are locked at the tool-adapter boundary.
- **`cc-sdd-worker`**: Execution profile running in dedicated, isolated `git worktree` workspaces (`.kiro/worktrees/<feature>/task-<X-Y>`). Executes TDD RED → GREEN cycles under strict, immutable `Mandate` boundaries.

### 2. Standardized 3-Tier KV Prefix Caching (`REQ-TPL-02`)
Every skill file features a locked machine-oriented header and invariant static prefix block (`## 1. Static Core Invariants`), achieving up to **37% cache-read token savings** across worker sessions:
- **Tier 1 (Static System Invariants)**: Core rules (Attention Conservation, Immutable Mandate, Evidence Over Prose) locked for 100% KV cache hit rate.
- **Tier 2 (Protocol Contract)**: Execution workflow and `MasterAssessor` cursor interfaces.
- **Tier 3 (Dynamic Task Slot)**: Budgeted inline payload containing only current task boundaries and Stable ID cursors.

### 3. Pre-LLM Admission Gate & Dynamic Thread Batching (`REQ-TPL-03`)
- **Deterministic Filter**: Incoming triggers evaluated against a deterministic matrix (`Source → Trigger → Thread → Eval`) classifying events as `explicit`, `inferred`, or `ignore` (0 token waste).
- **Proactive Modes**: `off`, `observe` (default: logs evaluations to SQLite `.kiro/state/harness.db` for Web Panel inspection without disk changes), and `auto`.
- **Dynamic Thread Batching**: Automatically groups and batches events ($1.0 \rightarrow 2.8$ events/call) as message velocity scales.

### 4. Concurrent DAG Wave Scheduling & WorkerSlots (`REQ-TPL-04`)
- Removes the sequential "1 task per iteration" lock.
- Tasks marked with `(P)` whose `_Depends:_` prerequisites are met are grouped into parallel execution waves.
- `WorkerSlots` concurrency management: maintains `maxWorkers` pool plus 1 dedicated priority slot (`maxWorkers + 1`) reserved strictly for human steering messages.
- Shell commands (`TEST_COMMANDS`, `BUILD_COMMANDS`, `SMOKE_COMMANDS`) taking >5s automatically move to background jobs (`job_id`, 30-min timeout).

### 5. MasterAssessor Budgeted Context Retrieval (`REQ-TPL-05`)
- Replaces monolithic spec injection with `Inline–Spill–Chained Recall`.
- Workers load only inline `_Boundary:_` annotations and use cursor pagination by Stable ID (`Task ID -> Boundary ID -> Design Section -> Note ID`) to read deep context on demand, slashing token consumption by **-72%**.

### 6. Direct SubscriptionBus & Pre-LLM Mechanical Gate (`REQ-TPL-06`)
- `kiro-review` and `kiro-debug` route verdicts directly to active Worker sessions via `SubscriptionBus`, eliminating router round-trips.
- Pre-LLM gate mechanically verifies test exit code `0` and ensures zero out-of-mandate diff paths before invoking model reviewers (saving thousands of wasted tokens on failing builds).

### 7. Immutable Mandate & Semantic Watchdog (`REQ-TPL-07`)
- Task `_Boundary:_` and *File Structure Plan* compile into an immutable `Mandate`. Comments, notes, or logs cannot expand file permissions.
- Upstream contract defects immediately trigger `handoff(UPSTREAM_DEFECT)` to Router, releasing the worker slot.
- Semantic Watchdog records diff fingerprints and test telemetry in SQLite `Effects` queue, stopping thrashing loops by impact (*stop by impact*).

### 8. Idempotent Outbox & Conditional Auto-Merge (`REQ-TPL-08`)
- Hidden HTML message markers (`<!-- cc-sdd-outbox: <id> -->`) prevent duplicate commit and comment publishing across network retries.
- Conditional auto-merge enabled for PRs < 200 LOC with approval; automatically retracts before pushing new commits.

---

## 📊 Benchmark & Performance Comparison (SPEC-FLASH-SALE-2026)

Tested on a real-world flash-sale microservice workflow with a stream of 300 messages and 6 dependent tasks:

| KPI Metric | Baseline (Single-Session) | cc-sdd v3.0 | cc-sdd v4.0 (Super-Harness) | Improvement |
|---|---|---|---|---|
| **6-Task DAG Run Time** | 24.65 min | 29.85 min | **12.18 min** | **-58.5%** |
| **Tail Latency (P95)** | 29.5 min | 27.8 min | **15.7 min** | **-46.8%** |
| **Human Priority Slot Wait** | 8.4 min | 6.2 min | **0.1 min** | **Instant (max+1)** |
| **Total Tokens per Feature** | 82,200 | 333,600 | **23,050** | **-72.0%** |
| **Cache-Read Tokens** | 36.87 M | 36.87 M | **23.23 M** | **-37.0%** |
| **Router Decisions / 100 events** | 100 | 100 | **20** | **-80.0%** |
| **Token Waste on Failing Tests** | 0 | 18,000 | **0** | **100% blocked** |
| **Accuracy (21 Test Cases)** | 23.8% (5/21) | 85.7% (18/21) | **100% (21/21)** | **+14.3%** |
| **Out-of-Mandate File Leaks** | 1 file | 1 file | **0 files** | **100% blocked** |
| **Watchdog Thrashing Rounds** | 8 rounds | 4 rounds | **2 rounds** | **Early stop** |
| **Duplicate PR/Outbox Events** | 1 | 1 | **0** | **100% deduped** |

---

## ⚡ Quick Start

```bash
cd your-project
npx cc-sdd@latest
```

The default installs **Claude Code Skills** with English documentation. To configure another agent or language:

```bash
npx cc-sdd@latest --codex-skills --lang ja      # Codex ($kiro-*), Japanese
npx cc-sdd@latest --cursor-skills --lang en     # Cursor IDE, English
npx cc-sdd@latest --devin                       # Devin Local / CLI
npx cc-sdd@latest --antigravity                 # Google Antigravity
```

### Supported Coding Agents (8 Platforms, 17 Skills Each)

| Agent | Skills Mode Flag | Command Syntax | Status |
|---|---|---|---|
| **Claude Code** | `--claude-skills` | `/kiro-*` | Stable |
| **Codex CLI** | `--codex-skills` | `$kiro-*` | Stable |
| **Cursor IDE** | `--cursor-skills` | `/kiro-*` | Beta |
| **GitHub Copilot** | `--copilot-skills` | `/kiro-*` | Beta |
| **Devin Local / CLI** | `--devin` / `--devin-skills` | `/kiro-*` | Beta |
| **Windsurf / Cascade** | `--windsurf-skills` | `@kiro-*` | Deprecated (Migrate to Devin) |
| **OpenCode** | `--opencode-skills` | `/kiro-*` | Beta |
| **Gemini CLI** | `--gemini-skills` | `/kiro-*` | Beta |
| **Antigravity** | `--antigravity` | `/kiro-*` | Beta |

---

## 🛠️ Core Workflow

```bash
/kiro-discovery <idea>
```

Not sure where to start? Run `kiro-discovery`. It inspects your project state, runs the admission gate, and recommends the optimal path:

| You want to... | Flow |
|---|---|
| **Start a new feature** | `kiro-discovery` → `kiro-spec-init` → `kiro-spec-requirements` → `kiro-spec-design` → `kiro-spec-tasks` → `kiro-impl` |
| **Extend an existing system** | `kiro-steering` → `kiro-discovery` → optional `kiro-validate-gap` → `kiro-spec-design` → `kiro-spec-tasks` → `kiro-impl` |
| **Multi-spec batch initiative** | `kiro-discovery` → `kiro-spec-batch` (parallel dependency waves) |
| **Direct hotfix (no spec)** | `kiro-discovery` → direct implementation ticket (`< 200` LOC) |

### Autonomous Implementation Loop (`/kiro-impl`)

```bash
/kiro-impl photo-albums
```

When invoked:
1. **Router Phase**: Reconciles SQLite state (`harness.db`), resolves DAG dependencies, and spawns parallel waves for `(P)` tasks.
2. **Worker Dispatch**: Allocates `WorkerSlots`, creates isolated `git worktree`, compiles immutable `_Boundary:_` into a `Mandate`, and starts TDD.
3. **Mechanical Gate & Direct Review**: Runs test exit-code check (`0`) and diff validation before dispatching `kiro-review` directly via `SubscriptionBus`.
4. **Completion**: Updates checkbox `- [x]` in `tasks.md`, logs effect to SQLite, and triggers conditional auto-merge (< 200 LOC).

---

## 🖥️ Web Panel Dashboard (Port 3082)

Run the client dashboard to monitor the autonomous engine in real time:

```bash
npx cc-sdd panel
```

- **Tickets View**: Live view of pending, active, and completed tickets.
- **WorkerSlots Monitor**: Real-time worker allocation, worktree paths, and human priority slot status.
- **DAG Visualizer**: Interactive graph of task dependencies and parallel waves.
- **Effects Queue & Outbox**: Audit log of SQLite effects, shell background jobs, and GitHub outbox markers.
- **Attention Center**: Actionable interface for human approvals and upstream defect escalations.

---

## 📚 Documentation & Guides

- [Skill Reference](docs/guides/skill-reference.md): Detailed 17-skill reference and subagent flows.
- [Why cc-sdd? Rationale & Architecture](docs/guides/why-cc-sdd.md): Design philosophy and boundary discipline.
- [Customization Guide](docs/guides/customization-guide.md): Customizing templates, steering, and EARS rules.
- [Migration Guide](docs/guides/migration-guide.md): Upgrading from v1.x/v2.x to v4.0.
- [Agent Compatibility](docs/guides/agent-compatibility.md): Platform capabilities, subagent limits, and worktree requirements.

---

## License

MIT License. See [LICENSE](./LICENSE) for details.
