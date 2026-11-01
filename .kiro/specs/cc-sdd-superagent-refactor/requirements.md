# Requirements: cc-sdd-superagent-refactor

* **Header Metadata (Machine-Oriented Dependencies):** Phụ thuộc vào `.kiro/steering/product.md`, `.kiro/steering/tech.md`, `.kiro/steering/structure.md` và `docs/cc-sdd/sop-new-agent.md`.
* **Spec ID:** `SPEC-CC-SDD-V4`
* **Trạng thái:** `APPROVED`

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
| `REQ-SPD-01` | Phân tách Router–Worker | Tách cấu hình tác nhân thành 2 preset độc lập: `cc-sdd-router` (chỉ có công cụ đọc đặc tả, phân tích DAG, gom lô `Eval` và phân phối `Ticket`) và `cc-sdd-worker` (bộ công cụ TDD đầy đủ trong không gian cô lập) để ngăn chặn phiên chính tự viết code. |
| `REQ-SPD-02` | Thực thi Song song & Worktree | Mọi tác vụ con `X.Y` có nhãn `(P)` và đã thỏa mãn `_Depends:_` trong `tasks.md` phải được cấp phát một phiên `Executor` (`worker-`) riêng và một thư mục `git worktree` độc lập dưới `.kiro/worktrees/` để chạy TDD song song không xung đột tệp. |
| `REQ-SPD-03` | Quản lý Khe `WorkerSlots` | Cấp phát trước (pre-allocate) khe trống trong giới hạn `maxWorkers` trước khi đánh thức Worker; duy trì 1 khe ưu tiên vượt trần (`maxWorkers + 1`) dành riêng cho tin nhắn của con người; giải phóng khe ngay lập tức khi bàn giao (`handoff`) chờ con người quyết định. |
| `REQ-SPD-04` | Lệnh Nền 5s & Auto-Merge | Tự động chuyển các lệnh `TEST_COMMANDS`, `BUILD_COMMANDS`, `SMOKE_COMMANDS` chạy quá 5 giây xuống tiến trình nền (có `job_id`, API hủy, timeout 30 phút/lượt); hỗ trợ Auto-merge cho PR đã được duyệt có dưới 200 dòng thay đổi qua tài khoản tách biệt và tự rút auto-merge nếu đẩy commit mới. |
| `REQ-TOK-01` | Chuyển tiếp Trực tiếp `Subscription` | Khi `Ticket` đã gắn với một `Executor`, mọi sự kiện tiếp nối trên luồng đó (kết quả test, báo cáo `kiro-review`, kế hoạch `kiro-debug`, bình luận PR của con người) phải đi thẳng vào hộp thư của `Executor` mà không đi vòng qua `cc-sdd-router`. |
| `REQ-TOK-02` | Ngữ cảnh `MasterAssessor` | Thay thế việc nạp toàn bộ tệp đặc tả và `## Implementation Notes` bằng cơ chế `Inline–Spill–Chained Recall`: chỉ nạp nội tuyến phạm vi `_Boundary:_` của tác vụ, phần còn lại truy xuất qua giao diện đọc có ngân sách giới hạn số trang/ký tự bằng con trỏ (cursor) và ID ổn định. |
| `REQ-TOK-03` | Lọc Tiền-LLM & Prefix Cache | Áp dụng ma trận lọc quy tắc cố định (`explicit`, `inferred`, `ignore`) tại tầng `Eval` và cổng kiểm tra cơ học (kiểm tra mã thoát test và đường dẫn `git diff`) trước khi gọi LLM cho `kiro-review`; cố định thứ tự phần đầu prompt để tối ưu hóa KV Prefix Cache. |
| `REQ-ACC-01` | Cưỡng chế `Mandate` Bất biến | Biên dịch `_Boundary:_` và *File Structure Plan* của `design.md` thành đối tượng `Mandate` bất biến gắn với `Ticket`; chặn cứng ở tầng công cụ (tool-adapter) mọi lệnh ghi tệp ngoài phạm vi; tin nhắn mới trong `Subscription` chỉ bổ sung ngữ cảnh chứ không được mở rộng `Mandate`. |
| `REQ-ACC-02` | Bền vững `SQLite` + `Effects` | Lưu trữ toàn bộ vòng đời `Ticket`, `Assignment`, `Subscription` trong cơ sở dữ liệu `.kiro/state/harness.db` kèm hàng đợi `Effects` (ghi nhận ý định trước khi thực thi) và `Outbox` nhúng thẻ HTML chống gửi trùng; thực hiện giao thức phục hồi 3 bước khi khởi động lại. |
| `REQ-ACC-03` | `Watchdog` & Chế độ `Observe` | Triển khai thông báo `policy-changed` không hủy ngang khi sửa đặc tả; vận hành vòng lặp `Watchdog` ngữ nghĩa độc lập để ngắt sớm các vòng lặp TDD không có tiến triển thực chất; hỗ trợ 3 chế độ chủ động `off | observe | auto`. |
