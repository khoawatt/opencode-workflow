#!/usr/bin/env bash
# Safely merge the open Pull Request for the current branch, but ONLY after
# every safety condition is verified (fail closed). This is the sole permitted
# merge path in the project OpenCode permission policy: raw `gh pr merge` (and
# any --admin / bypass flag) is denied.
#
# Safety conditions (ALL must hold, otherwise the script exits non-zero and
# does NOT merge; any command/API failure is treated as a blocker):
#   1. The current branch has EXACTLY ONE matching OPEN PR owned by this repo.
#   2. The PR is mergeable (no conflicts).
#   3. A ChatGPT review approval is recorded (verdict "approve") whose headSha
#      exactly equals the local HEAD and whose pr number equals the selected PR.
#   4. Every required status check on the PR is SUCCESS; a failure to query the
#      checks is itself a blocker.
#   5. The final merge is HEAD-atomic: `gh pr merge --match-head-commit <HEAD>`
#      refuses to merge if the PR head moved away from the reviewed commit.
#
# The script accepts NO arguments. It deliberately ignores any flags passed
# (e.g. --admin, --delete-branch) and merges with a fixed `--merge` method so a
# caller cannot escalate privileges or bypass the checks.
#
# Exit codes: 0 = merged; 1 = precondition failed (nothing merged); 2 = usage error.

set -euo pipefail

BRIDGE="$HOME/.config/opencode/chatgpt-bridge/bin/chatgpt-review"
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required." >&2; exit 1; }

# --- Reject any arguments (defense in depth against --admin / bypass flags) ---
if [ "$#" -gt 0 ]; then
  echo "ERROR: merge-approved-pr accepts no arguments (no --admin, no bypass flags)." >&2
  exit 2
fi

branch="$(git branch --show-current)"
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  echo "ERROR: could not determine a current branch (detached HEAD?)." >&2
  exit 1
fi

# --- Resolve OPEN PRs for this branch, owned by this repo (fail if not exactly one) ---
candidates="$(
  gh pr list --state open --head "$branch" \
    --json number,isCrossRepository \
    --jq '[.[] | select(.isCrossRepository == false) | .number]'
)"
count="$(printf '%s' "$candidates" | jq 'length')"
if [ "$count" -ne 1 ]; then
  echo "ERROR: expected exactly one OPEN same-repo PR for branch '$branch'; found $count." >&2
  exit 1
fi
pr="$(printf '%s' "$candidates" | jq -r '.[0]')"

# --- Load PR metadata ---
pr_data="$(gh pr view "$pr" --json state,mergeable,headRefOid,baseRefName --jq '.' 2>&1)"
state="$(printf '%s' "$pr_data" | jq -r '.state')"
mergeable="$(printf '%s' "$pr_data" | jq -r '.mergeable')"
head_oid="$(printf '%s' "$pr_data" | jq -r '.headRefOid')"
base="$(printf '%s' "$pr_data" | jq -r '.baseRefName')"

[ "$state" = "OPEN" ] || { echo "ERROR: PR #$pr is not OPEN (state=$state)." >&2; exit 1; }
[ "$mergeable" = "MERGEABLE" ] || { echo "ERROR: PR #$pr is not mergeable (mergeable=$mergeable)." >&2; exit 1; }

local_head="$(git rev-parse HEAD)"

# --- Verify recorded ChatGPT approval: verdict approve AND headSha == HEAD AND pr matches ---
approval="$("$BRIDGE" approval get 2>&1)"
approval_verdict="$(printf '%s' "$approval" | jq -r '.verdict // "none"' 2>/dev/null || echo none)"
approval_sha="$(printf '%s' "$approval" | jq -r '.headSha // ""' 2>/dev/null || echo "")"
approval_pr="$(printf '%s' "$approval" | jq -r '.pr // ""' 2>/dev/null || echo "")"
[ "$approval_verdict" = "approve" ] || { echo "ERROR: no recorded 'approve' verdict (verdict=$approval_verdict). Run @chatgpt-review first." >&2; exit 1; }
if [ -z "$approval_sha" ] || [ "$approval_sha" != "$local_head" ]; then
  echo "ERROR: recorded approval headSha ('$approval_sha') does not exactly match local HEAD ($local_head). Re-review this HEAD." >&2
  exit 1
fi
if [ -n "$approval_pr" ] && [ "$approval_pr" != "$pr" ]; then
  echo "ERROR: recorded approval is for PR #$approval_pr, but branch '$branch' resolves to PR #$pr." >&2
  exit 1
fi

# --- Verify all required checks pass (a query failure is a blocker, NOT swallowed) ---
if ! checks_out="$(gh pr checks "$pr" --json name,state 2>&1)"; then
  echo "ERROR: could not query status checks for PR #$pr. Aborting without merging." >&2
  echo "$checks_out" >&2
  exit 1
fi
non_success="$(printf '%s' "$checks_out" | jq -r '[.[] | select(.state != "SUCCESS") | .name] | .[]' 2>/dev/null)"
if [ -n "$non_success" ]; then
  echo "ERROR: non-SUCCESS checks on PR #$pr:" >&2
  printf '%s\n' "$non_success" >&2
  exit 1
fi

# --- HEAD-atomic merge: require the PR head to still equal the reviewed commit ---
echo "All safety checks passed for PR #$pr (base=$base, head=$local_head). Merging..."
gh pr merge "$pr" --merge --match-head-commit "$local_head"
echo "Merged PR #$pr at commit $local_head."
