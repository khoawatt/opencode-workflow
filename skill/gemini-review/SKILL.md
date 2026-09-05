---
name: gemini-review
description: Use when a completed task's final result text should be independently cross-checked by Google Gemini (web) without copy-pasting — a second opinion besides ChatGPT. The bridge wraps the result in structured workflow context and returns a machine-actionable verdict. Also triggered by "review with gemini", "gửi cho gemini review", "hỏi gemini".
---

# gemini-review

Send a completed task's **final result summary** to Google Gemini
(gemini.google.com/app) through a Playwright bridge, wrapped in a small
structured workflow envelope, and read back a machine-actionable verdict.
The user does **not** copy-paste anything.

## Role in the workflow

`@gemini-review` is a **second-opinion / cross-check reviewer**. The
authoritative approval loop stays with `@chatgpt-review` (its `approval set`
state feeds `merge-approved-pr.sh`). Gemini's verdict is advisory: report it,
compare it with ChatGPT's when both exist, but never record it as workflow
approval state.

## Handoff envelope

```text
MODE: implementation-review | bugfix-review | followup-review | pre-pr-review | pr-review | planning-review | continuation-review
GOAL: <overall goal>
CURRENT_STAGE: IMPLEMENTING | IMPLEMENTATION_COMPLETE | REVIEW | FIXES | APPROVED
TASK_SUMMARY: <one line>
RESULT_TEXT: <verbatim summary>
REQUESTED_DECISION: <what Gemini decides>
NEXT_ACTION_IF_APPROVED: ...
NEXT_ACTION_IF_CHANGES_REQUESTED: ...
REPO / BRANCH / HEAD_SHA
AUTHORITY: Gemini=second-opinion review; OpenCode=implement; Human=merge/deploy
```

## Review-response contract

```text
VERDICT: approve | approve-with-changes | request-changes | reject
NEXT_ACTION: <single explicit next action>
ISSUES: <numbered issues, or "none">
SUGGESTIONS: <optional>
```

## Requirements

- One-time setup, pick one: `~/.config/opencode/gemini-bridge/bin/gemini-review login`
  (opens a browser; sign in with your Google account — handles 2FA/consent),
  **or** fill `~/.config/opencode/gemini-bridge/.env` (`GEMINI_EMAIL`/`GEMINI_PASSWORD`,
  `chmod 600`) then `login --auto` (no typing; `ask` auto-retries on expiry).
  Verify with `status` → `"loggedIn": true`.
- Bridge lives at `~/.config/opencode/gemini-bridge/bin/gemini-review`.
- Shares the Playwright Chromium install with the ChatGPT bridge.

## Subcommands

```text
gemini-review login|ask|status|chats|reset
```

- `ask` — send a prompt (reads stdin or `--file=`); reuse per repo+branch.
  Options: `--new`, `--timeout=SECONDS`, `--headless`, `--headful`.
- `chats` / `reset` — inspect/drop the per repo+branch conversation mapping.

## Conversation reuse

One Gemini thread per repo+branch (`~/.config/opencode/gemini-bridge/chats.json`);
a new thread starts when stale (`max_chars` / `max_turns` / `max_age_hours`) or a
saved id fails to open. Force fresh with `ask --new`.

## Failure handling

- `loggedIn: false` → run `login`; do not review.
- Redirected to `accounts.google.com` / consent screen → run `login` once more.
- Google "unusual traffic" check cannot be automated — complete it manually in
  the login window if shown.
- Bridge error → surface the exact error; never claim a false success or approval.

## Notes

- Only send result summary text, never raw diffs.
- Keep the envelope tight.
- Gemini UI changes occasionally; if selectors break, the bridge throws a
  descriptive error.
