# AGENTS.md — Setup runbook for ChatGPT Review Bridge

This repo installs a **ChatGPT Plus (web) review bridge** into opencode so any
agent can send diffs/plans/responses to ChatGPT for review and read the verdict
back — no copy-paste, no API quota.

If you were given this repo with instructions to "set it up", follow the steps
below exactly. Do not invent extra steps.

## TL;DR (the whole job)

```bash
bash install.sh
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login   # human signs in to ChatGPT
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # must print "loggedIn": true
```

Then tell the human to restart opencode.

## What `install.sh` does

1. Copies opencode config into `~/.config/opencode/`:
   - `agent/chatgpt-review.md` — the `@chatgpt-review` subagent
   - `skills/chatgpt-review/` — the skill
   - `command/*.md` — `/autoreview`, `/chatgpt-new`, `/chatgpt-project`
   - `plugin/chatgpt-autoreview.ts` — auto-review toggle plugin
   - bridge binaries + `package.json` + default `bridge-config.json`
2. `npm install` (playwright) into `~/.config/opencode/chatgpt-bridge/`
3. Installs Playwright Chromium.
4. Installs Chromium system libraries (sudo if available, else user-space `.deb`
   extraction into `~/.config/opencode/chatgpt-bridge/libs/`).

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
```

## Verification checklist (run all)

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status
#   {"profileExists":true,"cookiesExist":true,"loggedIn":true}

cd <any repo> && ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review chats
#   prints current repo+branch key and chat state (no crash)

~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project list
#   prints JSON array of ChatGPT Projects (may be empty on a fresh account)
```

If `status` shows `loggedIn: false`, run `.../chatgpt-review login` and ask the
human to sign in to ChatGPT in the browser window, then re-check.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Chromium not found` | `npm exec --prefix ~/.config/opencode/chatgpt-bridge playwright install chromium` |
| `libnspr4.so ... not found` | re-run `bash install.sh --deps` (installs system libs) |
| `loggedIn: false` after login | the login wait loop may have missed the cookie; run `.../chatgpt-review login` again and wait for "LOGIN OK" |
| `project ... 401` | Cloudflare/headless; `ask` runs headful by default; ensure a desktop session exists |

## Rules

- Never commit `profile/`, `chats.json`, `projects.json`, `autoreview.json`,
  `node_modules/`, `libs/`, or any file under `~/.config/opencode/chatgpt-bridge/profile/`.
- Never print session cookies or tokens.
- Keep the existing machine's local state (`chats.json`, `projects.json`,
  `profile/`) — `install.sh` only overwrites code/config, not runtime state.
- The bridge runs **headful** by default (needed to pass Cloudflare). On a
  headless server, use `xvfb-run` or a virtual display.
