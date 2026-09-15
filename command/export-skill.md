---
description: Tạo skill/playbook markdown mới và export vào workflow-playbooks
agent: build
---

Bạn là skill exporter cho repo `workflow-playbooks`.

Xác định đường dẫn repo `workflow-playbooks` theo thứ tự ưu tiên:
1. Biến môi trường `$WORKFLOW_PLAYBOOKS_DIR` (nếu có).
2. Sibling directory: `../workflow-playbooks` (hoặc `../../workflow-playbooks`).
3. Tìm kiếm trong `$HOME/projects/**/workflow-playbooks`.

Nếu không tìm thấy, thông báo rõ ràng cho user để cung cấp đường dẫn hoặc gán `$WORKFLOW_PLAYBOOKS_DIR`.

User gọi: `/export-skill <mô tả skill>` — `$ARGUMENTS` chính là mô tả skill cần tạo.

Nhiệm vụ (thực hiện ngay, không hỏi lại trừ khi thiếu info nghiêm trọng):

1. Phân tích `$ARGUMENTS` để trích:
   - Tên skill (đặt `lowercase-kebab-case.md`, acronym lowercased theo `meta/naming-conventions.md`)
   - Category phù hợp trong `docs/` (`ai-agents`, `architecture`, `deployment`, `guides`, `interview`, `seo`) — chọn folder khớp nhất, chỉ tạo folder mới khi không có category nào phù hợp.
   - Nội dung: Purpose / When to use / Preconditions / Workflow / Validation / Troubleshooting / References (theo `templates/playbook-template.md`).

2. Tạo file tại `docs/<category>/<tên-file>.md` trong workflow-playbooks:
   - Đọc `meta/naming-conventions.md` và `templates/playbook-template.md` trước khi đặt tên/viết.
   - Nội dung phải là skill/playbook reusable, có ví dụ lệnh cụ thể, có bảng troubleshooting, có References tới case thực tế nếu có.
   - Nếu skill liên quan tới Google Docs + ảnh, tham khảo `docs/guides/google-docs-image-reading-guide.md` như mẫu.

3. Cập nhật `docs/index.md`:
   - Thêm 1 dòng vào bảng index với 5 cột: Document | Category | Purpose | When to use | Path
   - Giữ bảng sort theo Category, không xóa dòng cũ.

4. Báo kết quả ngắn gọn:
   - Đường dẫn file đã tạo
   - Category và lý do chọn
   - Dòng index đã thêm

Quy tắc:
- Không tạo file ngoài `workflow-playbooks/docs/*` trừ khi user chỉ định.
- Tên file `lowercase-kebab-case.md`, không underscore, không space.
- Nếu `$ARGUMENTS` quá ngắn/trống → yêu cầu user bổ sung mô tả 1 câu.

Ví dụ gọi:
- `/export-skill skill đọc Google Docs kèm ảnh qua docx export`
- `/export-skill playbook xử lý race condition khi mua hàng với Supabase Postgres`
