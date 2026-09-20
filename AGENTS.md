# AGENTS.md — Setup runbook for ChatGPT Review Bridge

This repo installs a **ChatGPT Plus (web) review bridge** into opencode so any
agent can send diffs/plans/responses to ChatGPT for review and read the verdict
back — no copy-paste, no API quota.

If you were given this repo with instructions to "set it up", follow the steps
below exactly. Do not invent extra steps.

## TL;DR (the whole job)

```bash
bash install.sh
# Pick ONE login style per bridge — manual (handles 2FA/CAPTCHA) or --auto from .env (no typing):
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login   # human signs in to ChatGPT
# ...or:  fill ~/.config/opencode/chatgpt-bridge/.env (CHATGPT_EMAIL/CHATGPT_PASSWORD, chmod 600), then:
# ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login --auto
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # must print "loggedIn": true
# Optional second-opinion reviewer (Google Gemini web):
~/.config/opencode/gemini-bridge/bin/gemini-review login      # human signs in with Google account
# ...or:  fill ~/.config/opencode/gemini-bridge/.env (GEMINI_EMAIL/GEMINI_PASSWORD, chmod 600), then:
# ~/.config/opencode/gemini-bridge/bin/gemini-review login --auto
~/.config/opencode/gemini-bridge/bin/gemini-review status     # must print "loggedIn": true
```

Then tell the human to restart opencode.

## What `install.sh` does

1. Copies opencode config into `~/.config/opencode/`:
   - `agent/chatgpt-review.md` — the `@chatgpt-review` subagent
   - `agent/gemini-review.md` — the `@gemini-review` subagent (second opinion)
   - `agent/agy-worker.md` — delegated Antigravity implementation worker
   - `agent/codex-worker.md` — delegated Codex implementation worker
   - `skills/chatgpt-review/` + `skills/gemini-review/` — the skills
   - `command/*.md` — review/project commands plus `/agy` and `/codex`
   - `plugin/chatgpt-autoreview.ts` — auto-review toggle plugin
   - bridge binaries + `package.json` + default configs
2. `npm install` (playwright) into `~/.config/opencode/chatgpt-bridge/` and
   `~/.config/opencode/gemini-bridge/`
3. Installs Playwright Chromium (shared by both bridges).
4. Installs Chromium system libraries (sudo if available, else user-space `.deb`
   extraction into `~/.config/opencode/chatgpt-bridge/libs/`).

Delegated worker binaries are external prerequisites. `install.sh` installs only
OpenCode adapters for `/agy` and `/codex`; it does not install/authenticate
Antigravity CLI or Codex CLI. See `docs/AGY_USAGE.md` and `docs/CODEX_USAGE.md`.

## Expected state after setup

```
~/.config/opencode/chatgpt-bridge/
├── bin/chatgpt-review.mjs      # main bridge script
├── bin/chatgpt-review          # wrapper
├── bin/autoreview              # toggle script
├── package.json
├── bridge-config.json
├── profile/                    # created by `login` (contains session cookies — never commit)
├── chats.json                  # created at runtime (never commit)
├── projects.json               # created at runtime (never commit)
└── libs/                       # system libs (Linux, no-sudo fallback)

~/.config/opencode/gemini-bridge/
├── bin/gemini-review.mjs       # Gemini web bridge script
├── bin/gemini-review           # wrapper
├── package.json
├── bridge-config.json          # thresholds only (no project_mode)
└── profile/                    # created by `login` (Google session cookies — never commit)
```

## Verification checklist (run all)

```bash
bash -n bin/opencode-work install.sh install-project.sh bin/autoreview bin/chatgpt-review bin/gemini-review templates/merge-approved-pr.sh
node --check bin/chatgpt-review.mjs bin/gemini-review.mjs bin/session-auth.mjs bin/bridge-env.mjs
bash tests/test.sh

~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status
#   {"profileExists":true,"cookiesExist":true,"loggedIn":true}

cd <any repo> && ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review chats
#   prints current repo+branch key (identity:branch) and chat state (no crash)

~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project list
#   prints JSON array of ChatGPT Projects (may be empty on a fresh account)

~/.config/opencode/gemini-bridge/bin/gemini-review status
#   {"profileExists":true,"cookiesExist":true,"loggedIn":true,"guestAvailable":false}   (if Gemini was set up)

cd <any repo> && ~/.config/opencode/gemini-bridge/bin/gemini-review chats
#   prints current repo+branch key and chat state (no crash)

opencode-work --status    # shows projects from ~/.config/opencode/projects.conf or fallback 2 pane
```

If `status` shows `loggedIn: false`, either run the matching `login --auto` (when its
`.env` holds `CHATGPT_EMAIL/CHATGPT_PASSWORD` or `GEMINI_EMAIL/GEMINI_PASSWORD`,
`chmod 600`, `status` reports `envConfigured:true`) or run the manual `login` and
ask the human to sign in in the browser window, then re-check. Manual login is
still required once when 2FA/CAPTCHA/"browser may not be secure" appears — the
saved profile is reused afterwards, and `ask` auto-retries `.env` login on expiry
(unless `--no-auto-login`). To switch ChatGPT account: `chatgpt-review login --switch` (keeps browser open, waits for token change; use `--wait=SECONDS` to keep open after new login). Gemini now distinguishes `loggedIn` vs `guestAvailable` via `session-auth.mjs` classifier (needs 3 stable checks).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Chromium not found` | `npm exec --prefix ~/.config/opencode/chatgpt-bridge playwright install chromium` |
| `libnspr4.so ... not found` | re-run `bash install.sh --deps` (installs system libs via sudo or user-space `.deb` into `libs/`) |
| `loggedIn: false` after login (ChatGPT) | run `.../chatgpt-review login --switch` if already logged in with other account; check `~/.config/opencode/chatgpt-bridge/.lock` stale |
| `loggedIn: false` + `guestAvailable:true` (Gemini) | Gemini shows composer but no account identity — sign in fully, wait for 3 stable checks (5s settled) |
| `project ... 401` | Cloudflare/headless; `ask` runs headful by default; ensure a desktop session exists |
| `approval ... head_sha` mismatch | `chatgpt-review approval get` now validates 40-char SHA + repo/branch; `approval clear` then re-review exact HEAD |

See also `docs/TROUBLESHOOTING.md` for full table and `docs/CONFIGURATION.md` for `projects.conf` + `opencode-work --status`.

## Rules

- Never commit `profile/`, `chats.json`, `projects.json`, `autoreview.json`, `.env`,
  `node_modules/`, `libs/`, or any file under
  `~/.config/opencode/{chatgpt,gemini}-bridge/profile/`.
- Never print session cookies or tokens.
- Keep the existing machine's local state (`chats.json`, `projects.json`,
  `profile/`) — `install.sh` only overwrites code/config, not runtime state.
- The bridges run **headful** by default (needed to pass Cloudflare / Google
  checks). On a headless server, use `xvfb-run` or a virtual display.
