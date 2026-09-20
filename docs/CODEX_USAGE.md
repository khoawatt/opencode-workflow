# Codex CLI delegated worker

`/codex` and `@codex-worker` let OpenCode delegate a bounded task to the
OpenAI Codex CLI without moving workflow ownership away from OpenCode.

## Architecture

```text
OpenCode Primary
   |
   +--> /agy / @agy-worker       Antigravity implementation worker
   +--> /codex / @codex-worker   Codex implementation worker
   |
   +--> @chatgpt-review          independent review dispatcher
   +--> @vision                  visual specialist
```

The invariant is:

```text
External worker may modify the working tree.
External worker does NOT own workflow state.
```

Codex may edit/test inside the requested scope. OpenCode verifies the diff,
decides whether the task is complete, and decides whether another review/fix
cycle is needed. Codex does not approve or merge.

## Prerequisites

Install and authenticate Codex CLI separately from this repo:

```bash
codex --version
codex login status
```

This workflow expects a recent Codex CLI with:

- `codex exec`
- `--json`
- `--sandbox read-only|workspace-write`
- `codex exec resume <thread-id>`

Official references:

- https://developers.openai.com/codex/cli
- https://developers.openai.com/docs/non-interactive-mode

`install.sh` installs the OpenCode command/agent adapters, but intentionally
does not install Codex CLI or manage its account credentials.

## Usage

### One-shot command

```text
/codex implement refresh-token rotation in src/auth only; run the auth tests
```

The command runs as an OpenCode subtask, so the main context stays clean.

### Explicit subagent

```text
@codex-worker inspect the failing checkout tests, fix only checkout-related files,
run the focused tests, and leave the working tree uncommitted
```

Use the subagent form when the primary agent is explicitly orchestrating several
workers.

## Sandbox policy

Use the least permission needed:

```bash
# analysis/review only
codex exec --json --sandbox read-only -c 'approvals_reviewer="user"' -

# implementation
codex exec --json --sandbox workspace-write -c 'approvals_reviewer="user"' -
```

Do not use `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`,
`--yolo`, `--approve-for-me`, `--not-so-yolo`, `danger-full-access`,
`--add-dir`, or `--worktree` in this adapter. The `@codex-worker` bash
permission policy allows only `codex exec` and explicitly denies these
escalation/scope-expansion paths.

The explicit `approvals_reviewer="user"` runtime override is intentional
defense in depth. Current Codex CLI versions can allow an
`approvals_reviewer=auto_review` value from user/project config to escalate an
otherwise explicit sandbox. The runtime override keeps the adapter's selected
sandbox authoritative.

## Session continuity

`--json` emits a `thread.started` event containing the exact `thread_id`.
Keep that id and continue the same task with:

```bash
codex exec --json --sandbox workspace-write -c 'approvals_reviewer="user"' \
  resume <thread-id> -
```

Do not use `resume --last` in the worker adapter: multiple repos/workers may run
Codex and "last" can point at the wrong task.

The dispatcher allows at most two corrective follow-ups by default. Beyond that,
return control to OpenCode instead of creating an agent loop.

## JSONL success/failure contract

A successful delegated run requires both:

1. Codex process exit code = 0
2. a `turn.completed` event

Capture the last completed `agent_message` as the human-readable result.

Treat `turn.failed` and top-level `type="error"` as failures. Do not assume
every `item.type="error"` is fatal: Codex can emit item-level warnings and still
complete the turn successfully.

## Verification and authority

After Codex returns, the OpenCode dispatcher runs only read-only verification:

```bash
git status --short
git diff --stat
```

It checks that changed files stay inside the delegated scope. Project tests
should be run by Codex during the delegated task, and their exact status should
be reported rather than inferred.

Codex must leave changes uncommitted and must not:

- commit/push/merge/rebase
- reset/clean/restore/checkout
- write ChatGPT approval state
- call the merge wrapper
- make production/deployment decisions

The normal workflow remains:

```text
OpenCode -> Codex implementation -> OpenCode scope check
         -> ChatGPT independent review -> Human merge
```

## Troubleshooting

**`codex: command not found`** — install Codex CLI, then restart the OpenCode
session so the binary is visible in PATH.

**Authentication failure** — run `codex login status`, then complete the normal
Codex login flow.

**A test needs network or access outside the workspace** — report the blocked
operation. Do not switch the adapter to danger-full-access just to make it pass.

**Out-of-scope files changed** — resume the exact thread and ask Codex to undo
only its own out-of-scope edits. Do not use destructive Git cleanup as a shortcut.
