# Design: cc-sdd-superagent-refactor

* **Header Metadata (Machine-Oriented Dependencies):** Phụ thuộc vào `.kiro/specs/cc-sdd-superagent-refactor/requirements.md` (`SPEC-CC-SDD-V4`) và `.kiro/specs/cc-sdd-superagent-refactor/research.md`.

### 2.1. Ánh xạ Mô hình Miền (Domain Model Mapping)

Thiết kế hợp nhất biến đổi luồng thực thi phẳng của `cc-sdd` thành chuỗi thực thể miền có định danh độc lập của `dsh-superagent`:

* **`Source` & `Trigger`:** Sự kiện bất biến phát sinh từ lệnh `/kiro-*` trong IDE, sự kiện GitHub (Issue, PR comment, review approval, CI failure) hoặc Feishu.
* **`Thread`:** Nhóm các `Trigger` có liên quan theo trình tự thời gian (ví dụ: toàn bộ chuỗi thảo luận và log kiểm thử của một tính năng hoặc một PR).
* **`Eval` & `Policy`:** Tầng đánh giá không lưu trạng thái (stateless) kết hợp ma trận phân quyền người gửi (whitelist / `@Agent` mention) và quy tắc phiên bản hóa để phân loại thành `explicit`, `inferred` (chạy dưới chế độ `off | observe | auto`) hoặc `ignore`, hỗ trợ gom lô động từ 1,0 đến 2,8 sự kiện khi tải tăng.
* **`Ticket` & `Mandate`:** Mỗi tác vụ con `X.Y` trong `tasks.md` được khởi tạo thành một `Ticket` có vòng đời riêng, đi kèm một `Mandate` bất biến quy định rõ danh sách tệp được phép sửa (trích từ `_Boundary:_` và *File Structure Plan*) và các lệnh shell được phép thực thi.
* **`Assignment` & `Executor`:** Một lượt phân công `Ticket` cho một phiên làm việc `worker-<ticket-id>` chạy trên một thư mục `git worktree` riêng biệt. Một `Thread` có thể sinh ra nhiều `Ticket`, và một `Ticket` có thể trải qua nhiều `Assignment` nếu phải khởi động lại hoặc chuyển giao.
* **`Subscription` & `Outbox`:** `Subscription` nối trực tiếp các sự kiện thuộc `Thread` của `Ticket` vào hộp thư của `Executor`; `Outbox` đảm nhận việc đồng bộ trạng thái ngược ra `tasks.md` và gửi phản hồi/PR lên GitHub với cơ chế lưu biên nhận và kiểm tra thẻ HTML ẩn `<!-- cc-sdd-msg-id: ... -->`.

### 2.2. Cam kết Ranh giới Kiến trúc (Boundary Commitments)

Hệ thống được chia thành 5 mô-đun có ranh giới cô lập nghiêm ngặt (`Boundary Commitments`) để các tác nhân có thể phát triển và kiểm thử độc lập:

1. **`BND-STATE-ENGINE` (Tầng Lưu trữ Bền vững & Phục hồi):**
   * Quản lý tệp SQLite duy nhất tại `.kiro/state/harness.db` (sử dụng khóa thư mục trạng thái để đảm bảo chỉ một bản sao tiến trình ghi tại một thời điểm).
   * Cung cấp các bảng: `sources`, `triggers`, `threads`, `tickets`, `mandates`, `assignments`, `subscriptions`, `effects_queue`, `inbox_dedup`, `outbox_receipts` và `context_chunks`.
   * Thực thi nguyên tắc ghi nhận ý định trước (`Effects`): mọi lệnh gọi subagent, chạy shell nền hoặc đẩy PR đều phải ghi trạng thái `PENDING` vào `effects_queue` trước khi thực thi.
   * Khi khởi động lại sau sự cố, kích hoạt trình phục hồi 3 bước: đối chiếu bảng `tickets`/`effects_queue`, kiểm tra cây thư mục và `git log` trong `git worktree`, và truy vấn trạng thái PR từ xa qua GitHub CLI (`gh`) trước khi tiếp tục chu trình TDD.

2. **`BND-ROUTER-DISCOVERY` (Tầng Tiếp nhận, Đánh giá & Điều phối DAG):**
   * Đóng gói cấu hình `cc-sdd-router` không chứa công cụ sửa mã nguồn.
   * Thực thi ma trận lọc tiền-LLM: người gửi ngoài whitelist bị `ignore` ngay lập tức; người gửi trong whitelist có `@Agent` tạo yêu cầu `explicit`; các trường hợp còn lại hoặc sự kiện từ bot hợp lệ tạo ứng viên `inferred` chịu sự chi phối của cờ `proactiveMode` (`off`, `observe`, `auto`).
   * Đọc `tasks.md` và `spec.json`, xây dựng đồ thị phụ thuộc từ trường `_Depends:_` và đẩy các tác vụ độc lập có nhãn `(P)` vào hàng đợi cấp phát song song.
   * Khi phát hiện thay đổi trên `.kiro/steering/*.md`, `requirements.md` hoặc `design.md`, đánh dấu vô hiệu hóa các lượt `Eval` đang chờ và phát sự kiện `policy-changed` vào hộp thư của các `Executor` đang chạy thay vì hủy ngang tiến trình.

3. **`BND-EXEC-RUNTIME` (Bộ lập lịch `WorkerSlots`, `Git Worktree` & Shell Bất đồng bộ):**
   * Quản lý hồ bơi kết nối `WorkerSlots`: thực thi hàm `reserveSlot(ticketId, isHumanFollowUp)` đảm bảo chiếm giữ khe trước khi khởi tạo phiên `cc-sdd-worker`; cấp phép vượt trần `maxWorkers + 1` nếu `isHumanFollowUp === true`; tự động thu hồi khe và dừng subagent phụ thuộc khi `Ticket` chuyển sang trạng thái `WAITING_FOR_HUMAN`.
   * Quản lý vòng đời `git worktree`: tự động chạy `git worktree add -b sdd/<feature>/task-<id> .kiro/worktrees/<feature>/task-<id>` trước khi giao việc và dọn dẹp sau khi nhánh đã hợp nhất.
   * Trình bọc lệnh hệ thống (Async Shell Wrapper): giám sát các lệnh `TEST_COMMANDS`, `BUILD_COMMANDS`, `SMOKE_COMMANDS`; nếu thời gian chạy vượt quá 5.000ms, tự động tách tiến trình sang nền, trả về ngay lập tức đối tượng `{ status: "BACKGROUNDED", jobId }` để `Executor` không bị treo, và bơm sự kiện hoàn tất vào `Subscription` khi lệnh kết thúc (hoặc tự động hủy sau 30 phút).
   * Bộ kiểm soát Auto-Merge: kiểm tra PR gắn với `Ticket`; nếu tổng dòng thay đổi (`additions + deletions`) `< 200`, đã có sự kiện `APPROVED` từ con người và toàn bộ kiểm thử `GREEN`, thực hiện lệnh merge thông qua cấu hình tài khoản hợp nhất riêng biệt; tự động hủy cờ auto-merge trước khi đẩy bất kỳ commit bổ sung nào.

4. **`BND-CONTEXT-MANDATE` (Động cơ Ngữ cảnh `MasterAssessor` & Tường lửa `Mandate`):**
   * Bộ lập chỉ mục tài liệu đặc tả: phân tách `requirements.md`, `design.md`, `research.md`, `.kiro/steering/*.md` và mục `## Implementation Notes` thành các khối dữ liệu nhỏ gắn mã định danh ổn định (Stable ID) lưu trong bảng `context_chunks`.
   * Cung cấp công cụ `MasterAssessor.readChunk(stableId, cursor, maxChars)` cho phép `cc-sdd-worker`, `kiro-review` và `kiro-debug` thực hiện truy hồi chuỗi (`Chained Recall`) theo ngân sách cố định, giữ nguyên phần tiền tố prompt bất biến để tối ưu hóa bộ nhớ đệm (KV Prefix Cache).
   * Bộ chặn công cụ `MandateInterceptor`: đứng chắn trước mọi lệnh ghi tệp (`write_file`, `edit_file`, `apply_diff`) và lệnh shell của `cc-sdd-worker`; đối chiếu đường dẫn tệp mục tiêu với danh sách cho phép trong `Mandate` của `Ticket`. Nếu vi phạm, trả về lỗi `MANDATE_BOUNDARY_VIOLATION` ngay lập tức và hướng dẫn Worker gọi thủ tục `handoffToRouter(reason: "UPSTREAM_DEFECT_OR_SCOPE_EXPANSION")`.
   * Cổng lọc cơ học tiền-LLM (Pre-LLM Review Gate): tự động chạy `git diff --name-only` và kiểm tra mã thoát của `TEST_COMMANDS` trước khi cho phép gọi subagent `kiro-review`.

5. **`BND-SUPERVISION-INTEGRATION` (Giám sát `Watchdog`, Web Panel & Tích hợp Đa Agent):**
   * Vòng lặp `SemanticWatchdog`: chạy độc lập bên ngoài luồng Router/Worker, định kỳ quét bảng `tickets` và `effects_queue` để đo thời gian chờ lâu nhất, số lần thử lại, thời điểm sinh ra sản phẩm kiểm chứng gần nhất và độ tương đồng của chuỗi lỗi `git diff` / test log. Nếu phát hiện vòng lặp vô nghiệm giữa Implementer – Reviewer – Debugger, lập tức dừng tác vụ theo mức độ tác động (*stop by impact*) và đẩy lên Web Panel.
   * Giao diện Web Panel (chạy mặc định trên cổng `3082` dựa trên `src/client/app.tsx`): hiển thị danh sách ưu tiên các tác vụ cần con người quyết định, gồm 6 thẻ: `Overview`, `Source`, `Trigger`, `Eval`, `Execution` và `Settings` (cho phép so sánh prompt phiên bản hóa với prompt lắp ráp hoàn chỉnh và chuyển đổi chế độ `off | observe | auto`).
   * Bộ tích hợp `tools/cc-sdd`: cập nhật `registry.ts`, các tệp manifest JSON và bộ 17 kỹ năng (`SKILL.md`) cho toàn bộ 8 nền tảng coding agent theo đúng quy trình 5 bước trong `docs/cc-sdd/sop-new-agent.md`.

### 2.3. Kế hoạch Cấu trúc Tệp (File Structure Plan)

Bảng dưới đây quy định chính xác ánh xạ thư mục và tệp mã nguồn cho từng cam kết ranh giới, làm cơ sở để biên dịch thành `Mandate` cho từng tác vụ trong `tasks.md`:

| Cam kết Ranh giới | Đường dẫn Tệp / Thư mục Mục tiêu | Trách nhiệm Cụ thể của Tệp |
| --- | --- | --- |
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/db/schema.ts` | Định nghĩa lược đồ SQLite (`.kiro/state/harness.db`) cho `tickets`, `mandates`, `assignments`, `subscriptions`, `effects_queue`, `outbox`. |
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/assignments.ts` | Quản lý vòng đời phân công `Ticket` cho `Executor` và trạng thái sở hữu luồng. |
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/effects.ts` | Hàng đợi `Effects` bền vững, bộ lọc trùng lặp đầu vào `AgentDelivery` và bộ gửi `Outbox` gắn thẻ HTML đối soát. |
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/recovery.ts` | Giao thức phục hồi 3 bước (SQLite + Git Worktree + GitHub API) và bộ đồng bộ ngược trạng thái ra `tasks.md`. |
| `BND-ROUTER-DISCOVERY` | `tools/cc-sdd/src/router/admission.ts` | Ma trận phân quyền `Source`/`Trigger` (`explicit`, `inferred`, `ignore`) và cổng kiểm soát 3 chế độ `off \| observe \| auto`. |
| `BND-ROUTER-DISCOVERY` | `tools/cc-sdd/src/router/evalBatcher.ts` | Bộ gom lô sự kiện động theo `Thread` (tự động co giãn kích thước lô từ 1,0 lên 2,8 khi tải tăng). |
| `BND-ROUTER-DISCOVERY` | `tools/cc-sdd/src/router/dagDispatcher.ts` | Phân tích đồ thị `_Depends:_` và nhãn `(P)` trong `tasks.md`, phát thông báo `policy-changed` khi đặc tả thay đổi. |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/workerSlots.ts` | Bộ quản lý khe đồng thời `WorkerSlots` (giữ chỗ trước, khe ưu tiên `maxWorkers + 1` cho người, giải phóng khi `handoff`). |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/worktreeManager.ts` | Tự động khởi tạo, cô lập và dọn dẹp thư mục `git worktree` riêng cho từng `Ticket`. |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/asyncShell.ts` | Trình chạy lệnh tự động chuyển xuống nền sau 5 giây kèm `job_id`, giao diện hủy và giới hạn thời gian 30 phút. |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/autoMerge.ts` | Kiểm tra điều kiện PR `< 200` dòng, đã duyệt, thực thi auto-merge qua tài khoản riêng và rút auto-merge khi đẩy code mới. |
| `BND-CONTEXT-MANDATE` | `tools/cc-sdd/src/context/masterAssessor.ts` | Bộ lập chỉ mục tài liệu theo ID ổn định và giao diện đọc có ngân sách (`Inline–Spill–Chained Recall`) qua con trỏ phân trang. |
| `BND-CONTEXT-MANDATE` | `tools/cc-sdd/src/context/subscriptionBus.ts` | Đường truyền sự kiện trực tiếp (`Direct Event Pass-Through`) tới `Executor`, bỏ qua Router đối với các luồng đã đăng ký. |
| `BND-CONTEXT-MANDATE` | `tools/cc-sdd/src/security/mandateEnforcer.ts` | Biên dịch `_Boundary:_` thành `Mandate` bất biến, chặn ghi tệp trái phép ở tầng công cụ và cổng lọc cơ học trước `kiro-review`. |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/src/supervision/watchdog.ts` | Vòng lặp điều khiển `Watchdog` ngữ nghĩa độc lập theo dõi các chỉ số xác định và tiến triển thực chất của tác vụ. |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/src/client/app.tsx` | Giao diện Web Panel trên cổng `3082` (6 thẻ: `Overview`, `Source`, `Trigger`, `Eval`, `Execution`, `Settings`). |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/src/agents/registry.ts` | Cập nhật danh mục 8 coding agents với 2 preset `cc-sdd-router` và `cc-sdd-worker` cùng các tệp `manifests/{agent-id}.json`. |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/templates/agents/*/skills/kiro-impl/SKILL.md` | Nâng cấp kịch bản kỹ năng `kiro-impl`, `kiro-discovery`, `kiro-review`, `kiro-debug` và bộ kiểm thử `test/realManifest*.test.ts`. |

