Dưới đây là bộ tài liệu đặc tả kỹ thuật chi tiết (`requirements.md`, `design.md`, và `tasks.md`) được thiết kế chuẩn theo khuôn mẫu của **cc-sdd v3.0 (Kiro Spec-Driven Development)** để thực hiện tái cấu trúc (refactor) `cc-sdd` bằng các nguyên lý cốt lõi của **dsh-superagent-prototype**.

Bộ tài liệu này được đặt trong không gian làm việc giả định `.kiro/specs/cc-sdd-superagent-refactor/` và áp dụng trực tiếp cấu trúc khai báo phụ thuộc đầu trang (header dependency declaration) dành cho máy đọc của DeepSeek.

---

## 1. Tài liệu Yêu cầu: `.kiro/specs/cc-sdd-superagent-refactor/requirements.md`

* **Header Metadata (Machine-Oriented Dependencies):** Phụ thuộc vào `.kiro/steering/product.md`, `.kiro/steering/tech.md`, `.kiro/steering/structure.md` và `docs/cc-sdd/sop-new-agent.md`.


* **Spec ID:** `SPEC-CC-SDD-V4`
* **Trạng thái:** `APPROVED` (dùng để mở khóa cổng kiểm tra trong `spec.json` trước khi chạy `/kiro-impl`).



### 1.1. Mục tiêu & Triết lý Cốt lõi (Intent & Core Philosophy)

Kết hợp kỷ luật đặc tả **Boundary-First** của `cc-sdd` với nguyên tắc bảo toàn ngân sách sự chú ý của `dsh-superagent`: *"Chiếm ít sự chú ý của con người nhất có thể, và mang lại nhiều giá trị nhất có thể"*. Bản nâng cấp này nhằm giải quyết triệt để ba điểm nghẽn định lượng của `/kiro-impl` hiện tại:

1. **Về tốc độ:** Phá vỡ cơ chế thực thi tuần tự (*1 task per iteration*) và lỗi mô hình gọi subagent 0 lần dưới lời nhắc trung lập, hướng tới cắt giảm ~46,8% độ trễ đuôi P95 (từ 29,5 phút xuống ~15,7 phút, trung vị P50 ~12,4 phút).


2. **Về chi phí Token:** Triệt tiêu mức phạt **+223% token** của kỹ năng `kiro-impl` hiện hành bằng cách loại bỏ việc nạp lặp lại toàn bộ ngữ cảnh đặc tả và cắt giảm ~30% số quyết định tại Router cùng ~37% lượng token đọc bộ nhớ đệm (cache-read tokens) thông qua cơ chế chuyển tiếp sự kiện trực tiếp.


3. **Về độ chính xác & tính bền vững:** Nâng tỷ lệ vượt qua kiểm thử từ mốc 84% hiện tại lên mức tiệm cận tuyệt đối bằng cách cưỡng chế ranh giới qua thực thể `Mandate` bất biến ở tầng công cụ, lưu trữ trạng thái bằng `SQLite` kèm hàng đợi `Effects` và giám sát bằng vòng lặp `Watchdog` ngữ nghĩa độc lập.



### 1.2. Phạm vi Ranh giới Đặc tả (Spec Boundary Context)

Theo chuẩn của `cc-sdd`, đặc tả này xác lập rõ hợp đồng trách nhiệm như sau:

* **Những gì đặc tả này sở hữu (Owns):** Động cơ điều phối Router–Worker của `cc-sdd`, bộ lập lịch khe thực thi `WorkerSlots`, trình quản lý `git worktree`, bộ đọc ngữ cảnh có ngân sách `MasterAssessor`, cơ chế đăng ký luồng `Subscription`, lớp cưỡng chế công cụ `Mandate`, tầng lưu trữ bền vững `SQLite + Effects + Outbox`, vòng lặp giám sát `Watchdog` và mẫu kỹ năng `kiro-impl` / `kiro-discovery` trên 8 nền tảng coding agent.


* **Những gì đặc tả này KHÔNG sở hữu (Explicitly Does Not Own):** Cơ chế hộp cát bảo mật cấp độ hệ điều hành (OS-level sandbox như Firecracker/Kata), hệ thống giới hạn hạn mức/ngân sách toàn cục tại cổng mô hình (LLM Gateway rate-limiting), và quy tắc bảo vệ nhánh (branch protection) nội tại của máy chủ GitHub/GitLab.


* **Điều kiện tái xác thực hạ nguồn (Downstream Revalidation Triggers):** Bất kỳ thay đổi nào đối với lược đồ `spec.json`, cấu trúc chú thích `_Boundary:_` / `_Depends:_` trong `tasks.md`, hoặc giao thức kiểm duyệt `kiro-review` và gỡ lỗi `kiro-debug` đều buộc phải chạy lại bộ kiểm thử `realManifest{AgentName}.test.ts` trên toàn bộ 8 agent hỗ trợ.



### 1.3. Yêu cầu Chức năng & Phi chức năng (Functional & Non-Functional Requirements)

| Mã REQ | Nhóm Yêu cầu | Nội dung Yêu cầu Chi tiết & Tiêu chí Nghiệm thu (Acceptance Criteria) |
| --- | --- | --- |
| `REQ-SPD-01` | Phân tách Router–Worker | Tách cấu hình tác nhân thành 2 preset độc lập: `cc-sdd-router` (chỉ có công cụ đọc đặc tả, phân tích DAG, gom lô `Eval` và phân phối `Ticket`) và `cc-sdd-worker` (bộ công cụ TDD đầy đủ trong không gian cô lập) để ngăn chặn phiên chính tự viết code.

 |
| `REQ-SPD-02` | Thực thi Song song & Worktree | Mọi tác vụ con `X.Y` có nhãn `(P)` và đã thỏa mãn `_Depends:_` trong `tasks.md` phải được cấp phát một phiên `Executor` (`worker-`) riêng và một thư mục `git worktree` độc lập dưới `.kiro/worktrees/` để chạy TDD song song không xung đột tệp.

 |
| `REQ-SPD-03` | Quản lý Khe `WorkerSlots` | Cấp phát trước (pre-allocate) khe trống trong giới hạn `maxWorkers` trước khi đánh thức Worker; duy trì 1 khe ưu tiên vượt trần (`maxWorkers + 1`) dành riêng cho tin nhắn của con người; giải phóng khe ngay lập tức khi bàn giao (`handoff`) chờ con người quyết định.

 |
| `REQ-SPD-04` | Lệnh Nền 5s & Auto-Merge | Tự động chuyển các lệnh `TEST_COMMANDS`, `BUILD_COMMANDS`, `SMOKE_COMMANDS` chạy quá 5 giây xuống tiến trình nền (có `job_id`, API hủy, timeout 30 phút/lượt); hỗ trợ Auto-merge cho PR đã được duyệt có dưới 200 dòng thay đổi qua tài khoản tách biệt và tự rút auto-merge nếu đẩy commit mới.

 |
| `REQ-TOK-01` | Chuyển tiếp Trực tiếp `Subscription` | Khi `Ticket` đã gắn với một `Executor`, mọi sự kiện tiếp nối trên luồng đó (kết quả test, báo cáo `kiro-review`, kế hoạch `kiro-debug`, bình luận PR của con người) phải đi thẳng vào hộp thư của `Executor` mà không đi vòng qua `cc-sdd-router`.

 |
| `REQ-TOK-02` | Ngữ cảnh `MasterAssessor` | Thay thế việc nạp toàn bộ tệp đặc tả và `## Implementation Notes` bằng cơ chế `Inline–Spill–Chained Recall`: chỉ nạp nội tuyến phạm vi `_Boundary:_` của tác vụ, phần còn lại truy xuất qua giao diện đọc có ngân sách giới hạn số trang/ký tự bằng con trỏ (cursor) và ID ổn định.

 |
| `REQ-TOK-03` | Lọc Tiền-LLM & Prefix Cache | Áp dụng ma trận lọc quy tắc cố định (`explicit`, `inferred`, `ignore`) tại tầng `Eval` và cổng kiểm tra cơ học (kiểm tra mã thoát test và đường dẫn `git diff`) trước khi gọi LLM cho `kiro-review`; cố định thứ tự phần đầu prompt để tối ưu hóa KV Prefix Cache.

 |
| `REQ-ACC-01` | Cưỡng chế `Mandate` Bất biến | Biên dịch `_Boundary:_` và *File Structure Plan* của `design.md` thành đối tượng `Mandate` bất biến gắn với `Ticket`; chặn cứng ở tầng công cụ (tool-adapter) mọi lệnh ghi tệp ngoài phạm vi; tin nhắn mới trong `Subscription` chỉ bổ sung ngữ cảnh chứ không được mở rộng `Mandate`.

 |
| `REQ-ACC-02` | Bền vững `SQLite` + `Effects` | Lưu trữ toàn bộ vòng đời `Ticket`, `Assignment`, `Subscription` trong cơ sở dữ liệu `.kiro/state/harness.db` kèm hàng đợi `Effects` (ghi nhận ý định trước khi thực thi) và `Outbox` nhúng thẻ HTML chống gửi trùng; thực hiện giao thức phục hồi 3 bước khi khởi động lại.

 |
| `REQ-ACC-03` | `Watchdog` & Chế độ `Observe` | Triển khai thông báo `policy-changed` không hủy ngang khi sửa đặc tả; vận hành vòng lặp `Watchdog` ngữ nghĩa độc lập để ngắt sớm các vòng lặp TDD không có tiến triển thực chất; hỗ trợ 3 chế độ chủ động `off |

---

## 2. Tài liệu Thiết kế: `.kiro/specs/cc-sdd-superagent-refactor/design.md`

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
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/db/schema.ts` | Định nghĩa lược đồ SQLite (`.kiro/state/harness.db`) cho `tickets`, `mandates`, `assignments`, `subscriptions`, `effects_queue`, `outbox`.

 |
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/assignments.ts` | Quản lý vòng đời phân công `Ticket` cho `Executor` và trạng thái sở hữu luồng.

 |
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/effects.ts` | Hàng đợi `Effects` bền vững, bộ lọc trùng lặp đầu vào `AgentDelivery` và bộ gửi `Outbox` gắn thẻ HTML đối soát.

 |
| `BND-STATE-ENGINE` | `tools/cc-sdd/src/core/recovery.ts` | Giao thức phục hồi 3 bước (SQLite + Git Worktree + GitHub API) và bộ đồng bộ ngược trạng thái ra `tasks.md`.

 |
| `BND-ROUTER-DISCOVERY` | `tools/cc-sdd/src/router/admission.ts` | Ma trận phân quyền `Source`/`Trigger` (`explicit`, `inferred`, `ignore`) và cổng kiểm soát 3 chế độ `off | observe | auto`.

 |
| `BND-ROUTER-DISCOVERY` | `tools/cc-sdd/src/router/evalBatcher.ts` | Bộ gom lô sự kiện động theo `Thread` (tự động co giãn kích thước lô từ 1,0 lên 2,8 khi tải tăng).

 |
| `BND-ROUTER-DISCOVERY` | `tools/cc-sdd/src/router/dagDispatcher.ts` | Phân tích đồ thị `_Depends:_` và nhãn `(P)` trong `tasks.md`, phát thông báo `policy-changed` khi đặc tả thay đổi.

 |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/workerSlots.ts` | Bộ quản lý khe đồng thời `WorkerSlots` (giữ chỗ trước, khe ưu tiên `maxWorkers + 1` cho người, giải phóng khi `handoff`).

 |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/worktreeManager.ts` | Tự động khởi tạo, cô lập và dọn dẹp thư mục `git worktree` riêng cho từng `Ticket`.

 |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/asyncShell.ts` | Trình chạy lệnh tự động chuyển xuống nền sau 5 giây kèm `job_id`, giao diện hủy và giới hạn thời gian 30 phút.

 |
| `BND-EXEC-RUNTIME` | `tools/cc-sdd/src/execution/autoMerge.ts` | Kiểm tra điều kiện PR `< 200` dòng, đã duyệt, thực thi auto-merge qua tài khoản riêng và rút auto-merge khi đẩy code mới.

 |
| `BND-CONTEXT-MANDATE` | `tools/cc-sdd/src/context/masterAssessor.ts` | Bộ lập chỉ mục tài liệu theo ID ổn định và giao diện đọc có ngân sách (`Inline–Spill–Chained Recall`) qua con trỏ phân trang.

 |
| `BND-CONTEXT-MANDATE` | `tools/cc-sdd/src/context/subscriptionBus.ts` | Đường truyền sự kiện trực tiếp (`Direct Event Pass-Through`) tới `Executor`, bỏ qua Router đối với các luồng đã đăng ký.

 |
| `BND-CONTEXT-MANDATE` | `tools/cc-sdd/src/security/mandateEnforcer.ts` | Biên dịch `_Boundary:_` thành `Mandate` bất biến, chặn ghi tệp trái phép ở tầng công cụ và cổng lọc cơ học trước `kiro-review`.

 |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/src/supervision/watchdog.ts` | Vòng lặp điều khiển `Watchdog` ngữ nghĩa độc lập theo dõi các chỉ số xác định và tiến triển thực chất của tác vụ.

 |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/src/client/app.tsx` | Giao diện Web Panel trên cổng `3082` (6 thẻ: `Overview`, `Source`, `Trigger`, `Eval`, `Execution`, `Settings`).

 |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/src/agents/registry.ts` | Cập nhật danh mục 8 coding agents với 2 preset `cc-sdd-router` và `cc-sdd-worker` cùng các tệp `manifests/{agent-id}.json`.

 |
| `BND-SUPERVISION-INTEGRATION` | `tools/cc-sdd/templates/agents/*/skills/kiro-impl/SKILL.md` | Nâng cấp kịch bản kỹ năng `kiro-impl`, `kiro-discovery`, `kiro-review`, `kiro-debug` và bộ kiểm thử `test/realManifest*.test.ts`.

 |

---

## 3. Kế hoạch Thực thi Tác vụ: `.kiro/specs/cc-sdd-superagent-refactor/tasks.md`

* **Header Metadata (Machine-Oriented Dependencies):** Phụ thuộc vào `.kiro/specs/cc-sdd-superagent-refactor/requirements.md` và `.kiro/specs/cc-sdd-superagent-refactor/design.md`.


* **Quy ước Thực thi (`/kiro-impl` Protocol):**
* Các đầu mục lớn (`1.`, `2.`, ...) là nhóm phân loại; đơn vị thực thi thực tế là các tác vụ con đánh số `X.Y`.


* Nhãn `(P)` ngay sau mã số biểu thị tác vụ có thể được phân phối chạy song song trên các `git worktree` riêng biệt ngay khi các tác vụ trong `_Depends:_` đã được đánh dấu `[x]`.


* Mọi tác vụ bắt buộc tuân thủ chu trình TDD (`RED → GREEN`) sau cờ tính năng, vượt qua kiểm duyệt độc lập (`kiro-review` trả về `APPROVED`) và xác thực hoàn tất (`kiro-verify-completion`) trước khi đổi trạng thái từ `- [ ]` sang `- [x]`.





### 1. Khởi tạo Tầng Lưu trữ Bền vững SQLite, Hàng đợi Effects và Phục hồi (State & Recovery Engine)

* [ ] **1.1** Thiết kế lược đồ SQLite và cơ chế khóa đơn bản sao (Single-Replica State Lock) cho `.kiro/state/harness.db`.


* *Boundary:* `BND-STATE-ENGINE` (`tools/cc-sdd/src/core/db/schema.ts`, `tools/cc-sdd/src/core/assignments.ts`)


* *Depends:* `None`


* *Reqs:* `REQ-ACC-02`
* *TDD Verification (`RED → GREEN`):* Viết bài kiểm thử xác nhận việc khởi tạo đầy đủ các bảng `tickets`, `mandates`, `assignments`, `subscriptions`, `effects_queue`, `outbox_receipts`; kiểm thử tình huống 2 tiến trình cùng mở một thư mục trạng thái phải chặn tiến trình thứ hai để tránh ghi đè dữ liệu.




* [ ] **1.2 (P)** Xây dựng hàng đợi `Effects` ghi nhận ý định trước, bộ chống trùng lặp đầu vào `AgentDelivery` và bộ đối soát thẻ HTML cho `Outbox`.


* *Boundary:* `BND-STATE-ENGINE` (`tools/cc-sdd/src/core/effects.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-ACC-02`
* *TDD Verification (`RED → GREEN`):* Kiểm thử kịch bản nạp lại cùng một `message_id` vào `AgentDelivery` chỉ được thực thi đúng 1 lần; kiểm thử `Outbox` nhúng thẻ `<!-- cc-sdd-msg-id: ... -->` vào bình luận GitHub và tự động bỏ qua việc gửi lại nếu tìm thấy thẻ này trên luồng từ xa khi mạng bị trễ.




* [ ] **1.3 (P)** Hiện thực hóa giao thức phục hồi 3 bước sau sự cố (3-Step Crash Recovery) và trình chiếu trạng thái tự động ra `tasks.md`.


* *Boundary:* `BND-STATE-ENGINE` (`tools/cc-sdd/src/core/recovery.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-ACC-02`
* *TDD Verification (`RED → GREEN`):* Giả lập ngắt tiến trình đột ngột khi một `Ticket` đang ở pha `GREEN` nhưng chưa tạo PR; kiểm thử trình phục hồi tự động đối chiếu bản ghi SQLite, `git status`/`git log` trong worktree và trạng thái nhánh từ xa để tiếp tục bước tạo PR mà không chạy lại pha `RED` từ đầu.





### 2. Xây dựng Động cơ Ngữ cảnh Có Ngân sách và Tường lửa Mandate (Context & Security Plane)

* [ ] **2.1 (P)** Xây dựng bộ lập chỉ mục tài liệu đặc tả theo ID ổn định và giao diện đọc có ngân sách `MasterAssessor` (`Inline–Spill–Chained Recall`).


* *Boundary:* `BND-CONTEXT-MANDATE` (`tools/cc-sdd/src/context/masterAssessor.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-TOK-02`, `REQ-TOK-03`
* *TDD Verification (`RED → GREEN`):* Kiểm thử việc phân tách các tệp `requirements.md`, `design.md`, `steering/*.md` và `## Implementation Notes` thành các khối dữ liệu trong bảng `context_chunks`; xác nhận hàm đọc trả về đúng số ký tự giới hạn kèm con trỏ phân trang (cursor) và trích dẫn gốc, đồng thời giữ nguyên cấu trúc tiền tố prompt bất biến.




* [ ] **2.2 (P)** Triển khai đường truyền sự kiện trực tiếp `SubscriptionBus` (Direct Event Pass-Through) bỏ qua Router.


* *Boundary:* `BND-CONTEXT-MANDATE` (`tools/cc-sdd/src/context/subscriptionBus.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-TOK-01`
* *TDD Verification (`RED → GREEN`):* Viết bài kiểm thử xác nhận khi một `Ticket` đang thuộc quyền sở hữu của một `Executor`, mọi sự kiện phản hồi từ `kiro-review`, `kiro-debug`, log kiểm thử và tin nhắn của con người trên `Thread` đó đều đi thẳng vào phiên của `Executor` với 0 lần gọi đánh giá lại tại `cc-sdd-router`.




* [ ] **2.3 (P)** Xây dựng bộ cưỡng chế `MandateEnforcer` ở tầng công cụ và cổng lọc cơ học tiền-LLM (Pre-LLM Mechanical Gate).


* *Boundary:* `BND-CONTEXT-MANDATE` (`tools/cc-sdd/src/security/mandateEnforcer.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-ACC-01`, `REQ-TOK-03`
* *TDD Verification (`RED → GREEN`):* Kiểm thử việc biên dịch trường `_Boundary:_` thành đối tượng `Mandate` bất biến; xác nhận mọi lệnh sửa tệp ngoài danh sách cho phép bị chặn cứng ngay ở tool-adapter trước khi chạm tới ổ đĩa; xác nhận tin nhắn mới trong `Subscription` không thể mở rộng `Mandate`; và xác nhận `kiro-review` không được gọi nếu `TEST_COMMANDS` trả về mã lỗi khác `0`.





### 3. Xây dựng Bộ lập lịch Song song, Git Worktree và Thực thi Bất đồng bộ (Execution Runtime)

* [ ] **3.1 (P)** Hiện thực hóa bộ quản lý khe thực thi `WorkerSlots` với cơ chế giữ chỗ trước và khe ưu tiên `maxWorkers + 1` cho con người.


* *Boundary:* `BND-EXEC-RUNTIME` (`tools/cc-sdd/src/execution/workerSlots.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-SPD-03`
* *TDD Verification (`RED → GREEN`):* Mô phỏng 10 tác vụ bất đồng bộ cùng lúc yêu cầu khe khi `maxWorkers = 3` để xác nhận không xảy ra xung đột vượt trần; xác nhận tin nhắn tiếp nối từ con người được cấp phát ngay khe thứ 4 (`maxWorkers + 1`) và được xử lý trước hàng đợi tác vụ mới; xác nhận khe được giải phóng ngay khi `Executor` gọi `handoff` chờ người duyệt.




* [ ] **3.2 (P)** Xây dựng trình quản lý vòng đời `GitWorktreeManager` cô lập không gian làm việc cho từng `Ticket`.


* *Boundary:* `BND-EXEC-RUNTIME` (`tools/cc-sdd/src/execution/worktreeManager.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-SPD-02`
* *TDD Verification (`RED → GREEN`):* Kiểm thử khởi tạo đồng thời 3 `git worktree` cho 3 tác vụ gắn nhãn `(P)` từ cùng một kho mã nguồn; xác nhận cả 3 phiên `cc-sdd-worker` có thể sửa tệp, chạy kiểm thử và thực hiện `git commit` song song mà không gây lỗi khóa chỉ mục (`.git/index.lock`) hay ghi đè tệp của nhau.




* [ ] **3.3 (P)** Triển khai trình chạy lệnh `AsyncShellRunner` tự động chuyển xuống nền sau 5 giây và cơ chế `ConditionalAutoMerge` dưới 200 dòng.


* *Boundary:* `BND-EXEC-RUNTIME` (`tools/cc-sdd/src/execution/asyncShell.ts`, `tools/cc-sdd/src/execution/autoMerge.ts`)


* *Depends:* `1.2`, `2.2`


* *Reqs:* `REQ-SPD-04`
* *TDD Verification (`RED → GREEN`):* Kiểm thử một lệnh shell kéo dài 12 giây phải được tách xuống nền đúng ở mốc 5 giây, trả về `job_id` để phiên Worker tiếp tục nhận tin nhắn và tự động hủy nếu chạy quá 30 phút; kiểm thử bộ Auto-Merge chỉ kích hoạt khi PR `< 200` dòng thay đổi, đã có phê duyệt của con người, dùng tài khoản tách biệt và tự động hủy auto-merge ngay trước khi đẩy bản sửa đổi mới.





### 4. Xây dựng Tầng Điều phối Router, Lọc Sự kiện và Phân rã Đồ thị (Router & Discovery Layer)

* [ ] **4.1 (P)** Xây dựng cổng phân quyền `AdmissionGate` (`explicit | inferred | ignore`), chế độ chủ động `off | observe | auto` và bộ gom lô `EvalBatcher`.


* *Boundary:* `BND-ROUTER-DISCOVERY` (`tools/cc-sdd/src/router/admission.ts`, `tools/cc-sdd/src/router/evalBatcher.ts`)


* *Depends:* `1.1`


* *Reqs:* `REQ-SPD-01`, `REQ-TOK-03`, `REQ-ACC-03`
* *TDD Verification (`RED → GREEN`):* Kiểm thử ma trận người gửi ngoài danh sách cho phép bị loại bỏ (`ignore`) với 0 token LLM tiêu thụ; xác nhận chế độ mặc định `observe` chỉ ghi nhật ký ứng viên `inferred` vào SQLite mà không tạo `Ticket` thực thi; xác nhận kích thước lô đánh giá tự động tăng từ 1,0 lên ~2,8 khi tốc độ sự kiện tăng từ 1 lên 40 tin nhắn/phút.




* [ ] **4.2** Hiện thực hóa bộ điều phối đồ thị `DagDispatcher` cho các tác vụ `(P)` và cơ chế phát tín hiệu `policy-changed` không gián đoạn.


* *Boundary:* `BND-ROUTER-DISCOVERY` (`tools/cc-sdd/src/router/dagDispatcher.ts`)


* *Depends:* `2.3`, `3.1`, `3.2`, `4.1`


* *Reqs:* `REQ-SPD-01`, `REQ-SPD-02`, `REQ-ACC-03`
* *TDD Verification (`RED → GREEN`):* Kiểm thử việc phân tích `tasks.md` để đẩy toàn bộ các tác vụ `(P)` không phụ thuộc lẫn nhau vào `WorkerSlots` và `GitWorktreeManager` cùng lúc; kiểm thử khi sửa tệp `.kiro/steering/tech.md` hoặc `design.md` giữa chừng, hệ thống xếp hàng đánh giá lại các mục chờ trong `Eval` và gửi sự kiện `policy-changed` vào các `Ticket` đang chạy mà không hủy ngang làm hỏng code đang viết.





### 5. Triển khai Giám sát Watchdog, Web Panel và Tích hợp Đa Nền tảng Agent (Supervision & Multi-Agent Rollout)

* [ ] **5.1 (P)** Xây dựng vòng lặp giám sát `SemanticWatchdog` độc lập bên ngoài hệ thống chính.


* *Boundary:* `BND-SUPERVISION-INTEGRATION` (`tools/cc-sdd/src/supervision/watchdog.ts`)


* *Depends:* `1.2`, `2.2`


* *Reqs:* `REQ-ACC-03`
* *TDD Verification (`RED → GREEN`):* Giả lập một `Executor` bị kẹt trong vòng lặp sửa lỗi tạo ra 2 bản `git diff` hoặc thông báo lỗi kiểm thử giống hệt nhau liên tiếp; xác nhận `SemanticWatchdog` phát hiện sự thiếu tiến triển thực chất, tự động dừng tác vụ theo mức độ tác động (*stop by impact*), giải phóng khe trong `WorkerSlots` và gắn cờ cần con người can thiệp.




* [ ] **5.2 (P)** Xây dựng giao diện quản trị Web Panel trên cổng `3082` tập trung vào ngân sách sự chú ý của con người.


* *Boundary:* `BND-SUPERVISION-INTEGRATION` (`tools/cc-sdd/src/client/app.tsx`)


* *Depends:* `1.1`, `4.1`, `5.1`


* *Reqs:* `REQ-ACC-03`
* *TDD Verification (`RED → GREEN`):* Kiểm thử giao diện kết xuất đầy đủ 6 thẻ (`Overview`, `Source`, `Trigger`, `Eval`, `Execution`, `Settings`), hiển thị ưu tiên trên cùng các `Ticket` đang ở trạng thái chờ người quyết định, hỗ trợ nút dừng tác vụ trực tiếp từ bảng điều khiển và công cụ đối chiếu câu lệnh prompt phiên bản hóa với prompt đầy đủ sau khi lắp ráp.




* [ ] **5.3** Cập nhật danh mục 8 coding agents, các tệp manifest và mẫu kỹ năng `SKILL.md` theo đúng quy trình 5 bước của `sop-new-agent.md`.


* *Boundary:* `BND-SUPERVISION-INTEGRATION` (`tools/cc-sdd/src/agents/registry.ts`, `tools/cc-sdd/templates/manifests/*.json`, `tools/cc-sdd/templates/agents/*/skills/kiro-impl/SKILL.md`, `tools/cc-sdd/test/realManifest*.test.ts`)


* *Depends:* `2.1`, `2.2`, `2.3`, `3.3`, `4.2`, `5.1`


* *Reqs:* `REQ-SPD-01`, `REQ-SPD-02`, `REQ-TOK-01`, `REQ-TOK-02`, `REQ-ACC-01`
* *TDD Verification (`RED → GREEN`):* Áp dụng đầy đủ 5 bước trong `docs/cc-sdd/sop-new-agent.md` cho toàn bộ 8 nền tảng (Claude Code, Codex, Cursor, Copilot, Windsurf/Devin, OpenCode, Gemini CLI, Antigravity) và 14 ngôn ngữ; chạy toàn bộ lệnh xác thực chuẩn trong `tools/cc-sdd` gồm `npm test`, `npm run build && node dist/index.js --agent <id> --dry-run`, kiểm tra áp dụng thực tế với `--overwrite=force`, kiểm tra ngôn ngữ (`--lang ja`, `--lang en`) và đối chiếu số lượng tệp sinh ra.





---

### Lệnh Khởi chạy Thực thi sau khi Phê duyệt Đặc tả

Sau khi lưu 3 tệp trên vào thư mục `.kiro/specs/cc-sdd-superagent-refactor/` và cập nhật trạng thái phê duyệt trong `.kiro/specs/cc-sdd-superagent-refactor/spec.json`, bạn có thể kích hoạt ngay quá trình tái cấu trúc tự hành hoặc kiểm tra sự tương thích với mã nguồn hiện tại thông qua bộ lệnh kỹ năng chuẩn của `cc-sdd`:

1. Chạy `/kiro:validate-gap cc-sdd-superagent-refactor` và `/kiro:validate-design cc-sdd-superagent-refactor` để rà soát khoảng cách giữa thiết kế mới và mã nguồn hiện hành trong `tools/cc-sdd/`.


2. Chạy `/kiro-impl` (không truyền tham số mã số tác vụ) để kích hoạt chế độ thực thi tự hành toàn bộ danh sách tác vụ theo lộ trình phụ thuộc `_Depends:_`, hoặc chạy `/kiro-impl 1.1` để thực thi kiểm soát từng bước trong ngữ cảnh chính.


3. Sau khi hoàn tất toàn bộ các mục từ `1.1` đến `5.3`, chạy `/kiro-validate-impl` để thực hiện kiểm tra tích hợp xuyên tác vụ, tính toàn vẹn của các ranh giới `BND-*` và xác nhận kết quả `GO` trước khi phát hành phiên bản mới.