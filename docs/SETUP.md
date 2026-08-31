# Setup Guide (new machine / team onboarding)

One-time setup to get the full OpenCode ↔ ChatGPT workflow running, including the
`opencode-work` tmux launcher that runs two (or more) repos side by side.

---

## 1. Install the workflow globally

```bash
git clone https://github.com/Akbi47/opencode-workflow.git
cd opencode-workflow
bash install.sh
```

`install.sh` copies agent/skill/command/plugin into `~/.config/opencode/`, installs
`npm` deps + Playwright Chromium (shared by the ChatGPT and Gemini bridges),
installs Chromium system libraries (sudo if available, else user-space `.deb`
extraction into `libs/`), and sets up `~/.config/opencode/projects.conf` for the
`opencode-work` launcher (see `docs/CONFIGURATION.md`).

Then the only manual steps:

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login    # sign in to ChatGPT (once)
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # → "loggedIn": true
# To switch account: chatgpt-review login --switch  (or --wait=30)
~/.config/opencode/gemini-bridge/bin/gemini-review login      # optional: Google account for Gemini
~/.config/opencode/gemini-bridge/bin/gemini-review status     # → "loggedIn": true, guestAvailable:false
```

If `gemini-review status` shows `guestAvailable:true` (composer visible but no identity), sign in fully and wait for 3 stable checks (5s settled). See `docs/GEMINI_WEB.md`.

Restart opencode to load the new agent/skill/commands.

## 2. Install per repository

```bash
bash install-project.sh /path/to/your/repo
```

This copies the canonical policy (`opencode.jsonc`), the collaboration section
(`AGENTS.collaboration.md`), and the `.opencode/` resources (agents, commands,
scripts, skills) into the target repo. It **merges** — it never overwrites an
existing file; it copies only files that don't already exist and reports anything
it skipped.

## 3. The `opencode-work` tmux launcher

`bin/opencode-work` opens a tmux session `opencode-work` with one pane per
project in `~/.config/opencode/projects.conf` (fallback to 2 panes `Feaon` + `qvak` if config missing), each running OpenCode in its own repository, passing the project path
explicitly so each pane is bound to the correct workspace.

Config detail: see `docs/CONFIGURATION.md` — `name|git_url|checkout_path`, 2 projects → `even-horizontal` 50-50, else `tiled`.

### Install

```bash
mkdir -p ~/.local/bin
cp bin/opencode-work ~/.local/bin/opencode-work
chmod +x ~/.local/bin/opencode-work
# ensure ~/.local/bin is on PATH
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc ;; esac
```

### Usage

```bash
opencode-work            # create/attach the N-pane session (reads projects.conf)
opencode-work --status   # show configured projects + session state (running/stopped)
opencode-work --reset    # rebuild the session (e.g. after editing projects.conf)
opencode-work --help     # show help
# Config/session overrides:
OPENCODE_WORK_CONFIG=/path/to/team.conf OPENCODE_WORK_SESSION=team-work opencode-work
```

Detach with `Ctrl+b d` (keeps both OpenCode processes running); re-run
`opencode-work` to re-attach. Switch panes with `Ctrl+b ←/→`, zoom with `Ctrl+b z`.

### `--auto` mode

The launcher defaults to **`--auto`** (`OPENCODE_WORK_AUTO=1`), which auto-approves
`ask`-tier permissions for this trusted local workspace.

| Want | Command |
|---|---|
| Auto-approve `ask` (default) | `opencode-work` |
| Ask before mutating ops | `OPENCODE_WORK_AUTO=0 opencode-work --reset` |

`OPENCODE_WORK_AUTO` only affects new OpenCode processes — use `--reset` to apply
a mode change to an existing session.

> Note the tension: `--auto` auto-approves **all** `ask`-tier ops (including
> destructive ops and `gh pr merge` raw). If you want a human gate on those, run
> with `OPENCODE_WORK_AUTO=0`.

## 4. Verify

```bash
bash -n bin/opencode-work install.sh install-project.sh bin/autoreview bin/chatgpt-review bin/gemini-review templates/merge-approved-pr.sh
node --check bin/chatgpt-review.mjs bin/gemini-review.mjs bin/session-auth.mjs
bash tests/test.sh

~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # loggedIn: true
cd <repo> && ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review chats  # no crash (identity:branch)
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project list        # projects (may be empty)
~/.config/opencode/gemini-bridge/bin/gemini-review status     # loggedIn: true, guestAvailable:false (if set up)
cd <repo> && ~/.config/opencode/gemini-bridge/bin/gemini-review chats    # no crash
opencode-work --status                                        # shows N projects + State
tmux ls                                                        # opencode-work session
tmux list-panes -t opencode-work -F '#{pane_id} #{pane_current_path} #{pane_current_command}'
```

Expected: N panes (2 → `even-horizontal`, else `tiled`), one per non-comment line in `~/.config/opencode/projects.conf` (fallback 2).

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `Chromium not found` | `npm exec --prefix ~/.config/opencode/chatgpt-bridge playwright install chromium` |
| `libnspr4.so ... not found` | re-run `bash install.sh --deps` |
| `loggedIn: false` (ChatGPT) | run `.../chatgpt-review login` and wait for "LOGIN OK" |
| `loggedIn: false` (Gemini) | run `~/.config/opencode/gemini-bridge/bin/gemini-review login`, sign in with Google, complete any consent screen |
| Gemini asks "unusual traffic" | solve it manually in the login window; cannot be automated |
| `sessions should be nested with care` | the script handles nested tmux via `switch-client`; check `command -v opencode-work` |
| session has wrong/one pane | `opencode-work --reset` |
| OpenCode asks `external_directory` | ensure each pane was launched with the explicit repo path (the script does this) |
| last resort | `tmux kill-server` (closes ALL tmux sessions) then `opencode-work` |
