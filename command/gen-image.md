---
description: Gen 1–N ảnh qua @chatgpt-review chạy nền (bash & + poll)
agent: build
---

Bạn là image-generation runner. User gọi: `/gen-image <mô tả ảnh>` — `$ARGUMENTS` chính là mô tả ảnh cần tạo (1 hoặc nhiều ảnh).

Thực hiện theo playbook canonical tại `/home/audition/projects/personal/workflow-playbooks/docs/ai-agents/chatgpt-review-image-generation-playbook.md` (đọc file này trước khi chạy, tuân thủ đúng 5 bước). Tóm tắt thực thi:

1. Đọc playbook trên. Viết `$ARGUMENTS` thành prompt file `/tmp/opencode/img-prompt.txt` theo pattern **1 prompt → N ảnh**: đánh số `Ảnh 1..N`, mỗi ảnh ghi tỉ lệ (`16:9`/`1:1`/`3:4`) + phong cách + nội dung chính, yêu cầu "trả từng ảnh riêng, đúng thứ tự".
2. Kiểm tra bridge: `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status` phải `"loggedIn": true`. Nếu `false` → dừng, hướng dẫn `login` / `login --auto`, không gen.
3. Chạy nền (không block session):
   `nohup ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review ask --file /tmp/opencode/img-prompt.txt > /tmp/opencode/img-gen-<timestamp>.log 2>&1 & echo $! > /tmp/opencode/img-gen.pid`
   Sau đó poll `kill -0 $(cat /tmp/opencode/img-gen.pid)` + `tail` log (mỗi 30s, tối đa ~15 phút). Không bắn batch thứ hai khi batch đầu còn RUNNING (bridge serialize qua `.lock`).
4. Lấy URL/file ảnh từ log, `curl` về nơi lưu **tùy ngữ cảnh**: web app → `assets/generated/<yyyy-mm-dd>/`, docs → `docs/assets/<topic>/`, task tạm → `/tmp/opencode/img-out/` rồi move khi chốt. Tên file `lowercase-kebab-case.png`, gắn số thứ tự (`hero-01.png`).
5. `read` từng ảnh để verify vision khớp mô tả; ảnh nào sai gen bù riêng, không gen lại cả batch.

Nếu `$ARGUMENTS` trống → yêu cầu user bổ sung 1 câu mô tả ảnh. Báo kết quả: số ảnh, đường dẫn file đã lưu, log path.
