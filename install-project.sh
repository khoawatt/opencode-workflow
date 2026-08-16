#!/usr/bin/env bash
# ============================================================================
# Install the opencode-workflow project-scoped config into a target repository.
#
#   bash install-project.sh /path/to/repo
#
# Copies (NEVER overwrites) the canonical policy and .opencode resources from
# this template repo into the target. Existing files are left untouched and
# reported so the caller can merge manually.
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES="$REPO_DIR/templates"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { printf "${GREEN}==>${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!! %s${NC}\n" "$*"; }
die()  { printf "${RED}ERROR: %s${NC}\n" "$*"; exit 1; }

TARGET="${1:-}"
[ -n "$TARGET" ] || die "usage: bash install-project.sh <repo-path>"
[ -d "$TARGET" ] || die "not a directory: $TARGET"
[ -d "$TARGET/.git" ] || warn "target does not look like a git repo (no .git) — continuing anyway"

TARGET="$(cd "$TARGET" && pwd)"

# copy_if_absent <src> <dst> [mode]
copy_if_absent() {
  local src="$1" dst="$2" mode="${3:-644}"
  if [ -e "$dst" ]; then
    warn "exists, skipping (merge manually): $dst"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    chmod "$mode" "$dst"
    log "created: $dst"
  fi
}

log "Installing opencode-workflow project config into $TARGET"

# --- opencode.jsonc (canonical policy) ---
copy_if_absent "$TEMPLATES/opencode.jsonc" "$TARGET/opencode.jsonc"

# --- .opencode resources ---
copy_if_absent "$TEMPLATES/vision.md"                        "$TARGET/.opencode/agents/vision.md"
copy_if_absent "$REPO_DIR/agent/chatgpt-review.md"           "$TARGET/.opencode/agents/chatgpt-review.md"
copy_if_absent "$TEMPLATES/merge-approved-pr.sh"             "$TARGET/.opencode/scripts/merge-approved-pr.sh" 755
copy_if_absent "$REPO_DIR/skill/chatgpt-review/SKILL.md"     "$TARGET/.opencode/skills/chatgpt-review/SKILL.md"
copy_if_absent "$REPO_DIR/command/autoreview.md"             "$TARGET/.opencode/commands/autoreview.md"
copy_if_absent "$REPO_DIR/command/chatgpt-new.md"            "$TARGET/.opencode/commands/chatgpt-new.md"
copy_if_absent "$REPO_DIR/command/chatgpt-project.md"        "$TARGET/.opencode/commands/chatgpt-project.md"

# --- AGENTS.md collaboration section ---
# Never overwrite AGENTS.md; append the collaboration section only if the marker
# is absent. If present, do nothing (it is already integrated).
AGENTS="$TARGET/AGENTS.md"
if [ -f "$AGENTS" ]; then
  if grep -q "ChatGPT–OpenCode Collaboration\|ChatGPT review bridge" "$AGENTS"; then
    warn "AGENTS.md already has the collaboration section; skipping"
  else
    { printf '\n'; cat "$TEMPLATES/AGENTS.collaboration.md"; } >> "$AGENTS"
    log "appended collaboration section to AGENTS.md"
  fi
else
  cp "$TEMPLATES/AGENTS.collaboration.md" "$AGENTS"
  log "created AGENTS.md (collaboration section)"
fi

echo
log "Done. Restart opencode in $TARGET to load the new config."
