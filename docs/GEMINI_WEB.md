# Gemini Web bridge (second-opinion reviewer)

`gemini-review` dùng Playwright và Chromium profile riêng (`~/.config/opencode/gemini-bridge/`) để gửi prompt đã sanitize lên `gemini.google.com/app` rồi lấy text response. Đây là **second-opinion reviewer** (không ghi approval state chính thức) — merge gate vẫn chỉ nhận approval từ ChatGPT (`templates/merge-approved-pr.sh`).

Kế thừa classifier xịn từ `codex-workflow/gemini-web/session-auth.mjs` (port sang `bin/session-auth.mjs`):

- `classifyGeminiSession({onGeminiOrigin, explicitSignedOut, identityEvidence, canAsk, cookieNames})` → `{loggedIn, canAsk, guestAvailable, googleSessionCookie}` — cookie chỉ là corroborating, không quyết định
- `advanceLoginStability(prev, state, sameDocument, documentSettled)` đòi `sameDocument && documentSettled>=5000ms && loggedIn&&canAsk` 3 lần liên tiếp mới báo `LOGIN OK`

## Cài và dùng

```bash
~/.config/opencode/gemini-bridge/bin/gemini-review login      # đăng nhập Google (1 lần)
~/.config/opencode/gemini-bridge/bin/gemini-review status     # → {"profileExists":true,"loggedIn":true,"guestAvailable":false}
printf '%s\n' 'cross-check kết quả task vừa review bằng ChatGPT: <summary>' | \
  ~/.config/opencode/gemini-bridge/bin/gemini-review ask
~/.config/opencode/gemini-bridge/bin/gemini-review reset      # xóa mapping repo+branch
~/.config/opencode/gemini-bridge/bin/gemini-review chats      # xem mapping
```

Hoặc qua opencode:

```
@gemini-review cross-check kết quả task vừa review bằng ChatGPT: <summary>
/gemini-new   # tương đương gemini-review reset
```

`status` phân biệt `loggedIn` vs `guestAvailable`:

```json
{"profileExists":true,"cookiesExist":true,"loggedIn":false,"guestAvailable":true}
```

— Gemini có thể cho guest thấy composer và gửi câu hỏi, nhưng khi chưa có account identity thật (`a[href*="SignOutOptions"]`/`myaccount.google.com`/`Google Account:`) thì không tính là loggedIn. Google Auth form, `accounts.google.com`, composer hoặc Google cookie đơn lẻ không được xem là bằng chứng.

`login` chỉ xác nhận sau khi browser quay về đúng `gemini.google.com` và liên tục hiển thị cả account identity lẫn composer ổn định 5s, 3 lần liên tiếp. Sau mỗi navigation, phải ổn định tối thiểu 5 giây trước khi bắt đầu xác nhận. Đóng window giữa chừng sẽ báo `browser window was closed` thay vì treo 20 phút.

`ask` hỗ trợ `--new`, `--headless`, `--timeout=SECONDS`, `--file=PATH`. Mỗi repo+branch reuse một Gemini conversation (`identity:branch` qua `gh remote`, fallback `basename:branch`, legacy migration) cho đến khi vượt ngưỡng trong `~/.config/opencode/gemini-bridge/bridge-config.json` (`max_chars`/`max_turns`/`max_age_hours`). Lock `~/.config/opencode/gemini-bridge/.lock` với PID check + `Atomics.wait` bảo vệ profile.

Runtime state nằm dưới `~/.config/opencode/gemini-bridge/` (`profile/`, `chats.json` `0600`, `bridge-config.json`, `libs/`). Không copy hoặc commit browser profile. Không gửi credential, cookie, `.env`, key, raw diff, transcript.

Gemini Web UI không có contract ổn định. Nếu prompt/send/response selector không xác minh được, bridge fail rõ ràng và không click phần tử ngẫu nhiên. `ask` dùng `started && !stopVisible && text===prevText` double-stable để đợi streaming xong.

## Verification và rollback

```bash
bash -n bin/gemini-review.mjs bin/session-auth.mjs
node --check bin/gemini-review.mjs bin/session-auth.mjs
~/.config/opencode/gemini-bridge/bin/gemini-review status   # → loggedIn:true
~/.config/opencode/gemini-bridge/bin/gemini-review chats
```

Rollback: thoát mọi `gemini-review`, `rm ~/.local/bin/gemini-review` (symlink), nếu muốn xóa login state backup rồi xóa riêng `~/.config/opencode/gemini-bridge/`. Không xóa toàn bộ `~/.config/opencode/`.
