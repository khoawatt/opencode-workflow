# Gọi `agy` (Antigravity CLI) từ opencode — Hướng dẫn thực hành

> Máy đã verify: `agy` tại `/home/audition/.local/bin/agy`, opencode gọi qua `bash` tool.
> Tài liệu gốc: `https://antigravity.google/docs/cli/headless/` (headless/print mode).
> Mọi lệnh dưới đã chạy thật trên máy này (xem mục 8 — Kết quả verify).

---

## 1. Mô hình tổng thể

```
Bạn  <──>  opencode (Muse Spark)  ──bash──>  agy -p "..."  ──>  Antigravity agent
              │                                        │
              │  đọc stdout (text/json/stream-json)    │  đọc/ghi file, chạy lệnh
              │  giữ conversation_id để hỏi tiếp      │  trong workspace (cwd)
              ▼                                        ▼
        tổng hợp, review, quyết định            làm task, trả lời, sửa code
```

Nguyên tắc:

- **opencode là điều phối chính** (giữ ngữ cảnh, chia task, kiểm tra kết quả).
- **`agy -p` là headless worker** (stateless mặc định — mỗi lần gọi là 1 process mới).
- Muốn `agy` nhớ ngữ cảnh: dùng `--continue` / `--conversation <id>` / `stream-json` giữ process.
- Muốn `agy` đụng vào file/lệnh mà không bị chặn: thêm `--dangerously-skip-permissions`.

---

## 2. Điều kiện tiên quyết (bắt buộc)

1. **Đã login 1 lần bằng interactive:** mở `agy` (không `-p`), đăng nhập xong rồi mới dùng headless.
   Headless dùng credential cache — chưa login thì lỗi `authentication required`, không treo chờ.
2. **Chạy đúng workspace được trust.** `agy` lấy `cwd` làm workspace.
   Verify thực tế: chạy ở `/tmp/agy-cwd-test` bị `NotFound: FileSystem.access (/tmp/agy-cwd-test)`,
   vì `~/.gemini/antigravity-cli/settings.json` chỉ trust:
   ```json
   "trustedWorkspaces": ["/home/audition", "/home/audition/projects/personal/agy-workflow"]
   ```
   → Luôn đặt `workdir` của opencode `bash` là thư mục project (VD: repo hiện tại).
   Muốn mở rộng: thêm path vào `trustedWorkspaces` hoặc chạy `agy` 1 lần ở thư mục đó để approve.
3. **Hiểu split stdout/stderr:** response → `stdout`, diagnostic/lỗi/quyền → `stderr`.
   Pattern bắt response sạch: `answer=$(agy -p "...")`.

---

## 3. Các cách gọi hiệu quả nhất (xếp theo tần suất dùng)

### Cách 1 — Hỏi 1 câu (nhanh, rẻ) ⭐ dùng nhiều nhất

```bash
agy -p "giải thích ngắn gọn: git rebase là gì?"
```

- Dùng khi: hỏi kiến thức, nhờ giải thích, review 1 đoạn code ngắn, xin ý kiến thứ hai.
- Mặc định `--output-format text`, response in thẳng ra stdout.

### Cách 2 — Lấy JSON để máy parse (khuyên dùng cho opencode) ⭐⭐

```bash
agy --output-format json -p "trả lời đúng 1 từ: OK"
# {"conversation_id":"...","status":"SUCCESS","response":"OK\n",
#  "duration_seconds":1.7,"num_turns":1,
#  "usage":{"input_tokens":...,"output_tokens":...,...}}
```

Parse bằng `jq`:

```bash
agy --output-format json -p "kể tên 3 VCS, cách nhau bằng dấu phẩy" | jq -r '.response'
agy --output-format json -p "..." | jq -r '.status'          # SUCCESS | ERROR | ...
agy --output-format json -p "..." | jq '.usage'              # token usage
CID=$(agy --output-format json -p "..." | jq -r '.conversation_id')  # giữ ID để hỏi tiếp
```

> ⚠️ **Bẫy parse flag (đã dính thật):** `-p` nuốt luôn tham số đứng ngay sau nó làm prompt.
> `agy -p --output-format json "..."` → lỗi
> `"-p took --output-format as its prompt"`.
> **Luôn để `--output-format` (và mọi flag) TRƯỚC `-p`, hoặc viết `-p='prompt'`.**

### Cách 3 — Giao task sửa file/chạy lệnh (phải có auto-approve) ⭐⭐

```bash
agy --dangerously-skip-permissions --output-format json \
  -p "đọc file /tmp/opencode-agy-test/input.txt và tạo file /tmp/opencode-agy-test/output.txt với nội dung viết HOA, trả lời DONE khi xong"
```

Verify thật: không có flag → tool `command` bị **soft-deny**, run vẫn exit `0` nhưng response rỗng +
`stderr: "jetski: no output produced — a tool required the command permission..."` +
JSON có `"denied_actions":[{"action":"command",...}]`.
Có flag → tạo file `output.txt` nội dung `HELLO`, response `DONE`.

- Dùng khi: nhờ `agy` implement, refactor, chạy test, sửa file.
- Luôn kèm `--output-format json` để opencode kiểm tra `.status` và `.denied_actions`.

### Cách 4 — Hỏi tiếp (giữ ngữ cảnh, mỗi lần 1 process)

```bash
# Hỏi turn 1, giữ conversation_id
CID=$(agy --output-format json -p "đặt tên biến là BlueSky42, trả lời: nhớ BlueSky42" | jq -r '.conversation_id')

# Cách 4a: tiếp tục hội thoại gần nhất (dễ nhất)
agy --continue --output-format json -p "biến lúc nãy tên gì?"

# Cách 4b: tiếp tục đúng hội thoại theo ID (chính xác nhất, khuyên dùng)
agy --conversation "$CID" --output-format json -p "biến lúc nãy tên gì?"
```

Verify thật: cả 2 cách đều trả lời đúng `BlueSky42`, `num_turns` tăng 2 → 3.

### Cách 5 — Session stream nhiều turn trong 1 process (nhanh nhất cho đối thoại dài) ⭐

```bash
printf '%s\n' \
  '{"event":"user","message":{"content":"trả lời đúng 1 từ: APPLE"}}' \
  '{"event":"user","message":{"content":"từ lúc nãy là gì? trả lời 1 từ"}}' \
  | agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions \
  | jq -r 'select(.event=="result") | "\(.result.num_turns): \(.result.response)"'
# 1: APPLE
# 2: APPLE
```

- Bắt buộc cặp đôi `--input-format stream-json` + `--output-format stream-json`.
- Mỗi dòng stdin là 1 object `{"event":"user","message":{"content":"..."}}`.
- Đọc `stdout` theo dòng, đợi event `"result"` của turn hiện tại rồi mới gửi prompt tiếp.
- Đóng `stdin` để kết thúc session (vẫn nhận đủ `result` cuối).
- Lưu ý: `num_turns`/`usage`/`duration_seconds` là **cộng dồn cả session**, chỉ `response` là của turn hiện tại.
- Lỗi thường gặp (đã dính): gửi `{"role":"user",...}` thiếu `"event"` →
  `ERROR ... "stream input message is missing the event field"`. Dùng đúng schema `event/message/content` ở trên.
- Không gửi `-p` kèm stream mode (prompt CLI sẽ bị bỏ), không gửi slash command (`/model`, `/usage`) vào stream.

### Cách 6 — Ép model / effort / agent / mode theo việc

```bash
agy models                                  # liệt kê slug model
agy agents                                  # liệt kê agent (máy này hiện rỗng = chỉ có default)

agy --model gemini-3.8-flash-low --output-format json -p "trả lời đúng 1 từ: HI"
agy --effort low --output-format json -p "việc đơn giản, trả lời 1 từ OK"
agy --effort high --output-format json -p "lập plan thêm cache cho service X"
agy --agent default --output-format json -p "trả lời đúng 1 từ: AGENT_OK"
agy --mode plan --output-format json -p "chỉ lập plan, không sửa code"
```

Gợi ý chọn:

| Việc | Model/effort/mode |
|---|---|
| Hỏi nhanh, review lặt vặt | `gemini-3.x-flash-low`, `--effort low` |
| Implement thông thường | model flash medium/high, mặc định effort |
| Plan kiến trúc, bug khó | `--effort high`, `--mode plan` trước |
| Chỉ tư vấn, cấm sửa code | `--mode plan` (+ `--dangerously-skip-permissions` để qua lớp confirm — plan mode vẫn chặn mutation về cấu trúc) |
| Model sai tên | headless **fail loudly** exit `1`, `status: ERROR` (không fallback lặng lẽ như UI) |

### Cách 7 — Đưa ngữ cảnh vào prompt (file, diff, nhiều repo)

`agy` không tự đọc stdin text (đã verify: pipe `cat file | agy -p ...` bị soft-deny `command`).
Cách đúng là **nội suy nội dung vào chuỗi prompt** từ phía opencode:

```bash
# Nội dung file
agy --output-format json -p "$(cat <<'EOF'
Đọc nội dung sau và tóm tắt 3 từ:
Nội dung: Hệ thống quản lý kho hàng thông minh
EOF
)"

# Kèm git diff để nhờ review (pattern chuẩn)
agy --dangerously-skip-permissions --output-format json -p "$(cat <<EOF
Review diff sau, chỉ liệt kê lỗi logic (không cần khen):
$(git diff --stat; echo '---'; git diff | head -n 200)
EOF
)"

# Làm việc đa thư mục
agy --add-dir /tmp --add-dir ~/projects/other --output-format json -p "..."
```

### Cách 8 — Chạy an toàn có giới hạn (thay vì auto-approve toàn bộ)

```bash
agy --sandbox --output-format json -p "..."          # sandbox terminal
agy --print-timeout 15m --output-format json -p "..." # mặc định 5m; hết timeout trả partial + warning trên stderr (không fail như interrupt/Ctrl-C)
agy --disable-slash-commands --output-format json -p "..."  # chặn slash/skill expansion trong print mode
agy --log-file /tmp/agy.log --output-format json -p "..."   # log riêng
```

Quyền chi tiết (`~/.gemini/antigravity-cli/settings.json`):

```json
{ "permissions": { "allow": ["command(git)", "command(regex:npm run (build|lint|test))", "write_file(src/)"] } }
```

> ⚠️ Ghi chú thực tế: cộng đồng báo headless `-p` đôi khi **không tôn trọng `permissions.allow`** như interactive
> (tool vẫn soft-deny; rule `command(python3)` không match `python3 -c '...'` — chỉ exact string hoặc `command(*)` mới match).
> Quy tắc vận hành: task chỉ đọc → thử không flag trước; task cần tool → dùng `--dangerously-skip-permissions`
> + giới hạn bằng `--mode plan` (khi chỉ cần tư vấn) hoặc chạy trong worktree/container riêng.

---

## 4. Bảng flag (đã verify trên máy)

| Flag | Mặc định | Dùng cho opencode gọi agy |
|---|---|---|
| `-p`, `--print`, `--prompt` | — | Chạy 1 prompt rồi thoát (headless). Nhớ: flag khác phải đứng TRƯỚC `-p` |
| `--output-format` | `text` | `text` (người đọc) / `json` (opencode parse — khuyên dùng) / `stream-json` (theo dõi realtime) |
| `--input-format` | `text` | `stream-json`: đọc prompt NDJSON từ stdin, nhiều turn/1 process |
| `--json-schema` | — | Nhận chuỗi schema hoặc path file. Đo thực tế trên máy: model trả JSON bọc markdown, trường `structured_output` có thể `None` → phía opencode tự trích JSON từ `.response` thay vì trông chờ field này |
| `--model` | model đang dùng | Pin slug từ `agy models` |
| `--effort` | — | `low` / `medium` / `high` |
| `--agent` | default | Tên từ `agy agents` |
| `--mode` | — | `accept-edits` / `plan` |
| `-c`, `--continue` | false | Tiếp tục hội thoại gần nhất |
| `--conversation` | — | Tiếp tục đúng ID (`conversation_id` từ lần chạy `json` trước) |
| `--dangerously-skip-permissions` | false | Auto-approve mọi tool — bắt buộc cho task tự động sửa file/chạy lệnh |
| `--add-dir` | [] | Thêm thư mục vào workspace (lặp lại được) |
| `--sandbox` | false | Sandbox terminal |
| `--disable-slash-commands` | false | Tắt slash/skill expansion ở print mode |
| `--print-timeout` | `5m` | Trần chờ response (VD: `2m`, `15m`) |
| `--project` / `--new-project` | — | Chọn/tạo project cho session |
| `-i`, `--prompt-interactive` | — | Chạy prompt đầu rồi ở lại interactive — **không dùng cho opencode gọi máy** |
| `agy mcp list/add/remove/enable/disable` | — | Quản lý MCP server cho agy (máy này: `No MCP servers configured`) |
| `agy remote-control start/status/stop` | — | Daemon remote-control — không phải kênh opencode→agy, bỏ qua |

---

## 5. Mẫu tích hợp vào opencode (copy-paste được)

### 5a. Gọi trực tiếp từ session (không cần setup gì)

> Bạn chat với opencode, opencode tự gọi `bash`:
> `agy --output-format json --dangerously-skip-permissions -p "<prompt + ngữ cảnh>"`,
> parse `.response` / `.status`, báo lại bạn. Đây là cách hiệu quả nhất hiện tại — không cần plugin.

### 5b. Slash command `/agy` (gọi nhanh tay) — ✅ đã cài

File `command/agy.md` trong repo này (deploy vào `~/.config/opencode/command/agy.md`
qua `bash install.sh --config`). Nội dung: `agent: build` + `subtask: true`
(chạy cô lập, không làm bẩn context chính). Chi tiết xem file gốc trong repo.

Dùng: `/agy review hàm X trong file Y, liệt kê edge case`.

### 5c. Subagent `agy-worker` (task lớn, nhiều bước) — ✅ đã cài

File `agent/agy-worker.md` trong repo này (deploy vào `~/.config/opencode/agent/agy-worker.md`;
`install.sh` đã có dòng copy riêng). Quyền: `edit: deny`, chỉ cho `bash: agy *` + git read-only
(`status/diff/rev-parse/log/branch`). Mẫu nội dung:

```markdown
---
description: Ủy thác task implementation cho agy headless, opencode giữ vai trò điều phối + kiểm tra
mode: subagent
permission:
  bash:
    'agy *': allow
    'git diff *': allow
    'git status *': allow
    '*': deny
---
1. Nhận TASK từ caller, soạn prompt gồm: mục tiêu, phạm vi file, tiêu chí done, ràng buộc (không sửa file ngoài phạm vi).
2. Chạy: `agy --dangerously-skip-permissions --output-format json --effort high -p "<TASK>"`.
3. Parse JSON: `.status` phải SUCCESS; `.response` là kết quả; giữ `.conversation_id`.
4. Tự verify bằng `git diff --stat` / chạy test liên quan; nếu chưa đạt, hỏi tiếp bằng `agy --conversation <id> ...` tối đa 2 vòng.
5. Trả về caller: tóm tắt thay đổi + lệnh verify đã chạy + conversation_id.
```

### 5d. Second-opinion (opencode làm, agy review — hoặc ngược lại)

```bash
# opencode implement xong → nhờ agy review diff
# LƯU Ý (verify 14/09): kể cả task review thuần túy, agy vẫn có thể tự ý chạy
# lệnh để kiểm chứng → không có --dangerously-skip-permissions sẽ bị soft-deny
# (response rỗng, .denied_actions=[command]). --mode plan chặn mutation về
# cấu trúc nên cặp đôi này vẫn an toàn cho review.
agy --mode plan --dangerously-skip-permissions --output-format json -p "$(cat <<EOF
Bạn là reviewer độc lập. Chỉ liệt kê lỗi logic/blocker từ diff sau, dạng:
VERDICT: approve | request-changes
ISSUES: 1. ... 2. ...
$(git diff | head -n 300)
EOF
)" | jq -r '.response'
```

---

## 6. Chọn pattern nào? (cheat sheet)

| Tình huống | Pattern |
|---|---|
| Bạn đang chat với opencode, muốn tham khảo ý agy | Cách 1/2: opencode gọi `agy -p` 1 câu |
| Nhờ agy sửa code/chạy test thật | Cách 3 (`--dangerously-skip-permissions` + `json` + tự verify `git diff`) |
| Trao đổi qua lại với agy về 1 chủ đề | Cách 4 (`--conversation <id>`) — đơn giản; Cách 5 (stream) — nhanh khi nhiều vòng |
| Cần máy parse kết quả (verdict, list) | Cách 2 + `jq`, dặn model "chỉ trả JSON thô, không bọc markdown" (vì `--json-schema` đo thực tế chưa ép cứng) |
| Việc khó, sợ agy sửa bậy | `--mode plan` + `--effort high` trước, duyệt plan rồi mới cho implement |
| So sánh nhiều phương án song song | mở nhiều `bash` calls song song, mỗi call 1 `agy -p` với model/effort khác nhau |
| Theo dõi tool agy đang làm gì realtime | `--output-format stream-json` + `jq '.step_update.tool_info // empty'` |

---

## 7. Bẫy thường gặp (tổng hợp từ verify + docs + issue cộng đồng)

1. **Thứ tự flag với `-p`**: flag sau `-p` bị nuốt làm prompt. Luôn viết flag trước `-p`.
2. **Quên auto-approve**: task cần tool mà thiếu `--dangerously-skip-permissions` → response rỗng, exit vẫn `0`. Phải đọc `stderr` + `.denied_actions`, đừng tưởng model "từ chối trả lời".
3. **Sai `cwd`**: `agy` chỉ làm việc trong workspace được trust. Luôn chạy từ repo project; thêm `--add-dir` khi cần thư mục ngoài.
4. **Bug non-TTY cũ**: bản `agy` cũ khi bị tool khác capture stdout (pipe/subprocess) có thể trả stdout rỗng dù model đã sinh text. Bản hiện tại đã có `--output-format json|stream-json` làm kênh máy-đọc tin cậy — opencode luôn dùng `json`, không parse `text` trần cho pipeline quan trọng.
5. **`permissions.allow` match chuỗi exact**: `command(python3)` không cover `python3 -c ...`. Muốn chắc cho automation: dùng `--dangerously-skip-permissions` trong môi trường tin cậy (worktree riêng).
6. **`--json-schema` chưa ép cứng**: đo thực tế trả JSON trong markdown, `structured_output: None`. Dặn prompt `trả JSON thô` + parse phía opencode.
7. **Stream schema nghiêm**: thiếu `"event"` là cả session `ERROR` exit `1`. Copy đúng mẫu mục 3–Cách 5.
8. **Timeout**: `--print-timeout` hết → partial output + warning (exit vẫn `0`); chỉ Ctrl-C/interrupt mới non-zero. Pipeline CI phải check `.status`, đừng chỉ check exit code.
9. **`-i/--prompt-interactive`** mở interactive — không dùng trong opencode non-interactive.

---

## 8. Kết quả verify trên máy này (bằng chứng)

| Test | Lệnh | Kết quả |
|---|---|---|
| Hỏi 1 từ | `agy -p "trả lời đúng 1 từ: OK"` | `OK`, exit 0 |
| JSON envelope | `agy --output-format json -p "..."` | có `conversation_id/status/response/usage` |
| Sai thứ tự flag | `agy -p --output-format json "..."` | lỗi `-p took "--output-format" as its prompt` |
| Nhớ ngữ cảnh | 2 calls `--continue` / `--conversation $CID` với `BlueSky42` | cả 2 trả đúng `BlueSky42`, `num_turns` 2→3 |
| Task file | `--dangerously-skip-permissions -p "đọc input.txt, tạo output.txt HOA"` | `output.txt` = `HELLO`, response `DONE` |
| Thiếu quyền | pipe `cat file \| agy -p ...` (không flag) | `denied_actions: command`, response rỗng |
| Model/effort/agent/mode/add-dir/sandbox/timeout/noslash | các flags tương ứng + prompt 1 từ | đều `SUCCESS` |
| Stream stdin đúng schema | 2 dòng `{"event":"user",...}` qua `--input-format stream-json` | 2 `result` APPLE/APPLE, cùng `conversation_id` |
| Stream sai schema | `{"role":"user",...}` | `ERROR missing the "event" field` |
| Heredoc prompt | `-p "$(cat <<'EOF' ...)"` | tóm tắt đúng |
| CWD ngoài trust | chạy ở `/tmp/agy-cwd-test` | `NotFound: FileSystem.access` |
| JSON schema | `--json-schema '{...verdict...}'` | `response` là JSON bọc markdown, `structured_output: None` |
| `agy models` | — | 14 slugs (gemini-3.8/3.7/3.6 flash high/med/low, gemini-3.1 pro, claude-sonnet-4-6, claude-opus-4-6, gpt-oss-120b) |
| `agy agents` / `agy mcp list` | — | agents rỗng; `No MCP servers configured` |

---

## 9. Quy trình khuyên dùng hàng ngày

1. Bạn mô tả mục tiêu cho opencode.
2. opencode tự soạn prompt giàu ngữ cảnh (mục tiêu + phạm vi file + diff/test liên quan + tiêu chí done) rồi gọi `agy --output-format json ...` (thêm `--dangerously-skip-permissions` khi cần tool).
3. opencode parse `.status`/`.response`, tự verify (`git diff`, chạy test), chưa đạt thì `--conversation <id>` hỏi tiếp (tối đa 2–3 vòng).
4. opencode tổng hợp lại cho bạn: agy đã làm gì, verify bằng gì, còn rủi ro gì — kèm `conversation_id` để bạn bảo "hỏi agy tiếp câu X".
