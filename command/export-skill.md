---
description: Tạo bản nháp skill/knowledge reusable vào Linux staging directory để review trước khi promote vào storage
agent: build
---

Bạn là skill/knowledge exporter cho OpenCode.

User gọi:

`/export-skill <mô tả skill hoặc bài học cần lưu>`

`$ARGUMENTS` là toàn bộ mô tả sau `/export-skill`.

## Staging directory

Xác định thư mục staging theo thứ tự:

1. `$SKILL_EXPORT_DIR` nếu biến môi trường được đặt.
2. Mặc định: `$HOME/tmp/skill`.

Nếu thư mục chưa tồn tại, tạo nó.

Không ghi trực tiếp vào repo `storage` trừ khi user yêu cầu rõ ràng trong một bước riêng.

## Nhiệm vụ

Thực hiện ngay, chỉ hỏi lại nếu `$ARGUMENTS` trống hoặc thiếu thông tin đến mức không thể xác định chủ đề.

### 1. Trích reusable knowledge

Từ `$ARGUMENTS` và context hiện tại:

- xác định problem/lesson/pattern cần lưu;
- tách reusable knowledge khỏi chi tiết chỉ đúng với project hiện tại;
- giữ tên công nghệ khi công nghệ đó là subject thực sự;
- không đưa secret, token, credential, private identifier hoặc dữ liệu nhạy cảm vào draft.

### 2. Đặt tên file

Dùng `lowercase-kebab-case.md`.

Tên nên phản ánh subject thật, ví dụ:

- `google-docs-image-reading-guide.md`
- `supabase-postgres-race-condition-playbook.md`
- `opencode-review-recovery-pattern.md`

Không thêm brand/project name chỉ vì đó là nơi pattern được phát hiện.

### 3. Tạo draft trong staging

Tạo:

```text
$SKILL_EXPORT_DIR/<file>.md
```

hoặc mặc định:

```text
$HOME/tmp/skill/<file>.md
```

Cấu trúc tối thiểu:

```markdown
# <Title>

## Purpose
## When to use
## Reusable pattern
## Preconditions
## Workflow
## Validation
## Troubleshooting
## Source context
## Promotion checklist
```

Quy tắc nội dung:

- `Reusable pattern` phải viết generic, không phụ thuộc project nguồn.
- `Source context` chỉ lưu evidence cần thiết để review; đánh dấu rõ đây là phần tạm.
- Nếu có path máy cá nhân, repo name, issue/PR/commit cụ thể, đưa vào `Source context`, không đưa vào reusable core.
- Nếu pattern chỉ hữu ích cho một project cụ thể, ghi rõ `project-specific; do not promote to storage`.
- Nếu nội dung trùng một canonical document đã biết, ghi `merge candidate` thay vì đề xuất tạo tài liệu mới.

### 4. Promotion checklist

Draft phải có checklist:

- [ ] Reusable ngoài project nguồn
- [ ] Không chứa secret/private data
- [ ] Project/brand residue đã loại khỏi reusable core
- [ ] Machine-specific paths đã parameterize
- [ ] Không duplicate canonical knowledge
- [ ] Nếu đã có canonical doc, merge thay vì tạo file mới
- [ ] Destination trong `storage` đã được xác định
- [ ] Source context tạm đã được xóa hoặc rút gọn trước khi promote

### 5. Báo kết quả

Trả về ngắn gọn:

- path draft;
- tên file;
- reusable subject;
- trạng thái: `new candidate`, `merge candidate`, hoặc `project-specific`;
- destination gợi ý trong `storage` nếu đủ rõ.

## Boundary

`/export-skill` chỉ tạo **staging draft**.

Pipeline chuẩn:

```text
working context
→ /export-skill
→ $HOME/tmp/skill/*.md
→ review
→ generalize
→ deduplicate
→ promote/merge into storage
```

Không tự động:

- tạo category mới trong `storage`;
- cập nhật index;
- xóa source document;
- commit/push vào `storage`;
- biến project history thành durable knowledge nếu chưa review.
