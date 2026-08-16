# Architecture & Execution Contract

**Status:** FINAL — single source of truth for the OpenCode ↔ ChatGPT collaboration workflow.

**Scope:** applies to every repository managed under the `opencode-workflow` standard
(originally: `Feaon-ldp-v2`, `qvak-portfolio`; reusable for any future project).

This document supersedes earlier standalone proposals where they conflict.

---

## 0. Final architecture at a glance

```text
Human / Maintainer
        |
        v
ChatGPT Web
planning + issue/spec preparation + independent review
        |
        v
GitHub Issue
task/scope authority
        |
        v
OpenCode Primary Build Agent
        |
        +--> Superpowers            workflow / methodology
        +--> @vision                Gemini Flash-class multimodal, visual analysis only
        +--> @chatgpt-review        dispatcher: sends result summaries to ChatGPT Web via browser bridge
        |
        v
implementation
        |
        v
OpenCode self-review + local verification
        |
        v
Pull Request
        |
        v
GitHub Actions
independent automated verification
        |
        v
ChatGPT Web
independent PR review  (BLOCKER / SHOULD FIX / OPTIONAL)
        |
        v
OpenCode
fix approved actionable feedback
        |
        v
ChatGPT Web final review
        |
        v
Human / Maintainer
merge / deploy decision
```

### Role ownership

| Concern | Final owner |
|---|---|
| Requirements clarification | Human + ChatGPT |
| Task scope authority | GitHub Issue |
| Planning/spec preparation | ChatGPT Web |
| Implementation | OpenCode Primary Build Agent |
| Workflow/methodology | Superpowers |
| Visual understanding | `@vision` |
| Review dispatch (bridge) | `@chatgpt-review` |
| Local Git/GitHub CLI | OpenCode Primary |
| Pre-PR self-review | OpenCode Primary |
| Automated verification | GitHub Actions |
| Independent review | ChatGPT Web |
| Merge / deploy authority | Human / Maintainer |

### Explicitly rejected decisions

1. **No authoritative `@reviewer`.** OpenCode self-review is a quality gate, not
   independent review. `@chatgpt-review` is only a *dispatcher* that forwards the
   result summary to ChatGPT Web — ChatGPT Web remains the independent reviewer.
2. **No `@github-worker` in the initial setup.** Git/GitHub operations stay with
   the Primary Build Agent.
3. **No AI merge by default.** `gh pr merge` raw is `ask`-tier. The recommended
   merge path is the safety-checked wrapper `.opencode/scripts/merge-approved-pr.sh`.
4. **No hardcoded unverified model IDs.** Verify actual provider/model IDs first.

---

## 1. Repository scope

Apply this architecture independently to each repository. Do **not**:

- initialize a new Git repository;
- assume repos have identical files;
- copy one repo's commands blindly into the other;
- discard existing work or reset the working tree.

---

## 2. Mandatory preflight

Before modifying any repo: confirm path/git/branch/remotes; read `AGENTS.md` and
specs; inspect existing config; run `git status`, `git diff`, `git diff --cached`,
`git log --oneline -n 10`; identify uncommitted/untracked work; do not discard or
silently absorb unrelated changes; merge into existing files rather than overwrite.

**Stop condition:** if uncommitted changes overlap a file this setup must modify
and safe merge is not obvious — report, propose a minimal merge, wait for approval.

---

## 3. Project-specific config

- Project config lives at repo root: `<repo>/opencode.jsonc` (NOT `.opencode/opencode.jsonc`).
- `.opencode/` holds agents, commands, skills, scripts.
- Superpowers is enabled via the `plugin` array in `opencode.jsonc`.

---

## 4. Specialized agents

```text
OpenCode
├── Primary Build Agent
├── Superpowers
├── @vision           (visual analysis only)
└── @chatgpt-review   (dispatches result summary → ChatGPT Web for independent review)
```

- `@vision`: analysis-only; no file edits; no bash. Model: verified Gemini
  Flash-class multimodal ID (e.g. `google/gemini-3.6-flash` if recognized).
- `@chatgpt-review`: read-only dispatcher; forwards the implementing agent's
  result summary to ChatGPT Web via the browser bridge and returns a
  machine-actionable verdict. See `docs/WORKFLOW.md`.

---

## 5. GitHub Issue is scope authority

Before implementation, identify: objective, scope, out-of-scope, expected files,
acceptance criteria, required verification, security boundaries, production
impact, stop conditions. Do not expand scope without approval.

**Approval-required deviations:** architecture change, new dependency, files
outside scope, security-boundary change, new production impact, hosted-resource
mutation, unauthorized credentials, data migration, materially different behavior.

---

## 6. Safe Git/GitHub permission policy

Two tiers (last matching rule wins; catch-all `*` first):

- **allow** — inspection (`git status/diff/log/show/branch/remote/rev-parse/ls-files/fetch/grep`), `git add/commit`, `gh *view/list/checks/repo view/auth status`, and `.opencode/scripts/merge-approved-pr.sh`.
- **ask** — everything else: mutating ops (`git commit --amend`, `git pull/push/merge/rebase/switch/stash`, `gh issue create/edit`, `gh pr create/edit/comment/review`, `gh pr merge` raw) and historically destructive ops (`git reset/clean/restore/checkout`, `git push --force*/-f*/--force-with-lease*`).

**Non-negotiable:** never force-push; never use reset/clean/restore for convenience;
never discard uncommitted work; prefer the safety-checked merge wrapper over raw
`gh pr merge`.

> `--auto` (enabled by the `opencode-work` tmux launcher) auto-approves **all**
> `ask`-tier operations, including destructive ops and raw merge — this is the
> accepted trade-off of running `--auto`. To keep a human gate on those, run
> without `--auto` (`OPENCODE_WORK_AUTO=0`). See `docs/SETUP.md`.

---

## 7. Self-review before PR

Before opening/updating a PR: review full diff, Issue scope, acceptance criteria,
correctness, regressions, tests, unrelated changes, secrets, generated artifacts,
docs, security/production impact, rollback. Self-review is an internal gate only.

---

## 8. Pull Request handoff contract

PR body should contain: linked Issue (`Closes #<N>`), Summary, Changed Files table,
Scope Compliance checklist, Acceptance Criteria, Verification Evidence table,
CI Status, Risks/Limitations, Production Impact, Rollback, Documentation Updates,
Recommended Next Task.

**Evidence policy:** report truthfully — never claim a test/build/CI/manual check
passed if it wasn't run; report failures/skips with reason.

---

## 9. Independent review (ChatGPT Web)

ChatGPT reviews: linked Issue, acceptance criteria, canonical specs/plans, full
PR diff, CI results, scope compliance, security boundaries, production impact,
tests, docs, architecture boundaries.

Priority order: security/data-loss → scope violations → correctness →
backward-compat/regressions → tests → architecture → maintainability → docs → style.

Findings severity: `BLOCKER` / `SHOULD FIX` / `OPTIONAL` (with file, problem,
impact, expected resolution, severity).

Outcome: `APPROVE` / `REQUEST CHANGES` / `NEEDS MANUAL CHECK`. ChatGPT does not merge.

---

## 10. Handling review feedback

OpenCode reads review comments, classifies each finding (actionable in-scope /
question / optional / scope-expanding), implements only approved in-scope fixes,
stops for approval on scope/architecture/security changes, works on the existing
PR branch, re-inspects the diff, reruns verification, updates PR evidence,
responds to threads — and does not merge.

---

## 11. Final review + human merge

After feedback is addressed, ChatGPT re-reviews. Before approving, verify: CI
passing, blockers resolved, material SHOULD FIX resolved or human-waived, scope
deviations pre-approved, PR body matches diff, verification current, no secrets.
ChatGPT may return `APPROVE`, but merge authority stays with the human.

**Human-only authority:** merge, deployment, production changes, scope exceptions,
architecture decisions, dependency changes, security-sensitive changes, waiving
review findings, hosted-resource mutations.

---

## 12. Local auth vs GitHub Actions auth

Treat as separate security contexts. Never copy local credential files into the
repo. Never assume local credentials exist on Actions runners. Report only
secret *names*, never values.

---

## 13. Definition of done

- valid project config; Superpowers works; Primary can safely use git/gh;
- destructive ops prompt for confirmation (`ask`); `@vision` available, analysis-only;
- `@chatgpt-review` dispatcher available; no authoritative `@reviewer`;
- ChatGPT Web documented as independent reviewer; GitHub Actions is automated
  verification; GitHub Issue is scope authority; self-review is pre-PR only;
- human merge authority enforced; local vs Actions secrets separated;
- existing work intact.
