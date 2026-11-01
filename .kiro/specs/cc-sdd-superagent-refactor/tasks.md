# Tasks: cc-sdd-superagent-refactor

* **Header Metadata (Machine-Oriented Dependencies):** Phụ thuộc vào `.kiro/specs/cc-sdd-superagent-refactor/requirements.md` và `.kiro/specs/cc-sdd-superagent-refactor/design.md`.

* **Quy ước Thực thi (`/kiro-impl` Protocol):**
  * Các đầu mục lớn (`1.`, `2.`, ...) là nhóm phân loại; đơn vị thực thi thực tế là các tác vụ con đánh số `X.Y`.
  * Nhãn `(P)` ngay sau mã số biểu thị tác vụ có thể được phân phối chạy song song trên các `git worktree` riêng biệt ngay khi các tác vụ trong `_Depends:_` đã được đánh dấu `[x]`.
  * Mọi tác vụ bắt buộc tuân thủ chu trình TDD (`RED → GREEN`) sau cờ tính năng, vượt qua kiểm duyệt độc lập (`kiro-review` trả về `APPROVED`) và xác thực hoàn tất (`kiro-verify-completion`) trước khi đổi trạng thái từ `- [ ]` sang `- [x]`.

### 1. Khởi tạo Tầng Lưu trữ Bền vững SQLite, Hàng đợi Effects và Phục hồi (State & Recovery Engine)

* [x] **1.1** Thiết kế lược đồ SQLite và cơ chế khóa đơn bản sao (Single-Replica State Lock) cho `.kiro/state/harness.db`.
  * *Boundary:* `BND-STATE-ENGINE` (`tools/cc-sdd/src/core/db/schema.ts`, `tools/cc-sdd/src/core/assignments.ts`)
  * *Depends:* `None`
  * *Reqs:* `REQ-ACC-02`
  * *TDD Verification (`RED → GREEN`):* Viết bài kiểm thử xác nhận việc khởi tạo đầy đủ các bảng `tickets`, `mandates`, `assignments`, `subscriptions`, `effects_queue`, `outbox_receipts`; kiểm thử tình huống 2 tiến trình cùng mở một thư mục trạng thái phải chặn tiến trình thứ hai để tránh ghi đè dữ liệu.

* [x] **1.2 (P)** Xây dựng hàng đợi `Effects` ghi nhận ý định trước, bộ chống trùng lặp đầu vào `AgentDelivery` và bộ đối soát thẻ HTML cho `Outbox`.
  * *Boundary:* `BND-STATE-ENGINE` (`tools/cc-sdd/src/core/effects.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-ACC-02`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử kịch bản nạp lại cùng một `message_id` vào `AgentDelivery` chỉ được thực thi đúng 1 lần; kiểm thử `Outbox` nhúng thẻ `<!-- cc-sdd-msg-id: ... -->` vào bình luận GitHub và tự động bỏ qua việc gửi lại nếu tìm thấy thẻ này trên luồng từ xa khi mạng bị trễ.

* [x] **1.3 (P)** Hiện thực hóa giao thức phục hồi 3 bước sau sự cố (3-Step Crash Recovery) và trình chiếu trạng thái tự động ra `tasks.md`.
  * *Boundary:* `BND-STATE-ENGINE` (`tools/cc-sdd/src/core/recovery.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-ACC-02`
  * *TDD Verification (`RED → GREEN`):* Giả lập ngắt tiến trình đột ngột khi một `Ticket` đang ở pha `GREEN` nhưng chưa tạo PR; kiểm thử trình phục hồi tự động đối chiếu bản ghi SQLite, `git status`/`git log` trong worktree và trạng thái nhánh từ xa để tiếp tục bước tạo PR mà không chạy lại pha `RED` từ đầu.

### 2. Xây dựng Động cơ Ngữ cảnh Có Ngân sách và Tường lửa Mandate (Context & Security Plane)

* [x] **2.1 (P)** Xây dựng bộ lập chỉ mục tài liệu đặc tả theo ID ổn định và giao diện đọc có ngân sách `MasterAssessor` (`Inline–Spill–Chained Recall`).
  * *Boundary:* `BND-CONTEXT-MANDATE` (`tools/cc-sdd/src/context/masterAssessor.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-TOK-02`, `REQ-TOK-03`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử việc phân tách các tệp `requirements.md`, `design.md`, `steering/*.md` và `## Implementation Notes` thành các khối dữ liệu trong bảng `context_chunks`; xác nhận hàm đọc trả về đúng số ký tự giới hạn kèm con trỏ phân trang (cursor) và trích dẫn gốc, đồng thời giữ nguyên cấu trúc tiền tố prompt bất biến.

* [x] **2.2 (P)** Triển khai đường truyền sự kiện trực tiếp `SubscriptionBus` (Direct Event Pass-Through) bỏ qua Router.
  * *Boundary:* `BND-CONTEXT-MANDATE` (`tools/cc-sdd/src/context/subscriptionBus.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-TOK-01`
  * *TDD Verification (`RED → GREEN`):* Viết bài kiểm thử xác nhận khi một `Ticket` đang thuộc quyền sở hữu của một `Executor`, mọi sự kiện phản hồi từ `kiro-review`, `kiro-debug`, log kiểm thử và tin nhắn của con người trên `Thread` đó đều đi thẳng vào phiên của `Executor` với 0 lần gọi đánh giá lại tại `cc-sdd-router`.

* [x] **2.3 (P)** Xây dựng bộ cưỡng chế `MandateEnforcer` ở tầng công cụ và cổng lọc cơ học tiền-LLM (Pre-LLM Mechanical Gate).
  * *Boundary:* `BND-CONTEXT-MANDATE` (`tools/cc-sdd/src/security/mandateEnforcer.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-ACC-01`, `REQ-TOK-03`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử việc biên dịch trường `_Boundary:_` thành đối tượng `Mandate` bất biến; xác nhận mọi lệnh sửa tệp ngoài danh sách cho phép bị chặn cứng ngay ở tool-adapter trước khi chạm tới ổ đĩa; xác nhận tin nhắn mới trong `Subscription` không thể mở rộng `Mandate`; và xác nhận `kiro-review` không được gọi nếu `TEST_COMMANDS` trả về mã lỗi khác `0`.

### 3. Xây dựng Bộ lập lịch Song song, Git Worktree và Thực thi Bất đồng bộ (Execution Runtime)

* [x] **3.1 (P)** Hiện thực hóa bộ quản lý khe thực thi `WorkerSlots` với cơ chế giữ chỗ trước và khe ưu tiên `maxWorkers + 1` cho con người.
  * *Boundary:* `BND-EXEC-RUNTIME` (`tools/cc-sdd/src/execution/workerSlots.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-SPD-03`
  * *TDD Verification (`RED → GREEN`):* Mô phỏng 10 tác vụ bất đồng bộ cùng lúc yêu cầu khe khi `maxWorkers = 3` để xác nhận không xảy ra xung đột vượt trần; xác nhận tin nhắn tiếp nối từ con người được cấp phát ngay khe thứ 4 (`maxWorkers + 1`) và được xử lý trước hàng đợi tác vụ mới; xác nhận khe được giải phóng ngay khi `Executor` gọi `handoff` chờ người duyệt.

* [x] **3.2 (P)** Xây dựng trình quản lý vòng đời `GitWorktreeManager` cô lập không gian làm việc cho từng `Ticket`.
  * *Boundary:* `BND-EXEC-RUNTIME` (`tools/cc-sdd/src/execution/worktreeManager.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-SPD-02`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử khởi tạo đồng thời 3 `git worktree` cho 3 tác vụ gắn nhãn `(P)` từ cùng một kho mã nguồn; xác nhận cả 3 phiên `cc-sdd-worker` có thể sửa tệp, chạy kiểm thử và thực hiện `git commit` song song mà không gây lỗi khóa chỉ mục (`.git/index.lock`) hay ghi đè tệp của nhau.

* [x] **3.3 (P)** Triển khai trình chạy lệnh `AsyncShellRunner` tự động chuyển xuống nền sau 5 giây và cơ chế `ConditionalAutoMerge` dưới 200 dòng.
  * *Boundary:* `BND-EXEC-RUNTIME` (`tools/cc-sdd/src/execution/asyncShell.ts`, `tools/cc-sdd/src/execution/autoMerge.ts`)
  * *Depends:* `1.2`, `2.2`
  * *Reqs:* `REQ-SPD-04`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử một lệnh shell kéo dài 12 giây phải được tách xuống nền đúng ở mốc 5 giây, trả về `job_id` để phiên Worker tiếp tục nhận tin nhắn và tự động hủy nếu chạy quá 30 phút; kiểm thử bộ Auto-Merge chỉ kích hoạt khi PR `< 200` dòng thay đổi, đã có phê duyệt của con người, dùng tài khoản tách biệt và tự động hủy auto-merge ngay trước khi đẩy bản sửa đổi mới.

### 4. Xây dựng Tầng Điều phối Router, Lọc Sự kiện và Phân rã Đồ thị (Router & Discovery Layer)

* [x] **4.1 (P)** Xây dựng cổng phân quyền `AdmissionGate` (`explicit | inferred | ignore`), chế độ chủ động `off | observe | auto` và bộ gom lô `EvalBatcher`.
  * *Boundary:* `BND-ROUTER-DISCOVERY` (`tools/cc-sdd/src/router/admission.ts`, `tools/cc-sdd/src/router/evalBatcher.ts`)
  * *Depends:* `1.1`
  * *Reqs:* `REQ-SPD-01`, `REQ-TOK-03`, `REQ-ACC-03`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử ma trận người gửi ngoài danh sách cho phép bị loại bỏ (`ignore`) với 0 token LLM tiêu thụ; xác nhận chế độ mặc định `observe` chỉ ghi nhật ký ứng viên `inferred` vào SQLite mà không tạo `Ticket` thực thi; xác nhận kích thước lô đánh giá tự động tăng từ 1,0 lên ~2,8 khi tốc độ sự kiện tăng từ 1 lên 40 tin nhắn/phút.

* [x] **4.2** Hiện thực hóa bộ điều phối đồ thị `DagDispatcher` cho các tác vụ `(P)` và cơ chế phát tín hiệu `policy-changed` không gián đoạn.
  * *Boundary:* `BND-ROUTER-DISCOVERY` (`tools/cc-sdd/src/router/dagDispatcher.ts`)
  * *Depends:* `2.3`, `3.1`, `3.2`, `4.1`
  * *Reqs:* `REQ-SPD-01`, `REQ-SPD-02`, `REQ-ACC-03`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử việc phân tích `tasks.md` để đẩy toàn bộ các tác vụ `(P)` không phụ thuộc lẫn nhau vào `WorkerSlots` và `GitWorktreeManager` cùng lúc; kiểm thử khi sửa tệp `.kiro/steering/tech.md` hoặc `design.md` giữa chừng, hệ thống xếp hàng đánh giá lại các mục chờ trong `Eval` và gửi sự kiện `policy-changed` vào các `Ticket` đang chạy mà không hủy ngang làm hỏng code đang viết.

### 5. Triển khai Giám sát Watchdog, Web Panel và Tích hợp Đa Nền tảng Agent (Supervision & Multi-Agent Rollout)

* [x] **5.1 (P)** Xây dựng vòng lặp giám sát `SemanticWatchdog` độc lập bên ngoài hệ thống chính.
  * *Boundary:* `BND-SUPERVISION-INTEGRATION` (`tools/cc-sdd/src/supervision/watchdog.ts`)
  * *Depends:* `1.2`, `2.2`
  * *Reqs:* `REQ-ACC-03`
  * *TDD Verification (`RED → GREEN`):* Giả lập một `Executor` bị kẹt trong vòng lặp sửa lỗi tạo ra 2 bản `git diff` hoặc thông báo lỗi kiểm thử giống hệt nhau liên tiếp; xác nhận `SemanticWatchdog` phát hiện sự thiếu tiến triển thực chất, tự động dừng tác vụ theo mức độ tác động (*stop by impact*), giải phóng khe trong `WorkerSlots` và gắn cờ cần con người can thiệp.

* [x] **5.2 (P)** Xây dựng giao diện quản trị Web Panel trên cổng `3082` tập trung vào ngân sách sự chú ý của con người.
  * *Boundary:* `BND-SUPERVISION-INTEGRATION` (`tools/cc-sdd/src/client/app.tsx`)
  * *Depends:* `1.1`, `4.1`, `5.1`
  * *Reqs:* `REQ-ACC-03`
  * *TDD Verification (`RED → GREEN`):* Kiểm thử giao diện kết xuất đầy đủ 6 thẻ (`Overview`, `Source`, `Trigger`, `Eval`, `Execution`, `Settings`), hiển thị ưu tiên trên cùng các `Ticket` đang ở trạng thái chờ người quyết định, hỗ trợ nút dừng tác vụ trực tiếp từ bảng điều khiển và công cụ đối chiếu câu lệnh prompt phiên bản hóa với prompt đầy đủ sau khi lắp ráp.

* [x] **5.3** Cập nhật danh mục 8 coding agents, các tệp manifest và mẫu kỹ năng `SKILL.md` theo đúng quy trình 5 bước của `sop-new-agent.md`.
  * *Boundary:* `BND-SUPERVISION-INTEGRATION` (`tools/cc-sdd/src/agents/registry.ts`, `tools/cc-sdd/templates/manifests/*.json`, `tools/cc-sdd/templates/agents/*/skills/kiro-impl/SKILL.md`, `tools/cc-sdd/test/realManifest*.test.ts`)
  * *Depends:* `2.1`, `2.2`, `2.3`, `3.3`, `4.2`, `5.1`
  * *Reqs:* `REQ-SPD-01`, `REQ-SPD-02`, `REQ-TOK-01`, `REQ-TOK-02`, `REQ-ACC-01`
  * *TDD Verification (`RED → GREEN`):* Áp dụng đầy đủ 5 bước trong `docs/cc-sdd/sop-new-agent.md` cho toàn bộ 8 nền tảng (Claude Code, Codex, Cursor, Copilot, Windsurf/Devin, OpenCode, Gemini CLI, Antigravity) và 14 ngôn ngữ; chạy toàn bộ lệnh xác thực chuẩn trong `tools/cc-sdd` gồm `npm test`, `npm run build && node dist/index.js --agent <id> --dry-run`, kiểm tra áp dụng thực tế với `--overwrite=force`, kiểm tra ngôn ngữ (`--lang ja`, `--lang en`) và đối chiếu số lượng tệp sinh ra.
