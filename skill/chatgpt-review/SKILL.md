---
name: chatgpt-review
description: Use when the user wants a response, diff, plan, or code reviewed by ChatGPT Plus (web) without copy-pasting. Also triggered by "review with chatgpt", "gửi cho chatgpt review", "review ngoài", or when a task finishes and auto-review is enabled. Sends content to ChatGPT Plus via a browser bridge and returns the review.
---

# chatgpt-review

Send a prompt to ChatGPT Plus (web) through a Playwright bridge and read the reply back into the session. The user does **not** need to copy-paste.

## Requirements

- First-time setup must be done once: run `chatgpt-review login` in a terminal (opens a visible browser to sign in to ChatGPT). Verify with `chatgpt-review status` (must show `"loggedIn": true`).
- The bridge script is at `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review`.

## Workflow

1. Check the bridge is ready:
   ```
   ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status
   ```
   If `loggedIn` is `false`, tell the user to run `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login` in a terminal first.

2. Build the review prompt. Write it to a temp file, e.g. `/tmp/opencode/chatgpt-review-prompt.md`. A good review prompt includes:
   - What the task was (1-2 sentences).
   - The actual code/diff/output to review (git diff, relevant files, the plan, or the response text).
   - What to focus on (bugs, security, correctness, style, suggested improvements).
   - Ask for a concise verdict in a fixed format, e.g.:
     ```
     VERDICT: approve / approve-with-changes / reject
     ISSUES: bullet list (with file:line when relevant)
     SUGGESTIONS: prioritized short list
     ```
3. Send it:
   ```
   ~/.config/opencode/chatgpt-bridge/bin/chatgpt-review ask --file=/tmp/opencode/chatgpt-review-prompt.md
   ```
   The script prints ChatGPT's reply to stdout.

4. Read the reply. If it failed (e.g. not signed in, UI changed), tell the user what to fix.

## Conversation reuse (per repo + branch)

The bridge keeps **one ChatGPT thread per repo+branch** (`chats.json`) so reviews
for the same branch build on prior context instead of spawning new chats.

- On `ask`, the bridge reuses the saved conversation unless it is stale, or it
  opens a fresh one and records the new chat id.
- Fallback: if a saved conversation id fails to open, it starts a new one
  automatically (no user action needed).
- New conversation triggers (see `~/.config/opencode/chatgpt-bridge/bridge-config.json`):
  - `max_chars` (default 400000) — accumulated prompt+reply characters
  - `max_turns` (default 40) — number of exchanges
  - `max_age_hours` (default 48) — since last use
- Force a fresh thread: `.../chatgpt-review ask --new` or `/chatgpt-new` command.
- Inspect state: `.../chatgpt-review chats` and `.../chatgpt-review reset`.

## ChatGPT Projects support

Instead of loose chats, reviews can live inside a **ChatGPT Project** (one per
repo) so they are organized, share project instructions, and keep project memory.

- Enabled per repo via `project_mode: { "<repoName>": true }` in `bridge-config.json`,
  or globally with `"mode": "project"`, or per-call with `ask --project`.
- On `ask`, the bridge auto-uses the repo's project; if none exists it **creates
  one named after the repo** (or uses `--project=<name>` to target an existing one).
- Chat reuse still applies inside the project (same repo+branch thread, same
  chars/turns/age thresholds).
- Manage projects: `.../chatgpt-review project list|create|attach|detach|resolve`,
  or the `/chatgpt-project` command.
- `ask --no-project` forces plain chat for that call.
- Fallback: if a saved project or chat fails to open, the bridge falls back to a
  plain conversation automatically.

## Notes

- Use `git diff` for uncommitted changes; `git diff <base>..HEAD` for committed work. Ask the user which scope they want if it is ambiguous.
- ChatGPT's web UI changes occasionally; if selectors break, the script throws a descriptive error. Do not silently claim a review succeeded when the bridge errored.
- If the user wants a quick check, keep the prompt tight: send the diff plus 3 focus questions, not a wall of context.
