# Troubleshooting và rollback (opencode-workflow)

| Hiện tượng | Cách xử lý |
|---|---|
| `Chromium not found` | `npm exec --prefix ~/.config/opencode/chatgpt-bridge playwright install chromium` (hoặc `bash install.sh --deps`) |
| `libnspr4.so` / `libnss3.so` / `libasound.so` not found | re-run `bash install.sh --deps` — installer thử `sudo apt-get install` nếu có passwordless sudo, else extract user-space `.deb` vào `libs/` |
| `chatgpt-review` báo `loggedIn: false` | chạy `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login` trong desktop có display, đợi `LOGIN OK` |
| `chatgpt-review login` muốn đổi account | `chatgpt-review login --switch` (giữ browser mở, đợi token đổi; thêm `--wait=30` để giữ mở 30s sau login mới) |
| `chatgpt-review login` treo sau khi đóng window | đã fix `browserClosed` detection — đóng window sẽ báo `LOGIN OK (browser closed)` nếu có session, else `No session cookie`; nếu vẫn treo, `cat ~/.config/opencode/chatgpt-bridge/.lock` và check PID |
| Bridge không tìm thấy prompt input | ChatGPT Web có thể đã đổi UI; cập nhật bridge, không coi lần review là thành công. Thử `chatgpt-review status` headful để debug `url/title/loggedIn` |
| Codex/OpenCode không tự review | kiểm tra `~/.config/opencode/opencode.jsonc` có plugin `superpowers` không, rồi restart opencode |
| Bridge đang bị lock | chờ lần review hiện tại xong; lock của PID đã chết sẽ tự được dọn (`kill(pid,0)` + `Atomics.wait`). Kiểm tra `cat ~/.config/opencode/chatgpt-bridge/.lock` |
| Auto-review đổi trạng thái nhưng session cũ không làm theo | plugin `chatgpt-autoreview.ts` chỉ inject khi `autoreview.json:enabled=true`; restart opencode session đó |
| Approval không khớp HEAD/PR/repo | `chatgpt-review approval get` so sánh `head_sha` 40-char + `pr` + repo case-insensitive; `approval clear` rồi review lại exact HEAD |
| ChatGPT Project command lỗi / `could not fetch projects` | đã fix direct `fetch` + 3 lần retry (in-flight → goto → reload); nếu vẫn lỗi, dùng plain `ask --no-project` |
| Sidebar collapsed làm `create project` bấm hụt | đã fix auto-expand `Open sidebar` + `data-state` check (dbg3 vs dbg4) |
| `gemini-review` báo `loggedIn: false` | `~/.config/opencode/gemini-bridge/bin/gemini-review login` trong môi trường có display, hoàn thành consent screen |
| `gemini-review` báo `guestAvailable:true` | Gemini cho guest gửi prompt nhưng chưa có account identity thật — đăng nhập Google account đầy đủ, đợi 3 stable checks (5s settled) |
| Gemini không tìm thấy prompt/send/response | Gemini Web đã đổi UI; không coi scrape thành công và cập nhật selector (`PROMPT_SELECTORS`/`SEND_SELECTORS`/`REPLY_SELECTORS`) |
| `opencode-work: command not found` | thêm `~/.local/bin` vào `PATH` |
| `opencode-work` báo `Project ... is missing` | `bash install.sh` để clone, hoặc sửa checkout path trong `~/.config/opencode/projects.conf` |
| Session không khớp config | `opencode-work --reset` |
| Đang ở trong tmux `switch-client` | script đã xử lý nested tmux via `switch-client`; check `command -v opencode-work` |
| last resort | `tmux kill-session -t opencode-work` rồi `opencode-work`; không dùng `tmux kill-server` (đóng cả session không liên quan) |

## Kiểm tra session

```bash
opencode-work --status
tmux ls
tmux list-panes -t opencode-work -F '#{pane_id}|#{pane_current_path}|#{pane_current_command}'
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status
~/.config/opencode/gemini-bridge/bin/gemini-review status
```

## Rollback local

Detach trước nếu đang ở trong session:

```bash
tmux kill-session -t opencode-work       # chỉ khi muốn dừng các OpenCode process trong workspace
rm ~/.local/bin/opencode-work
rm ~/.local/bin/chatgpt-review ~/.local/bin/gemini-review
```

Config local có thể giữ để cài lại. Nếu thật sự không cần nữa, backup rồi xóa `~/.config/opencode/chatgpt-bridge/` / `gemini-bridge/` riêng. Không dùng `tmux kill-server`.

Rollback riêng ChatGPT/Gemini được mô tả trong `docs/CHATGPT_WEB.md` / `docs/GEMINI_WEB.md`; việc xóa profile browser sẽ đăng xuất bridge và không ảnh hưởng opencode auth.
