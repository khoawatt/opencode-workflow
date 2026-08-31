# Review Workflow (ChatGPT bridge)

How the `@chatgpt-review` bridge turns ChatGPT Web into a workflow-aware,
independent reviewer that advances the task instead of merely echoing "looks good".

---

## 1. What is sent

The implementing agent's **final result summary** — e.g.:

```text
Done.

What changed
- ...

Verification
- ...
```

**Never** send raw git diffs through the bridge. ChatGPT is instructed to inspect
GitHub state itself when it needs deeper verification (PR state, HEAD SHA, CI,
diff), so the bridge payload stays small.

## 2. Handoff envelope

The subagent wraps the summary in a small structured envelope:

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
AUTHORITY:
- ChatGPT: independent review; inspect GitHub; approve/request-changes; recommend next action.
- OpenCode: implementation, fixes, tests, commits, pushes, issue/PR updates.
- Human: merge/deploy authority only.
```

## 3. Review-response contract

ChatGPT returns:

```text
VERDICT: approve | approve-with-changes | request-changes | reject
NEXT_ACTION: <single explicit next workflow action>
ISSUES: <numbered actionable issues, or "none">
SUGGESTIONS: <optional>
```

Semantics:

- **approve** — no blocking work remains.
- **approve-with-changes** — only non-blocking cleanup; state whether re-review is needed.
- **request-changes** — OpenCode must fix, then re-review.
- **reject** — replan before continuing.

## 4. State machine

```text
IMPLEMENTING → IMPLEMENTATION_COMPLETE → CHATGPT_REVIEW
   → REQUEST_CHANGES → OPENCODE_FIXES → RE-REVIEW (loop)
   → APPROVED → HUMAN_ACTION_REQUIRED (awaiting human merge)
```

For PRs: `APPROVED + CI GREEN → awaiting human merge`. No separate
"merge-readiness" review state unless something changed.

## 5. Eliminating redundant review loops

Approval state is stored per repo+branch (`identity:branch` via `gh remote` → `owner/repo:branch`, fallback `basename:branch` with legacy migration) via:

```text
chatgpt-review approval get|set <verdict> <headSha> [pr]|clear
```

Validation (port from codex-workflow):
- `verdict` must be one of `approve|approve-with-changes|request-changes|reject` (`allowedVerdicts`)
- `headSha` must be full 40-char hex (`/^[0-9a-f]{40}$/i`)
- `pr` must be positive integer or `none` (stored as `pr` + `head_sha` snake + `headSha` camel for compat, plus `repo`/`branch`/`reviewer`/`reviewed_at`)
- Persistence is atomic (`mkdir 0o700` → `write 0o600` → `renameSync`) like codex

- If `approve` is recorded and the current HEAD SHA equals the stored `headSha` (either `headSha` or `head_sha`) and nothing materially changed → **do not re-review**; report "awaiting human merge".
- Re-review IS warranted when: head SHA changed, new commits pushed, base rebased, CI newly failed, fixes applied, scope changed.

`approve` does **not** mean OpenCode may merge. It means "ready for human merge". Approval is bound to exact `repo` (case-insensitive), `branch`, `pr`, and `head_sha` — see `templates/merge-approved-pr.sh` guards + TOCTOU double-read.

## 6. Auto-review behavior

When auto-review is enabled (`/autoreview on`):

1. Implementation task completes; agent writes its result summary.
2. Agent invokes `@chatgpt-review` with the summary verbatim.
3. Subagent wraps it in the envelope and sends via the bridge.
4. Verdict is consumed:
   - `approve` → advance to next permitted state and stop; report status.
   - `approve-with-changes` → apply non-blocking cleanup; don't re-review unless state changed.
   - `request-changes` → report issues, fix, rerun verification, push, re-review.
   - `reject` → stop and report that replanning is required.

Never treat `approve` as permission to merge.

## 7. Authority separation

- **ChatGPT may:** review, inspect GitHub, identify issues, approve/request-changes, determine next step, recommend next action.
- **OpenCode may:** edit, test, commit, push, create/update Issues/PRs, fix findings, continue approved work.
- **Human only:** merge, deploy, production/destructive actions.

## 8. Failure handling

- `loggedIn: false` → report; do not review.
- Bridge error → surface exact error; never claim false success/approval.
- Cloudflare may block headless; the bridge runs headful by default.

## 9. Concurrency

The bridge uses one Chrome profile and serializes every run via a lock file
(`~/.config/opencode/chatgpt-bridge/.lock`). Concurrent reviews from multiple
repos wait; stale locks (dead PID) auto-recover.

## 10. Conversation / project behavior (preserved)

- One ChatGPT thread per repo+branch (`identity:branch` via `gh remote`, legacy `basename:branch` migrated; stale rollover via `max_chars`/`max_turns`/`max_age_hours` `400000/40/48`).
- Persistence via atomic `0o600` writes + `execFileSync` (no shell) + `repoContext` like codex.
- Gemini bridge now uses `bin/session-auth.mjs` classifier (`loggedIn` vs `guestAvailable`, 5s settled + 3 stable checks via `advanceLoginStability`) — see `docs/GEMINI_WEB.md`.
- Optional ChatGPT Project per repo (`project_mode`, `ask --project`, `/chatgpt-project`) with direct `fetch` + 3-retry capture (in-flight → goto → reload) and sidebar auto-expand (`dbg3 vs dbg4`).
- `login --switch` / `--wait` / `--keep-open` for account switching (port from codex), `status` now shows `cookiesExist` + `guestAvailable`.
- `login`/`status`, `/chatgpt-new`, `/gemini-new`, `/chatgpt-project`, `opencode-work --status` remain, plus `bash tests/test.sh` verification.

See also `docs/CONFIGURATION.md` (projects.conf) and `docs/TROUBLESHOOTING.md` (lock, Cloudflare, guestAvailable, Project fetch, sidebar).
