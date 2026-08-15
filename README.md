# ChatGPT Review Bridge for OpenCode

Tự động gửi response/diff/plan của agent lên **ChatGPT Plus (web)** để review và
đọc kết quả về trong session — **không cần copy-paste thủ công**.

Sử dụng Playwright + Chrome (profile đăng nhập sẵn) làm cầu nối. Không tốn quota
API: review chạy trên tài khoản ChatGPT Plus bản web của bạn.

---

## Tính năng

- Gọi tay: `@chatgpt-review` từ session opencode.
- Auto-review: sau mỗi task có thay đổi code, agent tự gửi diff lên ChatGPT và báo verdict.
- **Reuse chat theo repo + branch**: mỗi repo+branch có 1 thread ChatGPT riêng, context tích lũy — không tạo new chat vô tội vạ.
- **ChatGPT Projects**: 1 project/repo, review gom gọn, hưởng project memory + custom instructions.
- Fallback an toàn: chat/project lưu bị hỏng → tự mở mới, không crash.
- Headful (mặc định) để vượt Cloudflare; có thể thử `--headless`.

---

## Cài đặt

### 1. Chuẩn bị thư mục bridge

```bash
mkdir -p ~/.config/opencode/chatgpt-bridge/bin
cp bin/chatgpt-review.mjs bin/chatgpt-review bin/autoreview ~/.config/opencode/chatgpt-bridge/bin/
cp package.json ~/.config/opencode/chatgpt-bridge/
cp bridge-config.json ~/.config/opencode/chatgpt-bridge/
cd ~/.config/opencode/chatgpt-bridge && npm install
```

> **Yêu cầu hệ thống**: Linux cần `libnspr4`, `libnss3`, `libasound2` cho Chromium.
> Nếu không có quyền sudo, tải `.deb` và giải nén vào `libs/` rồi set `LD_LIBRARY_PATH`
> (script đã tự động thêm `libs/` vào `LD_LIBRARY_PATH`). Cài Playwright chromium
> theo version khớp `package.json` (hiện `1.62.1`, thư mục `chromium-1234`).

### 2. Cài agent, skill, command, plugin vào opencode

```bash
cp agent/chatgpt-review.md       ~/.config/opencode/agent/
cp -r skill/chatgpt-review       ~/.config/opencode/skills/
cp command/autoreview.md         ~/.config/opencode/command/
cp command/chatgpt-new.md        ~/.config/opencode/command/
cp command/chatgpt-project.md    ~/.config/opencode/command/
cp plugin/chatgpt-autoreview.ts  ~/.config/opencode/plugins/
```

### 3. Đăng nhập ChatGPT (1 lần duy nhất)

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login
```

Mở cửa sổ browser, đăng nhập tài khoản ChatGPT. Script tự phát hiện session
cookie thật (`__Secure-next-auth.session-token`) và lưu profile.

Kiểm tra:

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # → "loggedIn": true
```

### 4. Restart opencode

Thoát session hiện tại và mở lại để load agent/skill/command/plugin mới.

---

## Cách dùng

### Review tay

Trong session opencode (chạy trong repo của bạn):

```
@chatgpt-review review git diff hiện tại theo Issue này
```

Subagent tự đóng gói diff → gửi lên ChatGPT Plus → đọc verdict về.

### Auto-review

```text
/autoreview on      # bật: sau mỗi task có code, agent tự review
/autoreview off     # tắt, chỉ review khi gọi tay
/autoreview status  # xem trạng thái
```

### ChatGPT Projects (thùng chứa theo repo)

Bật theo repo trong `bridge-config.json`:

```json
{ "mode": "single", "project_mode": { "my-repo": true } }
```

Hoặc bật toàn cục: `"mode": "project"`. Hoặc tạm thời: `ask --project`.

Quản lý project:

```text
/chatgpt-project status                  # project đang dùng cho repo này
/chatgpt-project attach <name>           # gắn repo vào project có sẵn
/chatgpt-project detach                  # bỏ gắn
/chatgpt-project create <name>           # tạo project mới
```

Lệnh CLI tương đương: `.../chatgpt-review project list|create|attach|detach|resolve`.

### Chat mới / xem trạng thái

```text
/chatgpt-new    # bắt đầu thread ChatGPT mới cho repo+branch hiện tại
```

```bash
.../chatgpt-review chats    # xem mapping chat theo repo+branch
.../chatgpt-review reset    # xóa mapping chat hiện tại
```

---

## Cấu hình (`bridge-config.json`)

```json
{
  "mode": "single",
  "max_chars": 400000,
  "max_turns": 40,
  "max_age_hours": 48,
  "project_mode": {}
}
```

| Key | Ý nghĩa | Mặc định |
|-----|---------|----------|
| `mode` | `"single"` (chat thường) hoặc `"project"` (dùng ChatGPT Project) | `"single"` |
| `max_chars` | Tổng ký tự prompt+reply tích lũy — chạm ngưỡng thì new chat | `400000` |
| `max_turns` | Số lượt gửi — chạm ngưỡng thì new chat | `40` |
| `max_age_hours` | Giờ kể từ lần dùng cuối — quá hạn thì new chat | `48` |
| `project_mode` | Map tên repo → bật project (ghi đè `mode`) | `{}` |

> Ngưỡng theo model: ChatGPT 4o/4.1 (~128k tokens) dùng `max_chars` thấp hơn,
> GPT-5.x context lớn có thể để `max_chars` cao hơn. Ngưỡng nào chạm trước thì new chat.

---

## Lưu ý / Hạn chế

- **Không commit** `profile/`, `chats.json`, `projects.json`, `autoreview.json`,
  `node_modules/`, `libs/` (chứa session cookie, state cá nhân, dependency).
- ChatGPT web UI thay đổi theo phiên bản → selector có thể lệch. Script báo lỗi rõ
  thay vì tự nhận thành công; kiểm tra `status` nếu gặp lỗi.
- Headless thường bị Cloudflare chặn → mặc định chạy headful. Máy cần có màn hình
  (`$DISPLAY`); trên server headless dùng `xvfb-run`.
- Đổi tên project trên web bằng tay là nhanh nhất (không có CLI rename đáng tin cậy).
- Không hỗ trợ ChatGPT API — bridge dùng giao diện web của tài khoản Plus của bạn.

---

## Cấu trúc thư mục

```
bin/chatgpt-review.mjs       # script bridge chính (Playwright)
bin/chatgpt-review           # wrapper bash
bin/autoreview               # toggle auto-review state
agent/chatgpt-review.md      # subagent opencode (read-only, gọi bridge)
skill/chatgpt-review/        # skill hướng dẫn agent dùng bridge
command/*.md                 # lệnh /autoreview /chatgpt-new /chatgpt-project
plugin/chatgpt-autoreview.ts # plugin: chèn chỉ dẫn auto-review + env
package.json                 # dependency: playwright
bridge-config.json           # cấu hình ngưỡng + chế độ project
```
