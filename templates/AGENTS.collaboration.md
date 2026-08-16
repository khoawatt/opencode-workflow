## ChatGPT–OpenCode Collaboration

GitHub is the communication protocol for implementation and review.

The linked GitHub Issue is the task and scope authority.

OpenCode is the implementation agent.

OpenCode must:

- inspect the current repository and working-tree state before changing files;
- preserve existing uncommitted work;
- follow the linked Issue and canonical project documentation;
- remain inside approved scope;
- delegate visual analysis to `@vision` when visual understanding is required;
- run real verification;
- self-review the complete diff;
- hand meaningful work off through a Pull Request;
- respond to actionable ChatGPT review feedback;
- never merge by default.

OpenCode self-review does not replace independent review.

### ChatGPT review bridge (pre-PR, optional but encouraged)

Before opening a Pull Request, run an external review through the ChatGPT bridge
to catch issues an independent reviewer may flag. Use the `@chatgpt-review`
subagent (or the `chatgpt-review` skill). One command, no copy-paste:

1. Finish the task and write the normal result summary (Done / What changed /
   Verification).
2. Invoke `@chatgpt-review` in the session and pass that result summary text as
   the review material. Do not attach a git diff.
3. The subagent wraps the summary in workflow context, sends it to ChatGPT Plus
   (web) via the browser bridge, and returns a machine-actionable verdict.
4. Address actionable feedback, rerun relevant checks, and mention the review
   in the PR.

This pre-PR bridge audits the result **summary** the implementing agent produced;
it is not a substitute for the post-PR independent review, which still checks the
complete diff against the Issue.

The bridge needs a one-time login: run
`~/.config/opencode/chatgpt-bridge/bin/chatgpt-review login` in a terminal, then
verify with `~/.config/opencode/chatgpt-bridge/bin/chatgpt-review status`.

The bridge keeps one ChatGPT thread per repo+branch so reviews on the same
branch share context instead of spawning new chats. It reuses the saved thread
and only starts a fresh one when it gets stale (`max_chars` / `max_turns` /
`max_age_hours` in `~/.config/opencode/chatgpt-bridge/bridge-config.json`) or
when a saved id fails to open. Inspect state with
`~/.config/opencode/chatgpt-bridge/bin/chatgpt-review chats`; force a fresh
thread with `/chatgpt-new`.

### Automated verification

GitHub Actions remain the independent automated verification layer.

### Independent review

ChatGPT Web remains the independent Pull Request reviewer after the Pull Request
is ready. It reviews against the Issue and complete diff and records actionable
feedback in Pull Request comments. OpenCode addresses approved feedback on the
same branch, reruns relevant checks, and updates the Pull Request evidence.

### Human authority

The human maintainer retains final authority over:

- merge;
- deployment;
- production changes;
- material scope changes;
- dependencies;
- architecture decisions;
- security-sensitive changes;
- waiving review findings;
- hosted-resource mutations.

Merge is permitted through the safety-checked wrapper
`.opencode/scripts/merge-approved-pr.sh` (recommended). Raw `gh pr merge` and
historically destructive operations (`git reset`/`clean`/`restore`, force-push)
prompt for confirmation (`ask`). See `opencode.jsonc`.

Do not run OpenCode with `--auto`/auto-approve when relying on `ask`-tier
confirmation as a human gate — auto mode approves all `ask`-tier operations
without an explicit human prompt. The human may revoke these permissions at any time.

### Visual tasks

When a task involves screenshots, images, UI references, mockups, visual
comparison, visual regression, responsive screenshots, diagrams, or visual
bugs, delegate visual analysis to `@vision` before making material visual
implementation decisions.

`@vision` analyzes only. The Primary Build Agent implements.
