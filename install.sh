#!/usr/bin/env bash
# ============================================================================
# Install the ChatGPT Review bridge into opencode on this machine.
# Run from anywhere; the script figures out where the repo is.
#
#   bash install.sh            full setup (config + npm deps + chromium + system libs)
#   bash install.sh --config   only copy opencode config (agent/skill/command/plugin)
#   bash install.sh --deps     only install node deps + chromium + system libs
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/.config/opencode"
BRIDGE="$CFG/chatgpt-bridge"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { printf "${GREEN}==>${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!! %s${NC}\n" "$*"; }
die()  { printf "${RED}ERROR: %s${NC}\n" "$*"; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

MODE="${1:-full}"

# ---------------------------------------------------------------------------
# Copy opencode configuration (agent / skill / command / plugin)
# ---------------------------------------------------------------------------
setup_config() {
  log "Copying opencode config into $CFG"
  mkdir -p "$CFG/agent" "$CFG/skills" "$CFG/command" "$CFG/plugins" "$CFG/chatgpt-bridge/bin"

  [ -f "$REPO_DIR/agent/chatgpt-review.md" ] && cp "$REPO_DIR/agent/chatgpt-review.md" "$CFG/agent/"
  cp -R "$REPO_DIR/skill/chatgpt-review" "$CFG/skills/" 2>/dev/null || true
  [ -d "$REPO_DIR/command" ] && cp "$REPO_DIR/command/"*.md "$CFG/command/" 2>/dev/null || true
  [ -f "$REPO_DIR/plugin/chatgpt-autoreview.ts" ] && cp "$REPO_DIR/plugin/chatgpt-autoreview.ts" "$CFG/plugins/"

  # Bridge binaries + package manifest + default config (do not overwrite local state)
  cp "$REPO_DIR/bin/chatgpt-review.mjs" "$REPO_DIR/bin/chatgpt-review" "$REPO_DIR/bin/autoreview" "$BRIDGE/bin/"
  cp "$REPO_DIR/package.json" "$BRIDGE/"
  [ -f "$BRIDGE/bridge-config.json" ] || cp "$REPO_DIR/bridge-config.json" "$BRIDGE/"

  # Make scripts executable
  chmod +x "$BRIDGE/bin/chatgpt-review" "$BRIDGE/bin/chatgpt-review.mjs" "$BRIDGE/bin/autoreview"
  log "Config copied."
}

# ---------------------------------------------------------------------------
# Install node deps + playwright chromium + system libraries
# ---------------------------------------------------------------------------
setup_deps() {
  need_cmd node; need_cmd npm
  log "Installing npm dependencies in $BRIDGE"
  mkdir -p "$BRIDGE"
  cd "$BRIDGE"
  npm install --no-audit --no-fund

  log "Installing Playwright Chromium"
  npm exec -- playwright install chromium || \
    npx --yes playwright@$(node -p "require('$BRIDGE/package.json').dependencies.playwright") install chromium

  # System libraries that headful Chromium needs on Debian/Ubuntu
  install_system_libs
  log "Dependencies installed."
}

# ---------------------------------------------------------------------------
# Ensure Chromium's shared libraries are present (Debian/Ubuntu).
# Uses sudo if available, otherwise downloads .deb packages into libs/.
# ---------------------------------------------------------------------------
install_system_libs() {
  command -v apt-get >/dev/null 2>&1 || { warn "Not an apt system; assuming libs are present."; return; }

  # Probe the chromium binary for missing libs.
  local chrome=""
  if [ -d "$BRIDGE" ]; then
    chrome="$(node -e "
      const { existsSync } = require('fs');
      const os = require('os');
      const { join } = require('path');
      const root = join(os.homedir(), '.cache', 'ms-playwright');
      try {
        const dirs = require('fs').readdirSync(root).sort().reverse();
        for (const d of dirs) {
          if (!d.startsWith('chromium-')) continue;
          for (const c of [join(root,d,'chrome-linux64','chrome'), join(root,d,'chrome-linux','chrome')]) {
            if (existsSync(c)) { console.log(c); process.exit(0); }
          }
        }
      } catch {}
      process.exit(0);
    " 2>/dev/null || true)"
  fi
  [ -n "$chrome" ] || { warn "Chromium not found yet; system libs check skipped."; return; }

  local missing
  missing="$(ldd "$chrome" 2>/dev/null | grep 'not found' | awk '{print $1}' | tr '\n' ' ' || true)"
  [ -n "$missing" ] || { log "All Chromium system libraries present."; return; }
  warn "Missing libraries: $missing"

  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    log "Installing missing libraries via apt (passwordless sudo available)"
    sudo apt-get update -y >/dev/null 2>&1 || true
    # map common missing libs to packages
    local pkgs="libnspr4 libnss3 libasound2t64"
    sudo apt-get install -y --no-install-recommends $pkgs || \
      sudo apt-get install -y --no-install-recommends libnspr4 libnss3 libasound2
    return
  fi

  warn "No passwordless sudo. Downloading .deb packages into $BRIDGE/libs (user-space)."
  mkdir -p "$BRIDGE/libs" /tmp/opencode-bridge-libs
  cd /tmp/opencode-bridge-libs
  apt-get download libnspr4 libnss3 libasound2t64 2>/dev/null || \
    apt-get download libnspr4 libnss3 libasound2
  for f in *.deb; do dpkg -x "$f" rootfs 2>/dev/null || true; done
  [ -d rootfs/usr/lib/x86_64-linux-gnu ] && cp -R rootfs/usr/lib/x86_64-linux-gnu/* "$BRIDGE/libs/" || \
    cp -R rootfs/usr/lib/* "$BRIDGE/libs/" 2>/dev/null || true
  log "User-space libraries installed into $BRIDGE/libs"
}

# ---------------------------------------------------------------------------
case "$MODE" in
  --config) setup_config ;;
  --deps)   setup_deps ;;
  full)
    setup_config
    setup_deps
    log "Setup complete."
    echo
    log "Next steps:"
    echo "  1. Sign in to ChatGPT once:  $BRIDGE/bin/chatgpt-review login"
    echo "  2. Verify:                   $BRIDGE/bin/chatgpt-review status   (expect loggedIn: true)"
    echo "  3. Restart opencode so it loads the new agent/skill/commands."
    echo
    echo "  Use @chatgpt-review to review, /autoreview on|off for auto-review,"
    echo "  /chatgpt-project to manage ChatGPT Projects."
    ;;
  *) die "usage: bash install.sh [--config|--deps]" ;;
esac
