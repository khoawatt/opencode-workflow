---
description: Nhờ agy (Antigravity CLI) làm 1 task headless trong subtask riêng
agent: build
subtask: true
---

Nhờ `agy` (Antigravity CLI, headless/print mode) thực hiện task sau cho repo hiện tại.
Chạy trong subtask này, KHÔNG làm bẩn context chính. `$ARGUMENTS` là task.

1. Soạn prompt gồm: mục tiêu, phạm vi file, tiêu chí done. Nếu `$ARGUMENTS` đã đủ rõ thì dùng nguyên văn.
2. Chạy từ project root (workdir hiện tại), flag LUÔN đứng trước `-p`:
   - Task hỏi kiến thức thuần túy (không nhắc tới file/repo): `agy --output-format json -p "$ARGUMENTS"`
   - Mọi task còn lại (review diff, sửa file, chạy lệnh): thêm `--dangerously-skip-permissions`
     (kể cả review: agy vẫn có thể tự chạy lệnh để kiểm chứng, thiếu flag này là soft-deny —
     response rỗng mà exit vẫn 0).
   - Việc khó: thêm `--effort high`; muốn cấm sửa code: thêm `--mode plan`
     (đi kèm `--dangerously-skip-permissions` để chỉ mở đọc/kiểm chứng, vẫn chặn mutation).
3. Parse JSON trả về: `.status` phải là `SUCCESS`; nếu có `.denied_actions` thì báo rõ tool nào bị từ chối.
   Nếu agy sửa file: tự verify bằng `git diff --stat`; chưa đạt thì hỏi tiếp tối đa 2 vòng bằng
   `agy --conversation <conversation_id> --output-format json -p "..."`.
4. Trả lời user ngắn gọn: kết quả (phần `.response`), file nào đã đổi (nếu có),
   lệnh verify đã chạy, và `conversation_id` để hỏi tiếp.
