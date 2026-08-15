---
name: chatgpt-review
description: Use when a completed task's final result text should be independently reviewed by ChatGPT Plus (web) without copy-pasting. The bridge wraps the result in structured workflow context (mode, goal, stage, requested decision, next-action semantics, authority) and returns a machine-actionable verdict that advances the workflow. Also triggered by "review with chatgpt", "gửi cho chatgpt review", "review ngoài", or auto-review after a task completes.
---

# chatgpt-review

Send a completed task's **final result summary** to ChatGPT Plus (web) through a
Playwright bridge, wrapped in a small structured workflow envelope, and read back
a machine-actionable verdict. The user does **not** copy-paste anything.

## What gets reviewed

The implementing agent's own result text — e.g. "Done / What changed / Verification".
**Never** send raw git diffs through the bridge. ChatGPT is instructed to inspect
GitHub state itself when it needs deeper verification.

## Handoff envelope

The review prompt sent to ChatGPT is a small structured envelope, not a conversation dump:

```text
MODE: implementation-review | bugfix-review | followup-review | pre-pr-review | pr-review | planning-review | continuation-review
GOAL: <overall goal>
CURRENT_STAGE: IMPLEMENTING | IMPLEMENTATION_COMPLETE | CHATGPT_REVIEW | OPENCODE_FIXES | APPROVED
TASK_SUMMARY: <one line>
RESULT_TEXT: <verbatim summary>
REQUESTED_DECISION: <what ChatGPT decides>
NEXT_ACTION_IF_APPROVED: ...
NEXT_ACTION_IF_CHANGES_REQUESTED: ...
REPO / BRANCH / HEAD_SHA / PR / BASE
AUTHORITY: ChatGPT=review; OpenCode=implement; Human=merge/deploy
```

## Review-response contract (ChatGPT must return)

```text
VERDICT: approve | approve-with-changes | request-changes | reject
NEXT_ACTION: <single explicit next action>
ISSUES: <numbered issues, or "none">
SUGGESTIONS: <optional>
```

Semantics:
- **approve** — no blocking work remains.
- **approve-with-changes** — only non-blocking cleanup; state whether re-review is needed.
- **request-changes** — OpenCode must fix, then re-review.
- **reject** — replan before continuing.

## State machine

```text
IMPLEMENTING → IMPLEMENTATION_COMPLETE → CHATGPT_REVIEW
   → REQUEST_CHANGES → OPENCODE_FIXES → RE-REVIEW (loop)
   → APPROVED → HUMAN_ACTION_REQUIRED (awaiting human merge)
```

## Eliminating redundant review loops

Approval state is stored per repo+branch in `chats.json` (via
`chatgpt-review approval set|get|clear`). Before reviewing, check:

- If `approval.get` returns `approve` and current HEAD SHA equals the stored
  `headSha` and nothing materially changed → **do not re-review**; report
  "awaiting human merge".
- If HEAD SHA changed, base rebased, CI failed, or fixes were applied → re-review.

"approve" does **not** mean OpenCode may merge. It means "ready for human merge".

## Requirements

- One-time setup: `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login`
  (opens a browser to sign in), verify with `status` → `"loggedIn": true`.
- Bridge lives at `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review`.

## Concurrency

The bridge uses a **single Chrome profile** and serializes every run through a
lock file (`~/.config/opencode/chatgpt-bridge/.lock`). If two repos trigger a
review simultaneously, one waits for the other; it does not crash. If a run is
stuck, a stale lock (dead PID) is auto-cleared.

## Subcommands

```text
chatgpt-review login|ask|status|chats|reset|project <...>
chatgpt-review approval get|set <verdict> <sha> [pr]|clear
```

- `ask` — send a prompt (reads stdin or `--file=`); reuse per repo+branch.
- `approval` — read/write the workflow approval state used to avoid loops.
- `project` — manage ChatGPT Projects (list/create/attach/detach/resolve).

## Conversation reuse (per repo + branch)

One ChatGPT thread per repo+branch (`chats.json`); a new thread is started when
stale (`max_chars` / `max_turns` / `max_age_hours` in `bridge-config.json`) or a
saved id fails to open. Force a fresh thread with `ask --new` or `/chatgpt-new`.
Inspect with `chats`; drop mapping with `reset`.

## ChatGPT Projects

Optionally organize reviews into one ChatGPT Project per repo:
- Enable per repo via `project_mode` or globally `"mode": "project"`, or per-call `ask --project`.
- The bridge reuses/creates the project and keeps the thread inside it.
- Manage with `project list|create|attach|detach|resolve` or `/chatgpt-project`.

## Failure handling

- `loggedIn: false` → report, do not review.
- Bridge error → surface the exact error; never claim a false success or approval.
- Cloudflare may block headless; `ask` runs headful by default (needs a display; use `xvfb-run` on headless servers).

## Notes

- Only send result summary text, never raw diffs.
- Keep the envelope tight (small, structured), not a wall of context.
- ChatGPT UI changes occasionally; if selectors break, the bridge throws a descriptive error.
