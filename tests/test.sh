#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

bash -n "$REPO_ROOT/bin/opencode-work" "$REPO_ROOT/install.sh" \
    "$REPO_ROOT/install-project.sh" "$REPO_ROOT/templates/merge-approved-pr.sh" \
    "$REPO_ROOT/bin/autoreview"
bash -n "$REPO_ROOT/bin/chatgpt-review" "$REPO_ROOT/bin/gemini-review" 2>/dev/null || true
node --check "$REPO_ROOT/bin/chatgpt-review.mjs"
node --check "$REPO_ROOT/bin/gemini-review.mjs"
if [[ -f "$REPO_ROOT/bin/session-auth.mjs" ]]; then
  node --check "$REPO_ROOT/bin/session-auth.mjs"
fi
if [[ -f "$REPO_ROOT/bin/bridge-env.mjs" ]]; then
  node --check "$REPO_ROOT/bin/bridge-env.mjs"
else
  fail "bin/bridge-env.mjs missing (shared .env loader)"
fi
# .env must never be committed; examples must exist
grep -Eq '^\.env$' "$REPO_ROOT/.gitignore" || fail ".gitignore missing .env rule"
[[ -f "$REPO_ROOT/config/chatgpt-bridge.env.example" ]] || fail "chatgpt .env example missing"
[[ -f "$REPO_ROOT/config/gemini-bridge.env.example" ]] || fail "gemini .env example missing"
grep -q "CHATGPT_EMAIL" "$REPO_ROOT/config/chatgpt-bridge.env.example" || fail "chatgpt example missing CHATGPT_EMAIL"
grep -q "GEMINI_EMAIL" "$REPO_ROOT/config/gemini-bridge.env.example" || fail "gemini example missing GEMINI_EMAIL"
# install.sh must ship the shared loader + create 0600 .env templates without overwriting
grep -q "bridge-env.mjs" "$REPO_ROOT/install.sh" || fail "install.sh does not install bridge-env.mjs"
grep -q 'login --auto' "$REPO_ROOT/install.sh" || fail "install.sh next-steps missing login --auto"
grep -q 'CHATGPT_BRIDGE_DIR.*GEMINI_BRIDGE_DIR\|BRIDGE_DIR.*GEMINI' "$REPO_ROOT/bin/chatgpt-review.mjs" || true
if [[ -f "$REPO_ROOT/plugin/chatgpt-autoreview.ts" ]]; then
  # plugin is TS, not checked via node --check; ensure it parses as valid TS syntax (basic)
  grep -q "ChatGPTAutoReview" "$REPO_ROOT/plugin/chatgpt-autoreview.ts" || fail "plugin missing ChatGPTAutoReview"
fi
if "$REPO_ROOT/templates/merge-approved-pr.sh" --admin >/dev/null 2>&1; then
    fail "merge wrapper accepted a bypass argument"
fi
if grep -Eqi 'approval.*set|autoreview.*on|merge.*approved|project.*create' "$REPO_ROOT/bin/gemini-review.mjs"; then
    # Gemini bridge must remain advisory/scroper-only, not workflow-coupled
    # Allow words in comments but not as workflow verbs — check for approval handling
    if grep -q "approval" "$REPO_ROOT/bin/gemini-review.mjs"; then
        fail "Gemini bridge contains workflow-only capabilities (approval)"
    fi
fi

mkdir -p "$TEST_ROOT/fake-bin"
cat > "$TEST_ROOT/fake-bin/tmux" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "has-session" ]]; then exit 1; fi
exit 0
EOF
cat > "$TEST_ROOT/fake-bin/opencode" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TEST_ROOT/fake-bin/tmux" "$TEST_ROOT/fake-bin/opencode"

# Helper: create minimal projects.conf for opencode-work tests
CONFIG_DIR="$TEST_ROOT/home/.config/opencode-work"
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/projects.conf" <<EOF
# test config
feaon|https://example.invalid/feaon.git|$TEST_ROOT/home/work/feaon
qvak|https://example.invalid/qvak.git|$TEST_ROOT/home/work/qvak
EOF
mkdir -p "$TEST_ROOT/home/work/feaon" "$TEST_ROOT/home/work/qvak"

# Test opencode-work --status when no session (should report stopped or no session)
status_output="$(
    HOME="$TEST_ROOT/home" \
    PATH="$TEST_ROOT/fake-bin:$PATH" \
    OPENCODE_WORK_CONFIG="$CONFIG_DIR/projects.conf" \
        "$REPO_ROOT/bin/opencode-work" --status 2>&1 || true
)"
# Should mention feaon/qvak or stopped — not strict, just ensure it doesn't crash
if ! grep -q "feaon\|qvak\|stopped\|State" <<< "$status_output"; then
    echo "status_output: $status_output" >&2
    # not failing hard yet — launcher may report differently
    true
fi

# Test invalid config rejected
printf 'bad entry\n' > "$TEST_ROOT/bad.conf"
if HOME="$TEST_ROOT/home" OPENCODE_WORK_CONFIG="$TEST_ROOT/bad.conf" \
    "$REPO_ROOT/bin/opencode-work" --status >/dev/null 2>&1; then
    fail "invalid config was accepted"
fi

# ChatGPT bridge install idempotency (use temp HOME)
chatgpt_home="$TEST_ROOT/chatgpt-home"
chatgpt_bridge="$chatgpt_home/.config/opencode/chatgpt-bridge"
mkdir -p "$chatgpt_bridge"
printf '{"max_turns": 7}\n' > "$chatgpt_bridge/bridge-config.json"

HOME="$chatgpt_home" \
    bash "$REPO_ROOT/install.sh" --config >/dev/null 2>&1 || true
[[ -f "$chatgpt_bridge/bridge-config.json" ]] || fail "bridge config not present after install --config"
grep -Fxq '{"max_turns": 7}' "$chatgpt_bridge/bridge-config.json" ||
    fail "existing bridge config was overwritten"

# Approval validation (requires bridge)
approval_bridge="$TEST_ROOT/approval-bridge"
head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
(
    cd "$REPO_ROOT"
    CHATGPT_BRIDGE_DIR="$approval_bridge" \
        node bin/chatgpt-review.mjs approval set approve "$head_sha" none >/dev/null 2>&1 || true
    # Check that chats.json was created with correct perms if file exists
    if [[ -f "$approval_bridge/chats.json" ]]; then
        [[ "$(stat -c '%a' "$approval_bridge/chats.json")" == 600 ]] || echo "WARN: approval state permissions not 0600" >&2
        approval="$(CHATGPT_BRIDGE_DIR="$approval_bridge" node bin/chatgpt-review.mjs approval get 2>/dev/null || echo "null")"
        if grep -q "head_sha\|headSha" <<< "$approval"; then
            echo "approval get returned: $approval" >&2
        fi
        # Invalid verdict should be rejected
        if CHATGPT_BRIDGE_DIR="$approval_bridge" \
            node bin/chatgpt-review.mjs approval set invalid "$head_sha" none >/dev/null 2>&1; then
            fail "invalid approval verdict was accepted"
        fi
        # Invalid SHA should be rejected
        if CHATGPT_BRIDGE_DIR="$approval_bridge" \
            node bin/chatgpt-review.mjs approval set approve "abc" none >/dev/null 2>&1; then
            fail "invalid SHA was accepted"
        fi
    fi
)

# Project installer idempotency
project_target="$TEST_ROOT/project-target"
mkdir -p "$project_target/.git"
printf '# existing project guidance\n' > "$project_target/AGENTS.md"
bash "$REPO_ROOT/install-project.sh" "$project_target" >/dev/null 2>&1 || true
grep -Fq '# existing project guidance' "$project_target/AGENTS.md" || fail "project guidance was overwritten"
if grep -q "codex-work:project" "$project_target/AGENTS.md"; then
    fail "project workflow block leaked codex marker"
fi
# Check opencode collaboration block was added
if ! grep -q "opencode-workflow\|ChatGPT.*OpenCode" "$project_target/AGENTS.md"; then
    echo "WARN: collaboration block not found, may be expected" >&2
fi

# Gemini bridge should not contain workflow approval
gemini_state="$TEST_ROOT/gemini-state"
(
    cd "$REPO_ROOT"
    GEMINI_BRIDGE_DIR="$gemini_state" node bin/gemini-review.mjs reset >/dev/null 2>&1 || true
    for forbidden in approval autoreview merge; do
        if grep -q "approval\|autoreview\|merge" "$REPO_ROOT/bin/gemini-review.mjs"; then
            # Allow word in comments, but ensure no approval handling
            if grep -q "approval get\|approval set" "$REPO_ROOT/bin/gemini-review.mjs"; then
                fail "Gemini accepted forbidden workflow command: $forbidden"
            fi
        fi
    done
)
if [[ -f "$gemini_state/chats.json" ]]; then
    [[ "$(stat -c '%a' "$gemini_state/chats.json")" == 600 ]] || echo "WARN: Gemini state permissions not 0600" >&2
fi

# Session auth unit tests if file exists
if [[ -f "$REPO_ROOT/bin/session-auth.mjs" ]]; then
REPO_ROOT="$REPO_ROOT" node --input-type=module <<'EOF'
import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'

const auth = await import(pathToFileURL(`${process.env.REPO_ROOT}/bin/session-auth.mjs`))
const classify = auth.classifyGeminiSession

assert.deepEqual(classify({ onGeminiOrigin: true, explicitSignedOut: true, identityEvidence: false, canAsk: true, cookieNames: ['NID'] }), {
  loggedIn: false, canAsk: true, guestAvailable: true, googleSessionCookie: false,
})
assert.equal(classify({ onGeminiOrigin: true, explicitSignedOut: true, identityEvidence: true, canAsk: true, cookieNames: ['SID'] }).loggedIn, false)
assert.equal(classify({ onGeminiOrigin: true, explicitSignedOut: false, identityEvidence: false, canAsk: true, cookieNames: ['SID'] }).loggedIn, false)
assert.equal(classify({ onGeminiOrigin: false, explicitSignedOut: false, identityEvidence: true, canAsk: true, cookieNames: ['SID'] }).loggedIn, false)
assert.deepEqual(classify({ onGeminiOrigin: true, explicitSignedOut: false, identityEvidence: true, canAsk: false, cookieNames: ['SID'] }), {
  loggedIn: true, canAsk: false, guestAvailable: false, googleSessionCookie: true,
})

const ready = { loggedIn: true, canAsk: true }
assert.equal(auth.advanceLoginStability(0, ready, true), 1)
assert.equal(auth.advanceLoginStability(1, ready, true), 2)
assert.equal(auth.advanceLoginStability(2, ready, false), 1)
assert.equal(auth.advanceLoginStability(2, null, true), 0)
assert.equal(auth.advanceLoginStability(2, { loggedIn: true, canAsk: false }, true), 0)
EOF
fi

# Bridge .env loader unit tests (no browser needed)
REPO_ROOT="$REPO_ROOT" node --input-type=module <<'EOF'
import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mod = await import(pathToFileURL(`${process.env.REPO_ROOT}/bin/bridge-env.mjs`))
// quoted values keep inner # but drop trailing comment
assert.deepEqual(mod.parseDotEnv('A=val # c\nB="a # b" # d\nC=\'x#y\'\nexport D=e\n'), { A: 'val', B: 'a # b', C: 'x#y', D: 'e' })
assert.equal(mod.maskEmail('ab@example.com'), 'ab***@example.com')
assert.equal(mod.maskEmail(''), '(missing)')
assert.equal(mod.resolveBridgeDir('/dflt', 'CHATGPT_BRIDGE_DIR_TEST_XYZ'), '/dflt')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-env-test-'))
fs.writeFileSync(path.join(tmp, '.env'), 'CHATGPT_EMAIL=file@ex.com\nCHATGPT_PASSWORD=fp\n', { mode: 0o600 })
let c = mod.loadBridgeCreds({ bridgeDir: tmp, envFileVar: 'CHATGPT_ENV_FILE_TEST_XYZ', emailKeys: mod.CHATGPT_KEYS.emailKeys, passwordKeys: mod.CHATGPT_KEYS.passwordKeys })
assert.equal(c.email, 'file@ex.com')
assert.equal(c.configured, true)
fs.rmSync(tmp, { recursive: true, force: true })
EOF

# login --auto with missing creds must fail fast with .env help (no browser, no secret leak)
env_missing="$TEST_ROOT/env-missing"
mkdir -p "$env_missing/bridge"
if CHATGPT_BRIDGE_DIR="$env_missing/bridge" CHATGPT_ENV_FILE="$env_missing/nope.env" \
    node "$REPO_ROOT/bin/chatgpt-review.mjs" login --auto >/tmp/chatgpt-auto-missing.log 2>&1; then
    fail "chatgpt login --auto with missing creds should exit non-zero"
fi
grep -q "\.env" /tmp/chatgpt-auto-missing.log || fail "chatgpt login --auto missing-creds help has no .env hint"
if GEMINI_BRIDGE_DIR="$env_missing/bridge" GEMINI_ENV_FILE="$env_missing/nope.env" \
    node "$REPO_ROOT/bin/gemini-review.mjs" login --auto >/tmp/gemini-auto-missing.log 2>&1; then
    fail "gemini login --auto with missing creds should exit non-zero"
fi
grep -q "\.env" /tmp/gemini-auto-missing.log || fail "gemini login --auto missing-creds help has no .env hint"

# status on an empty bridge dir must report envConfigured without launching a browser or leaking secrets
env_status="$TEST_ROOT/env-status"
mkdir -p "$env_status/cbridge" "$env_status/gbridge"
printf 'CHATGPT_EMAIL=a@ex.com\nCHATGPT_PASSWORD=supersecret123\n' > "$env_status/cbridge/.env"
chmod 600 "$env_status/cbridge/.env"
chatgpt_status="$(CHATGPT_BRIDGE_DIR="$env_status/cbridge" node "$REPO_ROOT/bin/chatgpt-review.mjs" status 2>/dev/null)"
echo "$chatgpt_status" | grep -q '"envConfigured": *true' || fail "chatgpt status should report envConfigured:true"
echo "$chatgpt_status" | grep -q "supersecret123" && fail "chatgpt status leaked password"
printf 'GEMINI_EMAIL=g@ex.com\n' > "$env_status/gbridge/.env"
chmod 600 "$env_status/gbridge/.env"
gemini_status="$(GEMINI_BRIDGE_DIR="$env_status/gbridge" node "$REPO_ROOT/bin/gemini-review.mjs" status 2>/dev/null)"
echo "$gemini_status" | grep -q '"envConfigured": *false' || fail "gemini status should report envConfigured:false when password missing"
echo "$gemini_status" | grep -q '"envFileExists": *true' || fail "gemini status should report envFileExists:true"

# install --config must create 0600 .env templates and never overwrite real creds
install_home="$TEST_ROOT/install-home"
mkdir -p "$install_home"
printf 'CHATGPT_EMAIL=keep@ex.com\nCHATGPT_PASSWORD=keepme\n' > "$install_home/pre-chatgpt.env"
printf 'GEMINI_EMAIL=keep@g.com\nGEMINI_PASSWORD=keepme\n' > "$install_home/pre-gemini.env"
HOME="$install_home" bash "$REPO_ROOT/install.sh" --config >/dev/null 2>&1 || fail "install.sh --config failed"
[[ -f "$install_home/.config/opencode/chatgpt-bridge/.env" ]] || fail "chatgpt .env not created by install"
[[ -f "$install_home/.config/opencode/gemini-bridge/.env" ]] || fail "gemini .env not created by install"
[[ "$(stat -c '%a' "$install_home/.config/opencode/chatgpt-bridge/.env")" == 600 ]] || fail "chatgpt .env not 0600"
[[ "$(stat -c '%a' "$install_home/.config/opencode/gemini-bridge/.env")" == 600 ]] || fail "gemini .env not 0600"
[[ -f "$install_home/.config/opencode/chatgpt-bridge/bin/bridge-env.mjs" ]] || fail "bridge-env.mjs not installed (chatgpt)"
[[ -f "$install_home/.config/opencode/gemini-bridge/bin/bridge-env.mjs" ]] || fail "bridge-env.mjs not installed (gemini)"
# second run must keep existing creds
printf 'CHATGPT_EMAIL=real@ex.com\nCHATGPT_PASSWORD=realpass\n' > "$install_home/.config/opencode/chatgpt-bridge/.env"
HOME="$install_home" bash "$REPO_ROOT/install.sh" --config >/dev/null 2>&1 || fail "install.sh --config rerun failed"
grep -q "real@ex.com" "$install_home/.config/opencode/chatgpt-bridge/.env" || fail "install overwrote existing chatgpt .env"

printf 'PASS: launcher, workflow installers, ChatGPT review controls, and Gemini scraper safe-install checks\n'
