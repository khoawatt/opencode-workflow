# Auto-login từ file môi trường (.env)

Mặc định bridge mở browser và **đợi bạn tự gõ** email/password (xử lý được 2FA/CAPTCHA).
Nếu muốn **không thao tác tay**, nạp thẳng tài khoản vào file `.env` rồi dùng `login --auto`
— Playwright sẽ tự điền email/password và submit.

## 1. Cấu hình

```bash
# ChatGPT
nano ~/.config/opencode/chatgpt-bridge/.env
# CHATGPT_EMAIL=you@example.com
# CHATGPT_PASSWORD=your-password
chmod 600 ~/.config/opencode/chatgpt-bridge/.env
# Lưu ý: nếu tài khoản ChatGPT đăng nhập bằng "Continue with Google" thì
# CHATGPT_PASSWORD phải là mật khẩu tài khoản GOOGLE (bridge tự đi qua
# Google OAuth: identifier → password → consent).

# Gemini (Google)
nano ~/.config/opencode/gemini-bridge/.env
# GEMINI_EMAIL=you@gmail.com
# GEMINI_PASSWORD=your-password
chmod 600 ~/.config/opencode/gemini-bridge/.env
```

Quy tắc:

- `install.sh` tự tạo 2 file `.env` mẫu (không ghi đè file đã có) và `chmod 600`.
- Shell env thắng file: `CHATGPT_EMAIL=... CHATGPT_PASSWORD=... chatgpt-review login --auto`.
- Alias chấp nhận: `OPENAI_EMAIL/OPENAI_PASSWORD` (ChatGPT), `GOOGLE_EMAIL/GOOGLE_PASSWORD` (Gemini).
- Đường dẫn custom: `CHATGPT_ENV_FILE=/path/to/.env`, `GEMINI_ENV_FILE=/path/to/.env`.
- Dir custom (test/portable): `CHATGPT_BRIDGE_DIR=...`, `GEMINI_BRIDGE_DIR=...`.
- **Không bao giờ** commit `.env` (đã có trong `.gitignore`), không in password ra log — log chỉ hiện email đã mask (`ab***@example.com`).
- Nếu file bị `644`, bridge vẫn chạy nhưng in `WARN: insecure permissions ... — run: chmod 600`.

Mẫu đầy đủ: `config/chatgpt-bridge.env.example`, `config/gemini-bridge.env.example`.

## 2. Đăng nhập 1 lần từ .env

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login --auto
# LOGIN OK — session saved (auto-login from .env).

~/.config/opencode/gemini-bridge/bin/gemini-review login --auto
# LOGIN OK — session saved (auto-login from .env).
```

Tùy chọn: `--timeout=SECONDS` (mặc định 120), `--headless`/`--headful`,
alias `--from-env` / `--env` tương đương `--auto`.

## 3. Chạy tự động về sau (không cần login tay nữa)

`ask` tự kiểm tra session; nếu hết hạn **và** `.env` đã cấu hình, nó tự login lại
trong cùng phiên browser rồi mới gửi prompt:

```bash
echo "review: ..." | ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review ask
echo "cross-check: ..." | ~/.config/opencode/gemini-bridge/bin/gemini-review ask
```

Muốn tắt hành vi này (chỉ dùng session có sẵn): thêm `--no-auto-login`.

`status` báo thêm 2 trường (không lộ secret):

```json
{"profileExists":true,"cookiesExist":true,"loggedIn":true,"envConfigured":true,"envFileExists":true}
```

## 4. Giới hạn (trung thực)

- Tài khoản bật **2FA/OTP/passkey**, hoặc gặp **CAPTCHA / Cloudflare challenge /
  "browser may not be secure" / "unusual traffic"**, auto-login **không tự qua được**.
  Bridge sẽ báo rõ lý do và hướng fallback: chạy `login` thủ công **1 lần** để lưu
  session vào `profile/` — các lần sau tái dùng session, không cần gõ lại.
- Google đặc biệt gắt với trình duyệt tự động; nếu `--auto` thất bại với
  "browser may not be secure", bắt buộc login tay 1 lần.
- Đổi mật khẩu → cập nhật lại `.env`, chạy `login --auto` lại.
- Đổi account ChatGPT khi đã login: vẫn dùng `login --switch` thủ công.

## 5. Verify

```bash
node --check bin/bridge-env.mjs bin/chatgpt-review.mjs bin/gemini-review.mjs
bash tests/test.sh
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status  # envConfigured:true, loggedIn:true
~/.config/opencode/gemini-bridge/bin/gemini-review status    # envConfigured:true, loggedIn:true
```
