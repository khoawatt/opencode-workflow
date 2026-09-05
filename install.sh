#!/usr/bin/env bash
# ============================================================================
# Install the ChatGPT Review bridge + Gemini review bridge into opencode on
# this machine. Run from anywhere; the script figures out where the repo is.
#
#   bash install.sh            full setup (config + npm deps + chromium + system libs)
#   bash install.sh --config   only copy opencode config (agent/skill/command/plugin)
#   bash install.sh --deps     only install node deps + chromium + system libs
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/.config/opencode"
BRIDGE="$CFG/chatgpt-bridge"
GEMINI="$CFG/gemini-bridge"

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
  mkdir -p "$CFG/agent" "$CFG/skills" "$CFG/command" "$CFG/plugins" "$BRIDGE/bin" "$GEMINI/bin"

  # projects.conf for opencode-work launcher (N-project, port from codex-workflow)
  if [ -f "$REPO_DIR/config/projects.conf" ]; then
    if [ -f "$CFG/projects.conf" ]; then
      log "Kept existing projects.conf: $CFG/projects.conf"
    else
      cp "$REPO_DIR/config/projects.conf" "$CFG/projects.conf"
      chmod 0644 "$CFG/projects.conf" 2>/dev/null || true
      log "Installed projects.conf: $CFG/projects.conf (edit to add repos, then opencode-work --reset)"
    fi
  fi

  [ -f "$REPO_DIR/agent/chatgpt-review.md" ] && cp "$REPO_DIR/agent/chatgpt-review.md" "$CFG/agent/"
  [ -f "$REPO_DIR/agent/gemini-review.md" ] && cp "$REPO_DIR/agent/gemini-review.md" "$CFG/agent/"
  cp -R "$REPO_DIR/skill/chatgpt-review" "$CFG/skills/" 2>/dev/null || true
  cp -R "$REPO_DIR/skill/gemini-review" "$CFG/skills/" 2>/dev/null || true
  [ -d "$REPO_DIR/command" ] && cp "$REPO_DIR/command/"*.md "$CFG/command/" 2>/dev/null || true
  [ -f "$REPO_DIR/plugin/chatgpt-autoreview.ts" ] && cp "$REPO_DIR/plugin/chatgpt-autoreview.ts" "$CFG/plugins/"
  # session-auth for Gemini classifier (port from codex-workflow) + shared .env loader
  [ -f "$REPO_DIR/bin/session-auth.mjs" ] && cp "$REPO_DIR/bin/session-auth.mjs" "$BRIDGE/bin/" 2>/dev/null || true
  [ -f "$REPO_DIR/bin/session-auth.mjs" ] && cp "$REPO_DIR/bin/session-auth.mjs" "$GEMINI/bin/" 2>/dev/null || true
  [ -f "$REPO_DIR/bin/bridge-env.mjs" ] && cp "$REPO_DIR/bin/bridge-env.mjs" "$BRIDGE/bin/" 2>/dev/null || true
  [ -f "$REPO_DIR/bin/bridge-env.mjs" ] && cp "$REPO_DIR/bin/bridge-env.mjs" "$GEMINI/bin/" 2>/dev/null || true

  # Bridge binaries + package manifest + default config (do not overwrite local state)
  cp "$REPO_DIR/bin/chatgpt-review.mjs" "$REPO_DIR/bin/chatgpt-review" "$REPO_DIR/bin/autoreview" "$BRIDGE/bin/"
  # Sources sync (hybrid .git + metadata) - also available as chatgpt-review sources / src-sync etc.
  [ -f "$REPO_DIR/bin/chatgpt-sources-sync.mjs" ] && cp "$REPO_DIR/bin/chatgpt-sources-sync.mjs" "$BRIDGE/bin/" || true
  [ -f "$REPO_DIR/bin/sources" ] && cp "$REPO_DIR/bin/sources" "$BRIDGE/bin/" || true
  cp "$REPO_DIR/package.json" "$BRIDGE/"
  [ -f "$BRIDGE/bridge-config.json" ] || cp "$REPO_DIR/bridge-config.json" "$BRIDGE/"

  # Gemini bridge (separate profile/state; shares the Chromium install)
  cp "$REPO_DIR/bin/gemini-review.mjs" "$REPO_DIR/bin/gemini-review" "$GEMINI/bin/"
  cp "$REPO_DIR/package.json" "$GEMINI/"
  [ -f "$GEMINI/bridge-config.json" ] || printf '{ "max_chars": 400000, "max_turns": 40, "max_age_hours": 48 }\n' > "$GEMINI/bridge-config.json"

  # Per-bridge .env templates for non-interactive auto-login (never overwrite real creds).
  # NOTE: installed .env keeps EMPTY values (envConfigured:false) until the user
  # fills real credentials. config/*.env.example holds documented placeholders.
  if [ ! -f "$BRIDGE/.env" ]; then
    printf '# ChatGPT auto-login (chmod 600, never commit)\n# See config/chatgpt-bridge.env.example for docs.\nCHATGPT_EMAIL=\nCHATGPT_PASSWORD=\n' > "$BRIDGE/.env"
    chmod 0600 "$BRIDGE/.env" 2>/dev/null || true
    log "Created $BRIDGE/.env (fill CHATGPT_EMAIL/CHATGPT_PASSWORD, chmod 600) — or run manual login"
  else
    chmod 0600 "$BRIDGE/.env" 2>/dev/null || true
    log "Kept existing $BRIDGE/.env"
  fi
  if [ ! -f "$GEMINI/.env" ]; then
    printf '# Gemini auto-login (chmod 600, never commit)\n# See config/gemini-bridge.env.example for docs.\nGEMINI_EMAIL=\nGEMINI_PASSWORD=\n' > "$GEMINI/.env"
    chmod 0600 "$GEMINI/.env" 2>/dev/null || true
    log "Created $GEMINI/.env (fill GEMINI_EMAIL/GEMINI_PASSWORD, chmod 600) — or run manual login"
  else
    chmod 0600 "$GEMINI/.env" 2>/dev/null || true
    log "Kept existing $GEMINI/.env"
  fi

  # Make scripts executable
  chmod +x "$BRIDGE/bin/chatgpt-review" "$BRIDGE/bin/chatgpt-review.mjs" "$BRIDGE/bin/autoreview"
  [ -f "$BRIDGE/bin/chatgpt-sources-sync.mjs" ] && chmod +x "$BRIDGE/bin/chatgpt-sources-sync.mjs" || true
  [ -f "$BRIDGE/bin/sources" ] && chmod +x "$BRIDGE/bin/sources" || true
  chmod +x "$GEMINI/bin/gemini-review" "$GEMINI/bin/gemini-review.mjs"

  # Short commands on PATH: chatgpt-review <cmd>, gemini-review <cmd>
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$BRIDGE/bin/chatgpt-review" "$HOME/.local/bin/chatgpt-review"
  ln -sfn "$GEMINI/bin/gemini-review" "$HOME/.local/bin/gemini-review"

  log "Config copied."
}

# ---------------------------------------------------------------------------
# Install node deps + playwright chromium + system libraries
# ---------------------------------------------------------------------------
setup_deps() {
  need_cmd node; need_cmd npm
  log "Installing npm dependencies in $BRIDGE"
  mkdir -p "$BRIDGE"
  (cd "$BRIDGE" && npm install --no-audit --no-fund)

  if [ -f "$GEMINI/package.json" ]; then
    log "Installing npm dependencies in $GEMINI"
    mkdir -p "$GEMINI"
    (cd "$GEMINI" && npm install --no-audit --no-fund)
  fi

  log "Installing Playwright Chromium"
  (cd "$BRIDGE" && npm exec -- playwright install chromium) || \
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
    log "Next steps (pick one login style per bridge):"
    echo "  1a. Manual (1 lần, kể cả 2FA/CAPTCHA):  $BRIDGE/bin/chatgpt-review login"
    echo "      (optional) Gemini:                  $GEMINI/bin/gemini-review login"
    echo "  1b. Tự động từ .env (không gõ tay): fill $BRIDGE/.env rồi chạy:"
    echo "      $BRIDGE/bin/chatgpt-review login --auto   # CHATGPT_EMAIL / CHATGPT_PASSWORD"
    echo "      $GEMINI/bin/gemini-review login --auto    # GEMINI_EMAIL / GEMINI_PASSWORD"
    echo "  2. Verify:                   $BRIDGE/bin/chatgpt-review status   (expect loggedIn: true)"
    echo "     (optional) Gemini:        $GEMINI/bin/gemini-review status    (expect loggedIn: true)"
    echo "  3. Restart opencode so it loads the new agent/skill/commands."
    echo
    echo "  Use @chatgpt-review to review, @gemini-review for a second opinion,"
    echo "  /autoreview on|off for auto-review, /chatgpt-project to manage ChatGPT Projects."
    ;;
  *) die "usage: bash install.sh [--config|--deps]" ;;
esac
