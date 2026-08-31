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
# Optional second-opinion reviewer (Google Gemini web):
~/.config/opencode/gemini-bridge/bin/gemini-review login      # human signs in with Google account
~/.config/opencode/gemini-bridge/bin/gemini-review status     # must print "loggedIn": true
```

Then tell the human to restart opencode.

## What `install.sh` does

1. Copies opencode config into `~/.config/opencode/`:
   - `agent/chatgpt-review.md` — the `@chatgpt-review` subagent
   - `agent/gemini-review.md` — the `@gemini-review` subagent (second opinion)
   - `skills/chatgpt-review/` + `skills/gemini-review/` — the skills
   - `command/*.md` — `/autoreview`, `/chatgpt-new`, `/gemini-new`, `/chatgpt-project`
   - `plugin/chatgpt-autoreview.ts` — auto-review toggle plugin
   - bridge binaries + `package.json` + default configs
2. `npm install` (playwright) into `~/.config/opencode/chatgpt-bridge/` and
   `~/.config/opencode/gemini-bridge/`
3. Installs Playwright Chromium (shared by both bridges).
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

~/.config/opencode/gemini-bridge/
├── bin/gemini-review.mjs       # Gemini web bridge script
├── bin/gemini-review           # wrapper
├── package.json
├── bridge-config.json          # thresholds only (no project_mode)
└── profile/                    # created by `login` (Google session cookies — never commit)
```

## Verification checklist (run all)

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status
#   {"profileExists":true,"cookiesExist":true,"loggedIn":true}

cd <any repo> && ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review chats
#   prints current repo+branch key and chat state (no crash)

~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project list
#   prints JSON array of ChatGPT Projects (may be empty on a fresh account)

~/.config/opencode/gemini-bridge/bin/gemini-review status
#   {"profileExists":true,"cookiesExist":true,"loggedIn":true}   (if Gemini was set up)

cd <any repo> && ~/.config/opencode/gemini-bridge/bin/gemini-review chats
#   prints current repo+branch key and chat state (no crash)
```

If `status` shows `loggedIn: false`, run the matching `login` command and ask the
human to sign in (ChatGPT account, or Google account for the Gemini bridge) in
the browser window, then re-check.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Chromium not found` | `npm exec --prefix ~/.config/opencode/chatgpt-bridge playwright install chromium` |
| `libnspr4.so ... not found` | re-run `bash install.sh --deps` (installs system libs) |
| `loggedIn: false` after login | the login wait loop may have missed the cookie; run `.../chatgpt-review login` again and wait for "LOGIN OK" |
| `project ... 401` | Cloudflare/headless; `ask` runs headful by default; ensure a desktop session exists |

## Rules

- Never commit `profile/`, `chats.json`, `projects.json`, `autoreview.json`,
  `node_modules/`, `libs/`, or any file under
  `~/.config/opencode/{chatgpt,gemini}-bridge/profile/`.
- Never print session cookies or tokens.
- Keep the existing machine's local state (`chats.json`, `projects.json`,
  `profile/`) — `install.sh` only overwrites code/config, not runtime state.
- The bridges run **headful** by default (needed to pass Cloudflare / Google
  checks). On a headless server, use `xvfb-run` or a virtual display.
