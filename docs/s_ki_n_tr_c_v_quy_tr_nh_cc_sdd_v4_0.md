# Sơ đồ Thiết kế Kiến trúc & Quy trình Vận hành `cc-sdd` v4.0 (Super-Harness)

* **Header Metadata (Machine-Oriented Dependencies):**
  * Depends on: `.kiro/specs/cc-sdd-superagent-refactor/requirements.md` (`SPEC-CC-SDD-V4`)
  * Depends on: `.kiro/specs/cc-sdd-superagent-refactor/design.md`
  * Depends on: `.kiro/specs/cc-sdd-superagent-refactor/tasks.md`

Tài liệu này mô hình hóa toàn bộ kiến trúc hệ thống và các luồng thực thi cốt lõi của **cc-sdd v4.0** sau khi hợp nhất kỷ luật **Boundary-First TDD** với kiến trúc điều phối **Router–Worker** của `dsh-superagent-prototype`.

---

## 1. Sơ đồ Kiến trúc Tổng thể 5 Cam kết Ranh giới (5-Boundary System Architecture)

Sơ đồ dưới đây thể hiện sự phân tách vật lý giữa 5 ranh giới mô-đun (`BND-ROUTER-DISCOVERY`, `BND-EXEC-RUNTIME`, `BND-CONTEXT-MANDATE`, `BND-STATE-ENGINE`, và `BND-SUPERVISION-INTEGRATION`), giải quyết triệt để lỗi tác nhân chính tự viết code trong phiên đơn và hiện tượng phình ngữ cảnh $+223\%$ token.

### 1.1. Bản vẽ Cấu trúc Trực quan (ASCII Blueprint)

```text
+===================================================================================================+
|                        NGUỒN SỰ KIỆN & CON NGƯỜI (SOURCES & HUMAN ATTENTION)                      |
|   [IDE /kiro-* CLI]      [GitHub Issues / PR / Reviews / CI]      [Web Panel :3082 (6 Tabs)]      |
+===================================================================================================+
               |                                   |                                   ^
               v (1. Sự kiện mới)                  v (2. Sự kiện trên luồng đã mở)     | (Cảnh báo /
+-------------------------------------+   +----------------------------------------+   |  Can thiệp)
|     BND-ROUTER-DISCOVERY            |   |          BND-CONTEXT-MANDATE           |   |
|  (Preset: cc-sdd-router - No Edit)  |   |                                        |   |
|                                     |   |  +----------------------------------+  |   |
|  [Source -> Trigger -> Thread]      |   |  |        SubscriptionBus           |  |   |
|                 |                   |   |  | (Direct Event Pass-Through:      |  |   |
|                 v                   |   |  |  Bỏ qua Router, -30% Decisions,  |  |   |
|  [AdmissionGate: Whitelist/@Agent]  |   |  |  -37% Cache-Read Tokens)         |  |   |
|   |-- ignore (0 LLM token)          |   |  +----------------------------------+  |   |
|   |-- inferred (off|observe|auto)   |   |  +----------------------------------+  |   |
|   +-- explicit                      |   |  |         MasterAssessor           |  |   |
|                 |                   |   |  | (Inline _Boundary:_ + Chained    |  |   |
|                 v                   |   |  |  Recall qua Stable ID & Cursor)  |  |   |
|  [EvalBatcher (Batch 1.0 -> 2.8)]   |   |  +----------------------------------+  |   |
|                 |                   |   |  +----------------------------------+  |   |
|                 v                   |   |  |         MandateEnforcer          |  |   |
|  [DagDispatcher: Đọc tasks.md]      |   |  | (Chặn cứng Tool-Adapter ngoài    |  |   |
|  (Phân giải _Depends:_ & nhãn (P))  |   |  |  _Boundary:_ + Pre-LLM Gate)     |  |   |
+-------------------------------------+   +----------------------------------------+   |
               |                                   | (Tiêm thẳng vào hộp thư Worker)   |
               v (Cấp phát Ticket + Mandate)       v                                   |
+======================================================================================+============+
|                                     BND-EXEC-RUNTIME                                 |            |
|                                                                                      |            |
|  +--------------------------------------------------------------------------------+  |            |
|  | Bộ lập lịch WorkerSlots: Giữ chỗ trước | Trần maxWorkers | Khe ưu tiên (+1)   |  |            |
|  +--------------------------------------------------------------------------------+  |            |
|          |                               |                               |           |            |
|          v (Worktree 1)                  v (Worktree 2 - Song song (P))  v (Khe +1)  |            |
|  +-------------------------------+  +-------------------------------+  +----------+  |            |
|  | Executor: worker-task-1.1     |  | Executor: worker-task-1.2     |  | Executor |  |            |
|  | (.kiro/worktrees/feat/1.1)    |  | (.kiro/worktrees/feat/1.2)    |  | (Human   |  |            |
|  |  1. TDD: RED -> GREEN         |  |  1. TDD: RED -> GREEN         |  |  Follow  |  |            |
|  |  2. AsyncShell (>5s -> Nền)   |  |  2. AsyncShell (>5s -> Nền)   |  |  -Up)    |  |            |
|  |  3. Pre-LLM Gate -> Review    |  |  3. Pre-LLM Gate -> Review    |  +----------+  |            |
|  +-------------------------------+  +-------------------------------+                |            |
|          |                                                                           |            |
|          v                                                                           |            |
|  [ConditionalAutoMerge: PR < 200 dòng + Human Approved + Tests GREEN + Tài khoản riêng]           |
+======================================================================================+============+
               |                                                       ^               |
               v (Ghi/Đọc trạng thái & Ý định)                         | (Quét độc lập)|
+----------------------------------------------------+   +-----------------------------+------------+
|                  BND-STATE-ENGINE                  |   |       BND-SUPERVISION-INTEGRATION        |
|          (.kiro/state/harness.db - SQLite)         |   |                                          |
|                                                    |   |  [SemanticWatchdog Loop]                 |
|  * Bảng: tickets, mandates, assignments,           |   |  (Phát hiện lặp git diff / kẹt TDD       |
|          subscriptions, context_chunks             |   |   -> Dừng theo mức độ tác động)          |
|  * Effects Queue: Ghi nhận PENDING trước khi chạy  |   |                                          |
|  * Outbox & AgentDelivery: Chống trùng thẻ HTML    |   |  [Multi-Agent Manifests & 17 SKILL.md]   |
|  * 3-Step Recovery: SQLite + Worktree + GitHub API |   |  (8 Coding Agents x 14 Ngôn ngữ)         |
+----------------------------------------------------+   +------------------------------------------+
```

### 1.2. Sơ đồ Kiến trúc Mermaid.js

```mermaid
flowchart TB
    subgraph Sources["Nguồn Sự kiện & Giao diện Con người"]
        CLI["IDE /kiro-* CLI"]
        GH["GitHub Issues / PR / CI / Comments"]
        WP["Web Panel (:3082 - 6 Tabs)"]
    end

    subgraph BND_ROUTER["1. BND-ROUTER-DISCOVERY (cc-sdd-router)"]
        INGEST["Source -> Trigger -> Thread"]
        ADMIT["AdmissionGate\n(Whitelist / @Agent)"]
        BATCH["EvalBatcher\n(Co giãn lô 1.0 -> 2.8)"]
        DAG["DagDispatcher\n(Đọc _Depends:_ & nhãn (P))"]
        INGEST --> ADMIT
        ADMIT -->|explicit / inferred(auto)| BATCH
        BATCH --> DAG
    end

    subgraph BND_CONTEXT["2. BND-CONTEXT-MANDATE"]
        SUB["SubscriptionBus\n(Direct Event Pass-Through)"]
        ASSESSOR["MasterAssessor\n(Inline _Boundary:_ + Chained Recall)"]
        MANDATE["MandateEnforcer\n(Tool-Adapter Firewall & Pre-LLM Gate)"]
    end

    subgraph BND_EXEC["3. BND-EXEC-RUNTIME (cc-sdd-worker)"]
        SLOTS["WorkerSlots\n(Pre-allocation & Khe ưu tiên maxWorkers + 1)"]
        WT1["Executor 1 + Git Worktree 1\n(Task X.1 - TDD RED/GREEN)"]
        WT2["Executor 2 + Git Worktree 2\n(Task X.2 (P) - TDD RED/GREEN)"]
        SHELL["AsyncShellRunner\n(> 5s chuyển nền, timeout 30p)"]
        MERGE["ConditionalAutoMerge\n(PR < 200 LOC + Approved + Bot riêng)"]
        SLOTS --> WT1 & WT2
        WT1 & WT2 --> SHELL
        WT1 & WT2 --> MERGE
    end

    subgraph BND_STATE["4. BND-STATE-ENGINE (.kiro/state/harness.db)"]
        DB[("SQLite State DB\n(tickets, mandates, assignments)")]
        EFFECTS["Effects Queue & Outbox\n(Ý định trước thực thi + Thẻ HTML)"]
        REC["3-Step Crash Recovery\n(SQLite + Worktree + GitHub API)"]
        DB <--> EFFECTS
        REC --> DB
    end

    subgraph BND_SUP["5. BND-SUPERVISION-INTEGRATION"]
        WD["SemanticWatchdog\n(Quét độc lập & Ngắt lặp vô nghiệm)"]
        REG["8-Agent Registry & Templates\n(cc-sdd-router / cc-sdd-worker)"]
    end

    CLI & GH -->|Sự kiện mới| INGEST
    GH -->|Sự kiện trên luồng đã đăng ký| SUB
    SUB -->|Đi thẳng tới Worker, bỏ qua Router| WT1 & WT2
    DAG -->|Khởi tạo Ticket & Mandate| DB
    DAG -->|Yêu cầu cấp khe| SLOTS
    ASSESSOR <-->|Đọc phân trang O(1)| WT1 & WT2
    MANDATE -->|Chặn ghi tệp ngoài phạm vi| WT1 & WT2
    WT1 & WT2 -->|Ghi Effects trước khi gọi tool/PR| EFFECTS
    WD -->|Giám sát tiến triển thực chất| DB
    WD -->|Dừng theo tác động & Báo cáo| WP
    ADMIT -->|inferred (chế độ observe)| DB
```

---

## 2. Quy trình Tiếp nhận Sự kiện, Phân quyền & Điều phối DAG Song song

Quy trình này mô tả cách một sự kiện đi từ `Source` qua bộ lọc tiền-LLM (tiết kiệm tối đa token đối với tin nhắn nhiễu), gom lô động tại `EvalBatcher`, phân rã đồ thị tác vụ `tasks.md` và cấp phát khe chạy song song trên các thư mục `git worktree` riêng biệt.

```mermaid
flowchart TD
    Start(["Nhận Sự kiện (Source -> Trigger)"]) --> Dedup{"Kiểm tra AgentDelivery\n(Trùng message_id?)"}
    Dedup -- "Đã xử lý" --> DropDedup(["Bỏ qua ngay (0 Token)"])
    Dedup -- "Mới" --> CheckSub{"Thread đã có Ticket &\nSubscription đang mở?"}

    %% Nhánh đi tắt Subscription
    CheckSub -- "Có (Đã gắn Executor)" --> IsHuman{"Tin nhắn từ\nCon người?"}
    IsHuman -- "Có" --> PrioritySlot["Cấp khe ưu tiên (maxWorkers + 1)\nnếu Worker đang tạm nghỉ"]
    IsHuman -- "Không (Log CI / Review / Debug)" --> DirectDeliver["SubscriptionBus: Bơm thẳng vào hộp thư Executor\n(Không gọi cc-sdd-router / Không cập nhật Mandate)"]
    PrioritySlot --> DirectDeliver

    %% Nhánh qua Router
    CheckSub -- "Chưa có (Luồng mới)" --> Whitelist{"Người gửi thuộc\nWhitelist?"}
    Whitelist -- "Không" --> Ignore(["Phân loại: IGNORE\n(Dừng trước khi gọi LLM)"])
    Whitelist -- "Có" --> Mention{"Có @Agent hoặc\nlệnh /kiro-impl?"}

    Mention -- "Có" --> Explicit["Phân loại: EXPLICIT"]
    Mention -- "Không (Thảo luận / CI Bot)" --> Inferred["Phân loại: INFERRED"]

    Inferred --> ModeCheck{"Cấu hình\nproactiveMode?"}
    ModeCheck -- "off" --> Ignore
    ModeCheck -- "observe (Mặc định)" --> LogObserve(["Chạy Eval ngầm & Ghi log vào SQLite\n(Không tạo Ticket / Không gửi thông báo)"])
    ModeCheck -- "auto" --> Batcher

    Explicit --> Batcher["EvalBatcher: Gom sự kiện theo Thread\n(Kích thước lô tự co giãn 1.0 -> 2.8 theo tải)"]
    Batcher --> ParseDAG["DagDispatcher: Đọc spec.json & tasks.md\nKiểm tra _Depends:_ đã [x] và nhãn (P)"]

    ParseDAG --> CompileMandate["Biên dịch _Boundary:_ & File Structure Plan\nthành đối tượng Mandate bất biến trong SQLite"]
    CompileMandate --> ReserveSlot{"WorkerSlots: Giữ chỗ trước\n(Còn khe < maxWorkers?)"}

    ReserveSlot -- "Hết khe" --> QueueWait["Xếp hàng đợi trong SQLite\n(Chờ khe giải phóng)"]
    ReserveSlot -- "Còn khe" --> CreateWT["GitWorktreeManager:\ngit worktree add .kiro/worktrees/<feature>/task-<id>"]
    CreateWT --> SpawnWorker(["Khởi chạy phiên cc-sdd-worker độc lập\n(Song song hóa hoàn toàn các tác vụ (P))"])
```

---

## 3. Biểu đồ Tuần tự (Sequence Diagram): Chu trình TDD của Worker, `SubscriptionBus` & Tường lửa `Mandate`

Biểu đồ tuần tự dưới đây làm rõ cách `cc-sdd-worker` thực hiện chu trình TDD (`RED` $\rightarrow$ `GREEN`), cách `MandateEnforcer` chặn đứng hành vi sửa lẹm tệp ngoài phạm vi, cách các lệnh kiểm thử chạy quá $5\text{s}$ được chuyển xuống nền, và cách toàn bộ vòng lặp `kiro-review` / `kiro-debug` giao tiếp trực tiếp qua `SubscriptionBus` mà không làm tốn token của `cc-sdd-router`.

```mermaid
sequenceDiagram
    autonumber
    actor Human as Kỹ sư / GitHub CI
    participant Router as cc-sdd-router
    participant DB as SQLite + Effects
    participant Sub as SubscriptionBus
    participant Worker as cc-sdd-worker (Worktree)
    participant Assessor as MasterAssessor
    participant Firewall as MandateEnforcer
    participant Shell as AsyncShellRunner
    participant Review as kiro-review / kiro-debug

    Router->>DB: 1. Tạo Ticket + Mandate bất biến + Giữ khe WorkerSlots
    Router->>Worker: 2. Khởi tạo phiên trong .kiro/worktrees/<feat>/task-X.Y
    Note over Router,Worker: Router rút lui hoàn toàn khỏi vòng lặp thực thi của Ticket này

    Worker->>Assessor: 3. Nạp phần đầu cố định (KV Prefix Cache) + Inline _Boundary:_
    Assessor-->>Worker: 4. Trả về Chunk nội tuyến + Con trỏ (Cursor) cho Chained Recall

    rect rgb(240, 248, 255)
        Note over Worker,Firewall: Pha 1: Kiểm soát Ranh giới Cứng ở Tầng Công cụ (Tool-Adapter)
        Worker->>Firewall: 5. Gọi write_file("src/shared/unowned.ts") (Ngoài _Boundary:_)
        Firewall-->>Worker: 6. CHẶN CỨNG: MANDATE_BOUNDARY_VIOLATION (Không chạm ổ đĩa)
        Worker->>Firewall: 7. Gọi write_file("src/context/masterAssessor.ts") (Hợp lệ)
        Firewall->>DB: 8. Ghi nhận Effects (PENDING) -> Thực thi ghi tệp -> COMPLETED
    end

    rect rgb(245, 255, 245)
        Note over Worker,Shell: Pha 2: Chu trình TDD (RED -> GREEN) & Lệnh nền > 5 giây
        Worker->>Shell: 9. Chạy TEST_COMMANDS (Pha RED -> Viết code -> Pha GREEN)
        Shell-->>Worker: 10. Nếu chạy > 5.000ms: Trả ngay {status: "BACKGROUNDED", jobId}
        Shell->>Sub: 11. Khi hoàn tất (< 30 phút): Bắn kết quả test qua SubscriptionBus
        Sub->>Worker: 12. Đẩy thẳng kết quả vào hộp thư Worker (0 Router token)
    end

    rect rgb(255, 250, 240)
        Note over Worker,Review: Pha 3: Cổng Cơ học Tiền-LLM & Kiểm duyệt Độc lập
        Worker->>Firewall: 13. Yêu cầu kích hoạt kiro-review
        Firewall->>Firewall: 14. Pre-LLM Gate: Kiểm tra exitCode == 0 & git diff hợp lệ
        Firewall->>Review: 15. Gọi subagent kiro-review (Chỉ đọc git diff + Mandate)
        alt Phát hiện lỗi (CRITICAL / WARNING)
            Review->>Sub: 16a. Trả báo cáo lỗi qua SubscriptionBus
            Sub->>Worker: 17a. Đi thẳng tới Worker (hoặc gọi kiro-debug nếu kẹt >= 2 lần)
        else Đạt chuẩn (APPROVED)
            Review->>Sub: 16b. Trả kết quả APPROVED
            Sub->>Worker: 17b. Xác nhận hoàn tất (kiro-verify-completion)
        end
    end

    Worker->>DB: 18. Đẩy Outbox (kèm thẻ HTML chống trùng) -> Tạo PR & Cập nhật tasks.md [x]
    Human->>Sub: 19. Duyệt PR (Approved) trên GitHub
    Sub->>Worker: 20. Kiểm tra PR < 200 dòng + Tests GREEN -> Thực thi Auto-Merge qua tài khoản riêng
```

---

## 4. Sơ đồ Máy Trạng thái (State Diagram): Vòng đời `Ticket` & Quản lý Khe `WorkerSlots`

Sơ đồ này thể hiện vòng đời đầy đủ của một `Ticket` trong bảng `tickets` của SQLite, đặc biệt nhấn mạnh cơ chế **giải phóng khe thực thi ngay khi chờ con người** (`WAITING_FOR_HUMAN`) và **cấp phát khe ưu tiên vượt trần** (`maxWorkers + 1`) khi con người phản hồi.

```mermaid
stateDiagram-v2
    [*] --> CREATED: DagDispatcher tạo Ticket từ tasks.md

    CREATED --> QUEUED_FOR_SLOT: Đợi cấp phát khe trong WorkerSlots
    QUEUED_FOR_SLOT --> WORKTREE_READY: reserveSlot() thành công (< maxWorkers)\n& Khởi tạo Git Worktree riêng

    WORKTREE_READY --> TDD_EXECUTING: Nạp MasterAssessor & Bắt đầu RED -> GREEN

    TDD_EXECUTING --> BACKGROUND_WAITING: Lệnh Test/Build chạy > 5 giây\n(Tách tiến trình nền có job_id)
    BACKGROUND_WAITING --> TDD_EXECUTING: Sự kiện hoàn tất về qua SubscriptionBus

    TDD_EXECUTING --> PRE_LLM_GATE: Code hoàn tất, yêu cầu kiểm duyệt
    PRE_LLM_GATE --> TDD_EXECUTING: Từ chối cơ học (Test != 0 hoặc Diff ngoài Mandate)\n[0 Token LLM tiêu thụ]
    PRE_LLM_GATE --> KIRO_REVIEWING: Vượt qua cổng cơ học -> Gọi kiro-review

    KIRO_REVIEWING --> TDD_EXECUTING: Phản hồi lỗi (Lần 1-2) qua SubscriptionBus
    KIRO_REVIEWING --> KIRO_DEBUGGING: Lặp lại cùng lỗi >= 2 lần -> Gọi kiro-debug
    KIRO_DEBUGGING --> TDD_EXECUTING: Bơm kế hoạch sửa lỗi qua SubscriptionBus

    TDD_EXECUTING --> WAITING_FOR_HUMAN: Phát hiện lỗi đặc tả thượng nguồn / Handoff\n[GIẢI PHÓNG NGAY KHE WORKERSLOTS]
    KIRO_DEBUGGING --> WAITING_FOR_HUMAN: Vượt quá 2 vòng Debug không thành công\n[GIẢI PHÓNG NGAY KHE WORKERSLOTS]
    TDD_EXECUTING --> WATCHDOG_HALTED: SemanticWatchdog phát hiện lặp git diff vô nghiệm\n[Dừng theo tác động & Giải phóng khe]

    WAITING_FOR_HUMAN --> HUMAN_PRIORITY_EXEC: Con người phản hồi trên PR / Web Panel\n[Cấp ngay khe ưu tiên maxWorkers + 1]
    HUMAN_PRIORITY_EXEC --> TDD_EXECUTING: Tiếp tục trong cùng Worktree (Mandate giữ nguyên)

    KIRO_REVIEWING --> PR_READY: kiro-review APPROVED & kiro-verify-completion đạt
    PR_READY --> AUTO_MERGING: PR < 200 dòng + Con người Approved + CI GREEN\n(Tự rút cờ nếu có commit mới đẩy lên)
    PR_READY --> WAITING_FOR_HUMAN: PR >= 200 dòng (Chờ con người merge)

    AUTO_MERGING --> COMPLETED: Merge bằng tài khoản riêng & Đánh dấu [x] trong tasks.md
    WAITING_FOR_HUMAN --> COMPLETED: Con người đóng / Merge thủ công
    COMPLETED --> [*]: Dọn dẹp Git Worktree & Giải phóng khe
```

---

## 5. Sơ đồ Cơ chế Ngữ cảnh `MasterAssessor` & Tối ưu Bộ nhớ Đệm (KV Prefix Cache)

Để loại bỏ mức phạt $+223\%$ token của kỹ năng `kiro-impl` cũ (do nạp đi nạp lại toàn bộ `requirements.md`, `design.md`, `steering/*.md` và ghi nối tiếp vào `## Implementation Notes`), `MasterAssessor` tổ chức lại bộ nhớ theo mô hình **Inline–Spill–Chained Recall** với tiền tố bất biến:

```text
+---------------------------------------------------------------------------------------------------+
|                     CẤU TRÚC NGỮ CẢNH CỦA WORKER (OPTIMIZED KV PREFIX CACHE)                      |
+---------------------------------------------------------------------------------------------------+
| PHẦN 1: TIỀN TỐ BẤT BIẾN (STATIC PREFIX - ĐƯỢC LƯU CACHE 100% GIỮA CÁC LƯỢT GỌI)                  |
|  [1.1] System Prompt & Quy tắc Cốt lõi của cc-sdd-worker (Không chứa biến động thời gian thực)    |
|  [1.2] Đối tượng Mandate Bất biến (Danh sách tệp được phép sửa & Lệnh kiểm thử của Ticket X.Y)    |
|  [1.3] Phần Nội tuyến (Inline Context): Chỉ trích xuất đúng khối _Boundary:_ của Ticket X.Y       |
+---------------------------------------------------------------------------------------------------+
| PHẦN 2: TRUY HỒI CHUỖI CÓ NGÂN SÁCH (SPILL & CHAINED RECALL - ĐỘ PHỨC TẠP O(1) TOKEN)             |
|  Thay vì nạp toàn bộ tài liệu, phần tràn (Spill) được lưu trong bảng SQLite `context_chunks`:     |
|                                                                                                   |
|   +-------------------------------+       readChunk(stableId, cursor, maxChars)                   |
|   | Bảng SQLite `context_chunks`  | <===============================================+             |
|   |  * REQ-SPD-02 (Chunk #01..03) |                                                 |             |
|   |  * BND-EXEC   (Chunk #04..08) | === Trả về đúng trang cần đọc + Cursor tiếp ===>+             |
|   |  * Impl Notes (Chunk #09..15) |     (Giữ nguyên lịch sử phía trước để trúng KV Cache)         |
|   +-------------------------------+                                                               |
+---------------------------------------------------------------------------------------------------+
```

---

## 6. Sơ đồ Giao thức Bền vững `SQLite + Effects + Outbox` & Phục hồi 3 Bước Sau Sự cố

Sơ đồ cuối cùng mô tả cơ chế bảo vệ tính đúng đắn của hệ thống khi xảy ra sự cố sập nguồn đột ngột (`SIGKILL` / mất kết nối mạng) hoặc khi người dùng sửa đổi tệp đặc tả (`design.md`, `steering/*.md`) trong lúc các Worker đang chạy.

```mermaid
flowchart LR
    subgraph NormalFlow["1. Chu trình Ghi nhận Ý định Trước (Pre-Execution Effects)"]
        W["cc-sdd-worker"] -->|1. Ghi ý định PENDING| EQ[("SQLite: effects_queue\n& outbox_receipts")]
        EQ -->|2. Thực thi hành động| ACT["Chạy Shell / Đẩy Git / Gửi Bình luận PR\n(Nhúng thẻ ẩn <!-- cc-sdd-msg-id: UUID -->)"]
        ACT -->|3. Cập nhật biên nhận| DONE["Đánh dấu COMPLETED\ntrong SQLite"]
    end

    subgraph CrashRecovery["2. Giao thức Phục hồi 3 Bước Khi Khởi động lại (3-Step Recovery)"]
        BOOT(["Khởi động lại sau sự cố"]) --> STEP1["Bước 1: Quét bảng tickets & effects_queue\ntìm các mục đang IN_PROGRESS / PENDING"]
        STEP1 --> STEP2["Bước 2: Kiểm tra thực địa Git Worktree\n(git status, git log, kết quả test gần nhất)"]
        STEP2 --> STEP3["Bước 3: Truy vấn GitHub API (gh)\nTìm thẻ <!-- cc-sdd-msg-id: UUID --> trên PR"]
        STEP3 --> RECON{"Hành động từ xa\nđã thực hiện chưa?"}
        RECON -- "Đã có trên GitHub" --> SKIP["Cập nhật biên nhận COMPLETED\n(Không gửi/tạo PR trùng lặp)"]
        RECON -- "Chưa thực hiện" --> RESUME["Khôi phục đúng pha TDD đang dở\n(Không chạy lại pha RED từ đầu)"]
    end

    subgraph PolicyUpdate["3. Cập nhật Đặc tả Không Hủy ngang (Non-Destructive Policy Reload)"]
        EDIT(["Kỹ sư sửa design.md / steering/*.md"]) --> INVALIDATE["Router: Vô hiệu hóa các lượt Eval đang chờ\n& Xếp hàng đánh giá lại theo phiên bản mới"]
        INVALIDATE --> NOTIFY["Phát sự kiện policy-changed qua SubscriptionBus\nvào hộp thư của các Executor đang chạy"]
        NOTIFY --> SAFE["Worker hoàn tất bước hiện tại an toàn,\nđọc lại chunk mới qua MasterAssessor"]
    end
```