# OpenCode Workflow

Bộ quy trình chuẩn cho OpenCode ↔ ChatGPT Web collaboration, gồm:

1. **Review bridge** — gửi **kết quả tổng kết task** (text summary "Done / What
   changed / Verification") lên **ChatGPT Plus (web)** như một **reviewer độc lập,
   workflow-aware**, đọc về **verdict machine-actionable** giúp tiến workflow.
2. **Gemini bridge** — cùng cơ chế với **Google Gemini (web)**: reviewer thứ hai
   để cross-check (`@gemini-review`), không ghi approval state chính thức.
3. **Policy + config chuẩn** — `opencode.jsonc` (Superpowers + permission policy),
   `AGENTS.md` collaboration, `@vision`, merge wrapper an toàn.
4. **`opencode-work`** — tmux launcher chạy nhiều repo song song (2 pane).

Không cần copy-paste, không gửi raw git diff, không tốn quota API: review chạy
trên tài khoản ChatGPT Plus / Google của bạn (Playwright + Chrome).

---

## Tài liệu

| File | Nội dung |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Kiến trúc + execution contract (phân quyền, policy, PR contract) |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | Review workflow: envelope, state machine, chống loop |
| [`docs/SETUP.md`](docs/SETUP.md) | Cài máy mới / onboarding team + `opencode-work` |

---

## Cài đặt nhanh

```bash
git clone https://github.com/khoawatt/opencode-workflow.git
cd opencode-workflow
bash install.sh                                   # cài bridge global (ChatGPT + Gemini)
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login    # đăng nhập ChatGPT (1 lần)
~/.config/opencode/gemini-bridge/bin/gemini-review login      # (tùy chọn) đăng nhập Google cho Gemini
bash install-project.sh /path/to/your/repo        # cài policy + .opencode vào repo
cp bin/opencode-work ~/.local/bin/ && chmod +x ~/.local/bin/opencode-work   # tmux launcher
```

Chi tiết: [`docs/SETUP.md`](docs/SETUP.md).

---

## Tính năng (review bridge)

- Gọi tay: `@chatgpt-review` từ session opencode.
- Auto-review: sau mỗi task có thay đổi code, agent tự gửi **text summary kết quả**
  lên ChatGPT và báo verdict (không gửi git diff).
- **Workflow-aware**: envelope ghi rõ mục tiêu, giai đoạn, quyết định cần ChatGPT
  đưa ra, next-action nếu approve / request-changes, và phân quyền từng bên.
- **Chống vòng lặp review**: lưu trạng thái `approve` + HEAD SHA; nếu state chưa đổi
  thì không review lại, chỉ báo "awaiting human merge".
- **Reuse chat theo repo + branch**: mỗi repo+branch có 1 thread ChatGPT riêng, context tích lũy.
- **ChatGPT Projects**: 1 project/repo, hưởng project memory + custom instructions.
- **Gemini bridge (ý kiến thứ hai)**: `@gemini-review` gửi cùng envelope lên
  Google Gemini (web) để cross-check; verdict chỉ mang tính tham khảo, không ghi
  vào approval state chính thức (vẫn là ChatGPT).
- **Concurrency-safe**: file lock serialize mọi lần chạy (mỗi bridge 1 Chrome profile)
  → 2 repo chạy song song không đụng nhau; stale lock (PID chết) tự dọn.
- Fallback an toàn: chat/project lưu bị hỏng → tự mở mới, không crash.
- Headful (mặc định) để vượt Cloudflare; có thể thử `--headless`.

---

## Cài đặt

### Nhanh nhất — chạy 1 lệnh (tự động hoàn toàn)

```bash
git clone https://github.com/khoawatt/opencode-workflow.git
cd opencode-workflow
bash install.sh
```

`install.sh` tự làm hết: copy agent/skill/command/plugin vào `~/.config/opencode/`,
`npm install`, cài Playwright Chromium, và cài system libraries cho Chromium
(ưu tiên sudo; không có sudo thì tự tải `.deb` giải nén vào `libs/` user-space).

Sau đó chỉ còn 2 việc tay:

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login   # đăng nhập ChatGPT (1 lần)
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # phải ra "loggedIn": true
```

Rồi **restart opencode**.

### Giao cho agent khác tự setup (đổi máy / nhờ người khác)

Chỉ cần đưa prompt sau (kèm repo này đã clone sẵn hoặc URL repo) — agent sẽ đọc
`AGENTS.md` trong repo và tự làm:

```text
Setup the ChatGPT review bridge from this repo on this machine:
clone it if not present, run `bash install.sh`, then run
`~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login` and have me sign in,
then verify with `status` shows loggedIn:true. Follow AGENTS.md exactly.
```

Repo đã có sẵn `AGENTS.md` hướng dẫn từng bước, gồm cả phần verification checklist
và troubleshooting cho agent.

### Cài thủ công (nếu muốn tự kiểm soát từng bước)

#### 1. Chuẩn bị thư mục bridge

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
> theo version khớp `package.json`. Bridge **tự tìm** Chromium trong
> `~/.cache/ms-playwright` — không hardcode version nên không cần chỉnh khi đổi máy.

#### 2. Cài agent, skill, command, plugin vào opencode

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
@chatgpt-review review kết quả task vừa hoàn thành: <dán text summary "Done / What changed / Verification">
```

Hoặc đơn giản hơn, khi agent vừa báo xong kết quả:

```
@chatgpt-review review kết quả task bạn vừa trả lời
```

Subagent bọc text summary đó trong envelope workflow (mode/goal/stage/decision/
authority), gửi lên ChatGPT Plus, đọc verdict machine-actionable về.

### Verdict & chống vòng lặp review

ChatGPT trả về:

```text
VERDICT: approve | approve-with-changes | request-changes | reject
NEXT_ACTION: <hành động tiếp theo>
ISSUES: <danh sách hoặc "none">
SUGGESTIONS: <tùy chọn>
```

Trạng thái phê duyệt lưu theo repo+branch (`approval` trong `chats.json`):

```bash
.../chatgpt-review approval get                          # xem trạng thái phê duyệt
.../chatgpt-review approval set approve <headSha> [pr]   # ghi phê duyệt (subagent tự ghi)
.../chatgpt-review approval clear                        # xóa
```

- Đã `approve` + HEAD SHA không đổi → **không review lại**, chỉ báo "awaiting human merge".
- HEAD SHA đổi / có fix mới / CI fail → review lại.
- `approve` **không** có nghĩa là OpenCode được merge — merge là quyền human.

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
/gemini-new     # bắt đầu thread Gemini mới cho repo+branch hiện tại
```

```bash
.../chatgpt-review chats    # xem mapping chat theo repo+branch
.../chatgpt-review reset    # xóa mapping chat hiện tại
~/.config/opencode/gemini-bridge/bin/gemini-review chats   # mapping của Gemini
~/.config/opencode/gemini-bridge/bin/gemini-review reset   # xóa mapping Gemini
```

### Gemini review (ý kiến thứ hai)

Đăng nhập Google một lần:

```bash
~/.config/opencode/gemini-bridge/bin/gemini-review login    # đăng nhập Google account
~/.config/opencode/gemini-bridge/bin/gemini-review status   # → "loggedIn": true
```

Gọi trong session opencode:

```
@gemini-review cross-check kết quả task vừa review bằng ChatGPT: <summary>
```

Gemini nhận cùng envelope workflow và trả về cùng format verdict
(`VERDICT / NEXT_ACTION / ISSUES / SUGGESTIONS`). Lưu ý:

- Verdict của Gemini **không** ghi vào approval state — merge gate vẫn chỉ nhận
  approval từ ChatGPT (`templates/merge-approved-pr.sh`).
- Dùng khi cần đối chiếu chéo, hoặc khi ChatGPT đang bận (lock) mà cần ý kiến nhanh.

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
README.md                      # tổng quan
docs/ARCHITECTURE.md           # kiến trúc + execution contract (phân quyền, policy)
docs/WORKFLOW.md               # review workflow: envelope, state machine, anti-loop
docs/SETUP.md                  # cài máy mới + opencode-work
install.sh                     # setup global bridge (config + npm + chromium + libs)
install-project.sh             # cài policy + .opencode vào 1 repo (merge, không ghi đè)
bin/chatgpt-review.mjs         # script bridge ChatGPT chính (Playwright, có lock + approval)
bin/chatgpt-review             # wrapper bash
bin/gemini-review.mjs          # script bridge Gemini web (Playwright, có lock)
bin/gemini-review              # wrapper bash
bin/autoreview                 # toggle auto-review state
bin/opencode-work              # tmux launcher chạy nhiều repo song song
agent/chatgpt-review.md        # subagent dispatcher (workflow-aware, heredoc stdin)
agent/gemini-review.md         # subagent second-opinion reviewer (Gemini web)
skill/chatgpt-review/          # skill hướng dẫn
skill/gemini-review/           # skill hướng dẫn Gemini bridge
command/*.md                   # /autoreview /chatgpt-new /gemini-new /chatgpt-project
plugin/chatgpt-autoreview.ts   # plugin: chèn chỉ dẫn auto-review + env
templates/opencode.jsonc       # policy chuẩn (Superpowers + permission)
templates/AGENTS.collaboration.md  # mục collaboration chuẩn
templates/vision.md            # subagent @vision
templates/merge-approved-pr.sh # merge wrapper an toàn (ChatGPT approval + HEAD + CI)
package.json                   # dependency: playwright
bridge-config.json             # cấu hình ngưỡng + chế độ project
```

## Đổi máy — checklist

1. Clone repo: `git clone https://github.com/khoawatt/opencode-workflow.git`
2. `bash install.sh`
3. `.../chatgpt-review login` → đăng nhập ChatGPT → chờ "LOGIN OK"
4. `.../chatgpt-review status` → `loggedIn: true`
5. (tùy chọn) `~/.config/opencode/gemini-bridge/bin/gemini-review login` → đăng nhập Google → `status` → `loggedIn: true`
6. `bash install-project.sh <repo>` cho từng repo
7. `cp bin/opencode-work ~/.local/bin/` (tmux launcher)
8. Restart opencode → `@chatgpt-review` / `@gemini-review` dùng được ngay.

Hoặc đưa repo cho bất kỳ agent nào kèm `AGENTS.md` — agent tự chạy mọi bước theo runbook.

---

## Đóng góp (Contributing)

Mọi đóng góp đều được hoan nghênh. Vui lòng xem [CONTRIBUTING.md](CONTRIBUTING.md) và [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) trước khi tạo pull request.

---

## Tác giả & Contributors

* **Quách Võ Anh Khoa** ([@khoawatt](https://github.com/khoawatt)) — Author & Maintainer
* **Audition MLD** ([@audition-mld](https://github.com/audition-mld)) — Contributor

---

## Giấy phép (License)

Dự án được phân phối dưới giấy phép **MIT License**. Xem chi tiết tại [LICENSE](LICENSE).

---

## Bảo mật (Security)

Vui lòng xem [SECURITY.md](SECURITY.md) để báo cáo lỗ hổng bảo mật. Không mở issue công khai cho vấn đề bảo mật.
<!-- yolo: readme touch for GitHub YOLO achievement -->
