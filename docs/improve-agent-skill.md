Bộ tài liệu đặc tả (`requirements.md`) và thiết kế kỹ thuật (`design.md`) dưới đây định nghĩa toàn bộ quy chuẩn tái cấu trúc thư mục `tools/cc-sdd/templates/agents/` và hệ thống tệp kê khai `tools/cc-sdd/templates/manifests/` từ kiến trúc kỹ năng nội tuyến đơn phiên (v3.0) sang kiến trúc điều phối hai tầng **Router–Worker (Super-Harness v4.0)** trên toàn bộ 8 nền tảng coding agent.

---

## 1. Tài liệu Đặc tả Yêu cầu: `.kiro/specs/templates-agents-v4/requirements.md`

* **Header Metadata (Machine-Oriented Dependencies):** Phụ thuộc vào `docs/cc-sdd/sop-new-agent.md`, `.kiro/steering/product.md`, `.kiro/steering/tech.md`, `.kiro/steering/structure.md` và `tools/cc-sdd/src/agents/registry.ts`.
* **Spec ID:** `SPEC-TEMPLATES-AGENTS-V4`
* **Trạng thái:** `APPROVED`.

### 1.1. Mục tiêu & Hợp đồng Ranh giới (Boundary Context)

* **Phạm vi Sở hữu (`Owns`):**
* Toàn bộ thư mục mẫu kỹ năng `tools/cc-sdd/templates/agents/{agent-id}/skills/*/SKILL.md` cho 17 kỹ năng trên 8 nền tảng coding agent (Claude Code, Codex, Cursor, Copilot, Windsurf, OpenCode, Gemini CLI, Antigravity).
* Cấu trúc siêu dữ liệu đầu trang (YAML frontmatter / header dependencies) phục vụ đọc ngữ cảnh từng phần và tối ưu bộ nhớ đệm tiền tố (KV Prefix Caching) trong các tệp `SKILL.md`.
* Các tệp kê khai cài đặt `tools/cc-sdd/templates/manifests/{agent-id}.json` và bộ kiểm thử đối chiếu `tools/cc-sdd/test/realManifest{AgentName}.test.ts`.


* **Phạm vi Không Sở hữu (`Explicitly Does Not Own`):**
* Mã nguồn thực thi tầng hạ tầng cơ sở dữ liệu `SQLite`, hàng đợi `Effects` hoặc bộ quản lý tiến trình hệ điều hành bên ngoài thư mục `templates/`.


* **Điều kiện Tái xác thực Hạ nguồn (`Downstream Revalidation Triggers`):**
* Mọi thay đổi về số lượng tệp kỹ năng, tên biến môi trường hoặc đường dẫn xuất ra trong `templates/agents/{agent-id}/` đều bắt buộc kích hoạt lại quy trình kiểm tra 5 bước trong `docs/cc-sdd/sop-new-agent.md` và bộ kiểm thử `realManifest{AgentName}.test.ts`.



### 1.2. Bảng Yêu cầu Kỹ thuật Chi tiết cho `tools/cc-sdd/templates/agents`

| Mã Yêu cầu | Thành phần Mục tiêu | Nội dung Yêu cầu & Tiêu chí Nghiệm thu (Acceptance Criteria) |
| --- | --- | --- |
| **`REQ-TPL-01`** | Phân tách Hồ sơ Kỹ năng (`Router` vs `Worker`) | Các mẫu trong `templates/agents/{agent-id}/` phải tách rõ 2 tập quyền hạn: hồ sơ `cc-sdd-router` (chỉ nạp kỹ năng điều phối, phân tích DAG, đánh giá `Eval` và lập lịch `WorkerSlots`, tuyệt đối khóa công cụ sửa mã nguồn) và hồ sơ `cc-sdd-worker` (nạp kỹ năng thực thi TDD, kiểm duyệt và gỡ lỗi trong `git worktree` cô lập). |
| **`REQ-TPL-02`** | Chuẩn hóa Header & KV Prefix Cache | Mọi tệp `SKILL.md` phải đặt phần quy tắc tĩnh và khai báo phụ thuộc dành cho máy đọc (machine-oriented header dependencies) ở phần đầu cố định theo thứ tự bất biến nhằm tối đa hóa tỷ lệ trúng bộ nhớ đệm tiền tố (KV Prefix Cache) trên mọi phiên Worker. |
| **`REQ-TPL-03`** | Cải tiến Mẫu `kiro-discovery/SKILL.md` | Tích hợp ma trận lọc quy tắc tiền-LLM (`explicit`, `inferred`, `ignore` dựa trên danh sách whitelist và thẻ `@Agent`), cổng kiểm soát 3 chế độ chủ động (`off`, `observe` mặc định, `auto`) và quy tắc gom lô sự kiện động theo `Thread` (từ 1,0 lên 2,8 sự kiện/lần) trước khi rẽ nhánh vào 5 lộ trình khám phá. |
| **`REQ-TPL-04`** | Cải tiến Mẫu `kiro-impl/SKILL.md` | Xóa bỏ chỉ thị xử lý tuần tự *"1 task per iteration"*; thay bằng giao thức cấp phát khe `WorkerSlots` (`maxWorkers` + 1 khe ưu tiên cho con người), khởi tạo `git worktree` riêng cho từng tác vụ gắn nhãn `(P)` thỏa mãn `_Depends:_`, chuyển lệnh `TEST_COMMANDS`/`BUILD_COMMANDS`/`SMOKE_COMMANDS` chạy quá 5 giây xuống nền (timeout 30 phút) và ghi nhận ý định vào `SQLite` + hàng đợi `Effects` trước khi cập nhật khung nhìn `tasks.md`. |
| **`REQ-TPL-05`** | Giao thức Truy xuất Ngữ cảnh `MasterAssessor` | Loại bỏ hoàn toàn chỉ thị nạp toàn bộ tệp đặc tả hoặc tiêm nguyên khối mục `## Implementation Notes` vào prompt trong `kiro-impl`, `kiro-review` và `kiro-debug`; thay bằng giao thức `Inline–Spill–Chained Recall` chỉ nạp nội tuyến `_Boundary:_` và truy xuất phân trang có ngân sách qua con trỏ (cursor) cùng mã định danh ổn định (Stable ID). |
| **`REQ-TPL-06`** | Đường truyền `Subscription` & Cổng Tiền-LLM | Cập nhật mẫu `kiro-review` và `kiro-debug` để nhận và trả sự kiện trực tiếp về phiên `Executor` (`worker-`) thông qua `Subscription` mà không đi vòng qua `Router`; bổ sung cổng lọc cơ học tiền-LLM bắt buộc kiểm tra mã thoát kiểm thử (`0`) và phạm vi tệp `git diff` trước khi gọi mô hình chạy `kiro-review`. |
| **`REQ-TPL-07`** | Cưỡng chế `Mandate` & Phản ứng `Watchdog` / `Policy` | Nhúng quy tắc thực thi `Mandate` bất biến vào mọi mẫu kỹ năng thực thi: cấm mở rộng phạm vi sửa tệp từ bình luận mới hay ghi chú; bắt buộc gọi `handoff` về `Router` nếu gặp lỗi đặc tả thượng nguồn (Upstream Defects); thay thế giới hạn cứng 2 vòng sửa lỗi + 2 vòng debug bằng phản ứng theo tín hiệu `Watchdog` ngữ nghĩa và sự kiện `policy-changed` không gián đoạn. |
| **`REQ-TPL-08`** | Quy tắc Auto-Merge & Đồng bộ Đa Agent | Bổ sung quy tắc đóng tác vụ trong `kiro-verify-completion` và `/kiro-validate-impl`: nhúng thẻ HTML ẩn chống gửi trùng (`Outbox`), chỉ bật Auto-merge cho PR dưới 200 dòng đã được duyệt qua tài khoản tách biệt (tự rút auto-merge trước khi đẩy commit mới), và đồng bộ toàn bộ thay đổi trên 8 agent cùng các gói ngôn ngữ theo `sop-new-agent.md`. |

---

## 2. Tài liệu Thiết kế Kỹ thuật: `.kiro/specs/templates-agents-v4/design.md`

* **Header Metadata (Machine-Oriented Dependencies):** Phụ thuộc vào `.kiro/specs/templates-agents-v4/requirements.md` (`SPEC-TEMPLATES-AGENTS-V4`) và `docs/cc-sdd/sop-new-agent.md`.

### 2.1. Kiến trúc Phân tách Hồ sơ trong `templates/agents/{agent-id}`

Để khắc phục hiện tượng mô hình phiên đơn gọi subagent 0 lần trong 5 lượt chạy thử nghiệm dưới câu lệnh trung lập, cấu trúc thư mục `tools/cc-sdd/templates/agents/{agent-id}/` được thiết kế lại để phân phối bộ 17 kỹ năng thành hai lớp thực thi tách biệt trong tệp kê khai `templates/manifests/{agent-id}.json`:

1. **Tập Kỹ năng Điều phối (`Router Profile` — `cc-sdd-router`):**
* **Kỹ năng được nạp:** `/kiro-discovery`, `/kiro-spec-init`, `/kiro-spec-requirements`, `/kiro-spec-design`, `/kiro-spec-tasks`, `/kiro-spec-batch`, `/kiro-validate-gap`, `/kiro-validate-design`, `/kiro-steering` và phần điều phối DAG của `/kiro-impl`.
* **Giới hạn Công cụ (Tool-Adapter Boundary):** Chỉ được cấp quyền đọc tệp đặc tả, truy vấn trạng thái `SQLite` (`.kiro/state/harness.db`), phân bổ khe `WorkerSlots` và khởi tạo `Ticket` kèm `Mandate`. Tệp mẫu của Router tuyệt đối không khai báo quyền gọi công cụ sửa tệp mã nguồn (`Edit`/`Write`) hoặc chạy lệnh biên dịch/kiểm thử đồng bộ.


2. **Tập Kỹ năng Thực thi Cô lập (`Worker Profile` — `cc-sdd-worker`):**
* **Kỹ năng được nạp:** Phần thực thi TDD của `/kiro-impl` (Executor mode), `kiro-review`, `kiro-debug`, `kiro-verify-completion` và `/kiro-validate-impl`.
* **Giới hạn Công cụ & Không gian làm việc:** Chạy độc lập trong thư mục `.kiro/worktrees/<feature>/task-<X-Y>` được tạo bởi `git worktree`, chịu sự kiểm soát trực tiếp của bộ chặn `Mandate` ở tầng công cụ và kết nối thẳng vào đường truyền sự kiện `Subscription`.



---

### 2.2. Chuẩn hóa Cấu trúc Tệp `SKILL.md` (KV Prefix Cache & `MasterAssessor`)

Mọi tệp `SKILL.md` trong `tools/cc-sdd/templates/agents/{agent-id}/skills/*/` phải tuân thủ cấu trúc 3 tầng cố định nhằm triệt tiêu mức tăng +223% token và tiết kiệm 37% lượng token đọc bộ nhớ đệm (cache-read tokens):

```markdown
---
name: kiro-<skill-name>
version: 4.0.0
role_profile: router | worker | hybrid
header_dependencies:
  - .kiro/steering/product.md#core-invariants
  - .kiro/steering/tech.md#build-and-test-commands
  - .kiro/steering/structure.md#module-boundaries
context_mode: inline-spill-chained-recall
max_inline_budget_chars: 4000
mandate_enforcement: strict-tool-adapter
---
<!-- TẦNG 1: STATIC SYSTEM INVARIANTS (Cố định 100% để khớp KV Prefix Cache) -->
<!-- TẦNG 2: ROLE & PROTOCOL CONTRACT (Quy tắc điều phối Router hoặc thực thi Worker) -->
<!-- TẦNG 3: DYNAMIC TASK PAYLOAD SLOT (Chỉ nạp Inline _Boundary:_ và con trỏ Stable ID) -->

```

* **Tầng 1 (Static Prefix Block):** Chứa các quy tắc bất biến của `cc-sdd` (như kỷ luật *Boundary-First*, nguyên tắc không suy diễn trạng thái hoàn thành từ văn bản thuần túy, và quy tắc bảo toàn quyền hạn `Mandate`) được đặt ở vị trí đầu tiên, không thay đổi giữa các lượt gọi để bộ nhớ đệm KV của mô hình tái sử dụng 100%.
* **Tầng 2 (Protocol Contract):** Chứa lưu đồ hành động của kỹ năng và giao diện gọi `MasterAssessor`. Thay vì đọc toàn bộ tệp `design.md` hay `tasks.md`, mẫu kỹ năng bắt buộc tác nhân sử dụng truy hồi chuỗi (`Chained Recall`) qua con trỏ phân trang: `Task ID → Boundary ID → Design File Structure Plan → Implementation Note ID`.
* **Tầng 3 (Dynamic Payload):** Chỉ nạp phần mô tả nội tuyến (Inline) của đúng tác vụ `X.Y` đang xử lý; toàn bộ lịch sử `## Implementation Notes` và tài liệu nghiên cứu dài được đẩy ra ngoài (Spill) vào bảng chỉ mục SQLite.

---

### 2.3. Thiết kế Chi tiết Chuyển đổi các Kỹ năng Trọng tâm trong `templates/agents/`

#### A. Thiết kế lại Mẫu `skills/kiro-discovery/SKILL.md`

Thay vì kích hoạt phân tích LLM ngay cho mọi đầu vào, mẫu `kiro-discovery` mới bổ sung quy trình **Admission & Batching Gate** ở đầu luồng:

1. **Ma trận Phân quyền Tiền-LLM (`Source → Trigger → Thread`):** Kiểm tra danh tính người gửi đối chiếu với whitelist và sự xuất hiện của thẻ `@Agent` để phân loại thành `explicit` (xử lý ngay), `inferred` (chuyển qua cổng chế độ chủ động) hoặc `ignore` (dừng ngay lập tức với 0 token tiêu thụ).
2. **Cổng Chế độ Chủ động (`off | observe | auto`):** Nếu sự kiện thuộc nhóm `inferred` (như cảnh báo độ lệch đặc tả hoặc lỗi CI tự động), kiểm tra cấu hình chế độ: ở chế độ mặc định `observe`, kỹ năng chỉ ghi kết quả phân loại vào nhật ký đánh giá (`Eval` log) để con người kiểm tra độ nhiễu mà không tự ý tạo đặc tả hay sửa mã nguồn.
3. **Gom lô Động theo Chuỗi (`Thread Batching`):** Gom các sự kiện liên quan trong cùng một `Thread` (tự động điều chỉnh kích thước lô từ 1,0 đến 2,8 sự kiện khi mật độ tin nhắn tăng từ 1 lên 40 tin nhắn/phút) trước khi phân loại vào 5 nhánh khám phá chuẩn của `cc-sdd`.

#### B. Thiết kế lại Mẫu `skills/kiro-impl/SKILL.md`

Mẫu `kiro-impl/SKILL.md` là trọng tâm của đợt nâng cấp, được chia làm hai phần chỉ thị rõ rệt theo vai trò:

* **Chế độ Điều phối (`Router Mode` — Khi gọi `/kiro-impl` không truyền mã tác vụ cụ thể):**
1. Kiểm tra trạng thái phê duyệt trong `spec.json` và đối chiếu trạng thái phục hồi 3 bước từ `.kiro/state/harness.db` (`SQLite` + `Effects` queue + `git worktree` + trạng thái PR từ xa) nếu phiên trước bị gián đoạn.
2. Phân tích đồ thị `_Depends:_` trong `tasks.md`; gom toàn bộ các tác vụ con `X.Y` có nhãn `(P)` đã thỏa mãn điều kiện tiên quyết thành một đợt thực thi song song.
3. Với mỗi tác vụ `X.Y`, thực hiện giữ chỗ trước (pre-allocate) một khe trong `WorkerSlots` (luôn chừa 1 khe ưu tiên `maxWorkers + 1` cho tin nhắn tiếp nối của con người), biên dịch trường `_Boundary:_` và *File Structure Plan* thành đối tượng `Mandate` bất biến, khởi tạo thư mục `.kiro/worktrees/<feature>/task-<X-Y>` và giao `Ticket` cho phiên `cc-sdd-worker` độc lập kèm đăng ký `Subscription`.


* **Chế độ Thực thi (`Worker Executor Mode` — Khi chạy trong phiên `worker-task-X-Y`):**
1. Nạp nội tuyến phạm vi `Mandate` và sử dụng `MasterAssessor` để truy hồi đúng đoạn thiết kế cần thiết.
2. Thực thi chu trình TDD sau cờ tính năng (`RED → GREEN`); khi chạy `TEST_COMMANDS`, `BUILD_COMMANDS` hoặc `SMOKE_COMMANDS`, nếu lệnh kéo dài quá 5 giây thì tự động chuyển xuống tiến trình nền (nhận `job_id`, thời gian chờ tối đa 30 phút/lượt) để giữ luồng phản hồi thông suốt.
3. Nếu phát hiện lỗi bắt nguồn từ mô-đun ngoài danh sách tệp của `Mandate` (Upstream Defect) hoặc cần con người làm rõ, lập tức gọi thủ tục `handoff` trả về `Router` và giải phóng ngay khe trong `WorkerSlots` (đồng thời dừng mọi subagent phụ thuộc).
4. Nếu nhận được sự kiện `policy-changed` (do đặc tả hoặc tệp `.kiro/steering/*.md` vừa được cập nhật), hoàn tất bước nguyên tử hiện tại một cách an toàn rồi nạp lại quy tắc mới để tái xác thực thay vì hủy ngang làm hỏng mã nguồn.



#### C. Thiết kế lại Mẫu `skills/kiro-review/SKILL.md`, `skills/kiro-debug/SKILL.md` và `skills/kiro-verify-completion/SKILL.md`

* **Cổng Lọc Cơ học Tiền-LLM trước `kiro-review`:** Trước khi khởi tạo phiên LLM của `kiro-review`, kịch bản bắt buộc chạy kiểm tra cơ học: (1) mã thoát của `TEST_COMMANDS` phải bằng `0`, và (2) toàn bộ đường dẫn tệp trong `git diff --name-only` phải nằm trong tập hợp cho phép của `Mandate`. Nếu vi phạm, trả lỗi cơ học trực tiếp về `Executor` mà không tiêu tốn token gọi `kiro-review`.
* **Chuyển tiếp Trực tiếp qua `Subscription`:** Mọi báo cáo kiểm duyệt của `kiro-review` (dựa trên bằng chứng `git diff` thực tế) và kế hoạch sửa lỗi của `kiro-debug` được định tuyến thẳng vào hộp thư của `Executor` đang nắm giữ `Ticket`, cắt bỏ hoàn toàn bước trung chuyển qua ngữ cảnh của `Router`.
* **Tích hợp `Watchdog` Ngữ nghĩa thay cho Đếm vòng Cứng nhắc:** Thay vì chỉ dừng lại sau đúng 2 vòng sửa lỗi và 2 vòng gỡ lỗi, mẫu `kiro-debug` ghi nhận dấu vân tay của `git diff` và log lỗi sau mỗi lượt vào bảng `Effects`; nếu vòng lặp `Watchdog` bên ngoài phát hiện hai lượt liên tiếp không tạo ra tiến triển thực chất, tác vụ lập tức bị ngắt theo mức độ tác động (*stop by impact*) và đẩy lên Web Panel (cổng `3082`).
* **Đối soát `Outbox` và Auto-Merge Có Điều kiện trong `kiro-verify-completion`:** Trước khi ghi nhận hoàn tất tác vụ (đồng bộ từ SQLite ra hộp kiểm `- [x]` trên `tasks.md`) và đăng bình luận/PR lên GitHub, kỹ năng phải nhúng mã định danh thông điệp vào thẻ ghi chú HTML ẩn và quét kiểm tra trên luồng từ xa để chống gửi lặp khi mạng trễ. Nếu PR có dưới 200 dòng thay đổi và đã được phê duyệt, hệ thống cho phép kích hoạt auto-merge qua tài khoản tách biệt (và tự động hủy auto-merge ngay trước khi đẩy bất kỳ commit bổ sung nào).

---

### 2.4. Kế hoạch Cấu trúc Tệp (File Structure Plan) cho `tools/cc-sdd`

Tuân thủ quy trình chuẩn 5 bước trong `docs/cc-sdd/sop-new-agent.md`, các tệp sau đây nằm trong phạm vi sửa đổi trực tiếp (`_Boundary:_`) của bản thiết kế này:

| Nhóm Thành phần | Đường dẫn Tệp Mục tiêu trong `tools/cc-sdd/` | Nội dung Sửa đổi Cụ thể |
| --- | --- | --- |
| **1. Danh mục Agent** | `tools/cc-sdd/src/agents/registry.ts` | Bổ sung cấu hình hỗ trợ 2 chế độ hồ sơ (`router` / `worker`), khai báo đường dẫn thư mục trạng thái `.kiro/state/` và thư mục `.kiro/worktrees/` cho toàn bộ 8 nền tảng coding agent. |
| **2. Tệp Kê khai (Manifests)** | `tools/cc-sdd/templates/manifests/{agent-id}.json` (8 tệp: `claude-code.json`, `codex.json`, `cursor.json`, `copilot.json`, `windsurf.json`, `opencode.json`, `gemini-cli.json`, `antigravity.json`) | Cập nhật ánh xạ tệp kỹ năng mới, tách quyền công cụ cho preset `cc-sdd-router` và `cc-sdd-worker`, đồng thời khai báo các mẫu cấu hình cổng kiểm soát `proactiveMode: "observe"` mặc định. |
| **3. Mẫu Kỹ năng Khám phá & Đặc tả** | `tools/cc-sdd/templates/agents/{agent-id}/skills/kiro-discovery/SKILL.md` & `kiro-spec-*/SKILL.md` | Bổ sung phần đầu phụ thuộc máy đọc (header dependencies), cổng lọc `AdmissionGate` (`explicit | inferred | ignore`), chế độ `off | observe | auto`, gom lô động $ng $1,0 \rightarrow$ và gắn Stable ID cho mọi mục đặc tả sinh ra. |
| **4. Mẫu Kỹ năng Thực thi Song song** | `tools/cc-sdd/templates/agents/{agent-id}/skills/kiro-impl/SKILL.md` | Viết lại lưu đồ thực thi sang kiến trúc Router–Worker: cấp phát `WorkerSlots` (`maxWorkers + 1`), tạo `git worktree` cho các tác vụ `(P)`, ép buộc `Mandate` bất biến, đẩy lệnh shell $>5\text{s}$ xuống nền, lưu trạng thái vào `SQLite` + `Effects` và phục hồi 3 bước. |
| **5. Mẫu Kỹ năng Kiểm duyệt, Gỡ lỗi & Xác thực** | `tools/cc-sdd/templates/agents/{agent-id}/skills/{kiro-review,kiro-debug,kiro-verify-completion,kiro-validate-impl}/SKILL.md` | Áp dụng đường truyền trực tiếp `Subscription`, đọc ngữ cảnh có ngân sách `MasterAssessor` (`Inline–Spill–Chained Recall`), cổng lọc cơ học tiền-LLM, phản ứng với `Watchdog` / `policy-changed`, đối soát thẻ HTML `Outbox` và quy tắc Auto-merge $< 200$ dòng. |
| **6. Kiểm thử Kê khai Thực tế** | `tools/cc-sdd/test/realManifest{AgentName}.test.ts` | Cập nhật các bài kiểm thử xác nhận số lượng tệp sinh ra, cấu trúc header YAML/Markdown bất biến cho KV Prefix Cache và kiểm tra chạy thử (`--dry-run`, `--overwrite=force`, `--lang`) trên toàn bộ 8 agent. |

---

## 3. Bản mẫu Nội dung `SKILL.md` Chuẩn hóa (Áp dụng cho `templates/agents/{agent-id}/skills/`)

Dưới đây là nội dung bản mẫu chuẩn hóa cho hai kỹ năng cốt lõi nhất (`kiro-impl/SKILL.md` và `kiro-discovery/SKILL.md`) để cập nhật vào thư mục `tools/cc-sdd/templates/agents/{agent-id}/skills/`:

### 3.1. Nội dung Mẫu: `tools/cc-sdd/templates/agents/{agent-id}/skills/kiro-impl/SKILL.md`

```markdown
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
---

# Kiro Implementation Skill (v4.0 Super-Harness Router–Worker Protocol)

## 1. Static Core Invariants (KV Prefix Cache Locked)
1. **Attention Conservation:** Consume as little human attention as possible while delivering verified software. Only interrupt humans on scope violations, ambiguous spec requirements, or changes exceeding 200 lines.
2. **Immutable Mandate Enforcement:** The `_Boundary:_` annotation in `tasks.md` and the *File Structure Plan* in `design.md` compile into an immutable `Mandate`. Incoming comments, test logs, or `## Implementation Notes` provide context only and NEVER expand your file-write authority.
3. **Evidence Over Prose:** Never infer task completion from implementer prose. Completion requires mechanical exit code `0` from `TEST_COMMANDS`/`BUILD_COMMANDS`/`SMOKE_COMMANDS` and an explicit `APPROVED` verdict from `kiro-review` on actual `git diff`.

## 2. Mode A: Router Orchestration (`cc-sdd-router` — No File Edit Tools)
When invoked as `/kiro-impl` (autonomous wave execution) or after a crash restart:
1. **3-Step Crash Recovery Check:** Before dispatching, reconcile (a) `.kiro/state/harness.db` (`tickets` and `effects_queue` tables), (b) uncommitted files and `git log` inside existing `.kiro/worktrees/`, and (c) remote PR/branch state on GitHub. Resume interrupted tickets from their last recorded effect without repeating completed TDD phases.
2. **DAG Wave Resolution:** Parse `tasks.md` for unchecked sub-tasks (`- [ ] X.Y`). Group all tasks marked with `(P)` whose `_Depends:_` prerequisites are `[x]` into a parallel execution wave.
3. **Pre-Allocated WorkerSlots Dispatch:**
   - Reserve a slot in `WorkerSlots` (`maxWorkers` limit) BEFORE waking or spawning a `cc-sdd-worker` session.
   - Maintain 1 dedicated overflow slot (`maxWorkers + 1`) strictly reserved for human follow-up messages.
   - Provision an isolated workspace via `git worktree add .kiro/worktrees/{feature}/task-{X-Y}`.
   - Bind a `Subscription` so all subsequent review, debug, and test events route directly to `worker-task-{X-Y}` without re-entering the Router.
4. **Non-Disruptive Policy Updates:** If `.kiro/steering/*.md`, `requirements.md`, or `design.md` changes during execution, invalidate pending `Eval` items and emit a `policy-changed` event to active Workers; do NOT abruptly kill active Worker processes.

## 3. Mode B: Worker Execution (`cc-sdd-worker` — Isolated Git Worktree)
When executing an assigned `Ticket` (`task-X.Y`) inside your dedicated `git worktree`:
1. **Budgeted Context Recall (`MasterAssessor`):** Do NOT load full spec files or full `## Implementation Notes`. Read only the inline `_Boundary:_` payload and invoke `MasterAssessor` pagination cursors by Stable ID (`Task ID -> Boundary ID -> Design Section -> Note ID`) when deeper context is needed.
2. **Feature-Flag TDD & 5-Second Async Shell:**
   - Write failing tests (`RED`), then implement code behind feature flags (`GREEN`) strictly within files permitted by your `Mandate`.
   - Any execution of `TEST_COMMANDS`, `BUILD_COMMANDS`, or `SMOKE_COMMANDS` exceeding 5 seconds automatically moves to a background job (`job_id`, 30-minute timeout per turn) so your session remains responsive to `Subscription` events.
3. **Pre-LLM Mechanical Gate & Direct Review Loop:**
   - Before invoking `kiro-review`, run the mechanical gate: verify test exit code is `0` and `git diff --name-only` contains zero out-of-mandate paths.
   - Receive `kiro-review` and `kiro-debug` feedback directly via `Subscription`. Record each remediation attempt in the SQLite `Effects` queue for external semantic `Watchdog` monitoring.
4. **Upstream Defect Handoff & Slot Release:**
   - If passing TDD requires modifying a shared contract outside your `Mandate`, STOP immediately, call `handoff(reason: "UPSTREAM_DEFECT")` to `cc-sdd-router`, halt child subagents, and release your `WorkerSlots` slot immediately.
5. **Idempotent Outbox & Conditional Auto-Merge:**
   - Record intent in the SQLite `Effects` queue before committing or posting to GitHub. Embed hidden HTML message ID markers in `Outbox` comments and scan remote threads first to prevent duplicate reports after network retries.
   - Project `[x]` back to `tasks.md` only after `kiro-verify-completion` succeeds. Enable conditional auto-merge ONLY if total changed lines `< 200`, human approval is present, and a separate merge account is configured; automatically retract auto-merge before pushing any new commits.

```

---

### 3.2. Nội dung Mẫu: `tools/cc-sdd/templates/agents/{agent-id}/skills/kiro-discovery/SKILL.md`

```markdown
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

```

---

### 4. Quy trình Kiểm chứng & Áp dụng Mẫu Mới (`sop-new-agent.md` Verification)

Sau khi cập nhật các tệp trong `tools/cc-sdd/templates/agents/{agent-id}/skills/` và `tools/cc-sdd/templates/manifests/{agent-id}.json`, thực thi chuỗi lệnh xác thực chuẩn của `cc-sdd` để đảm bảo tính toàn vẹn trên toàn bộ 8 nền tảng coding agent:

1. **Chạy bộ kiểm thử đơn vị và kiểm thử manifest thực tế:**
```bash
cd tools/cc-sdd && npm test

```


Lệnh này sẽ thực thi toàn bộ các tệp `test/realManifest{AgentName}.test.ts` để đối chiếu cấu trúc thư mục, quyền hạn preset `router`/`worker` và siêu dữ liệu đầu trang trên cả 8 agent.
2. **Biên dịch và chạy thử nghiệm (`--dry-run` & `--overwrite=force`) kèm kiểm tra đa ngôn ngữ:**
```bash
npm run build && node dist/index.js --agent claude-code --dry-run
node dist/index.js --agent cursor --lang en --overwrite=force
node dist/index.js --agent gemini-cli --lang ja --dry-run

```
