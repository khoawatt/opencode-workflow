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
`npm` deps + Playwright Chromium (shared by the ChatGPT and Gemini bridges), and
installs Chromium system libraries (sudo if available, else user-space `.deb`
extraction into `libs/`).

Then the only manual steps:

```bash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login    # sign in to ChatGPT (once)
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # → "loggedIn": true
~/.config/opencode/gemini-bridge/bin/gemini-review login      # optional: Google account for Gemini
~/.config/opencode/gemini-bridge/bin/gemini-review status     # → "loggedIn": true
```

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

`bin/opencode-work` opens a tmux session `opencode-work` with two side-by-side
panes, each running OpenCode in its own repository, passing the project path
explicitly so each pane is bound to the correct workspace.

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
opencode-work            # create/attach the 2-pane session
opencode-work --reset    # rebuild the session (e.g. after editing the script)
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
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status   # loggedIn: true
cd <repo> && ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review chats  # no crash
~/.config/opencode/chatgpt-bridge/bin/chatgpt-review project list        # projects (may be empty)
~/.config/opencode/gemini-bridge/bin/gemini-review status     # loggedIn: true (if set up)
cd <repo> && ~/.config/opencode/gemini-bridge/bin/gemini-review chats    # no crash
tmux ls                                                        # opencode-work session
tmux list-panes -t opencode-work -F '#{pane_id} #{pane_current_path}'
```

Expected: exactly two panes, one per repository.

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
