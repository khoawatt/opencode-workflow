#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, writeSync, closeSync, unlinkSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { loadBridgeCreds, credsHelp, maskEmail, resolveBridgeDir, CHATGPT_KEYS } from './bridge-env.mjs'
const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch { try { const r2=createRequire(join(homedir(),'.config/opencode/chatgpt-bridge/package.json')); ({ chromium } = r2('playwright')) } catch { const r3=createRequire(join(homedir(),'.config/opencode/gemini-bridge/package.json')); ({ chromium } = r3('playwright')) } }

const HOME = homedir()
const BRIDGE_DIR = resolveBridgeDir(join(HOME, '.config/opencode/chatgpt-bridge'), 'CHATGPT_BRIDGE_DIR')
const PROFILE_DIR = join(BRIDGE_DIR, 'profile')
const LIB_DIR = join(BRIDGE_DIR, 'libs')
const STATE_FILE = join(BRIDGE_DIR, 'chats.json')
const CONFIG_FILE = join(BRIDGE_DIR, 'bridge-config.json')
const PROJECTS_FILE = join(BRIDGE_DIR, 'projects.json')
const LOCK_FILE = join(BRIDGE_DIR, '.lock')

process.env.LD_LIBRARY_PATH = `${LIB_DIR}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`

function resolveChromium() {
  // Prefer the Playwright-bundled chromium (version-agnostic).
  try {
    const p = chromium.executablePath()
    if (p && existsSync(p)) return p
  } catch {}
  // Fallback: find any ms-playwright chromium build in the user cache.
  const cacheRoot = join(HOME, '.cache', 'ms-playwright')
  try {
    const dirs = readdirSync(cacheRoot).sort().reverse()
    for (const d of dirs) {
      if (!d.startsWith('chromium-')) continue
      const candidates = [
        join(cacheRoot, d, 'chrome-linux', 'chrome'),
        join(cacheRoot, d, 'chrome-linux64', 'chrome'),
        join(cacheRoot, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(cacheRoot, d, 'chrome-win', 'chrome.exe'),
      ]
      for (const c of candidates) {
        if (existsSync(c)) return c
      }
    }
  } catch {}
  throw new Error('Chromium not found. Run: npm exec playwright install chromium  (or: ~/.config/opencode/chatgpt-bridge/install.sh)')
}

let _executable = null
function getExecutable() {
  if (!_executable) _executable = resolveChromium()
  return _executable
}
const CHAT_URL = 'https://chatgpt.com/'

const args = process.argv.slice(2)
const mode = args[0]

const PROMPT_SELECTORS = [
  '#prompt-textarea',
  '[id="prompt-textarea"]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea[data-id="prompt-textarea"]',
  'div[data-testid="prompt-textarea"]',
  '#prompt-input',
]
const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  '[data-testid="composer-send-button"]',
  'button[aria-label*="Send"]',
  'button[data-testid="send-button"]',
  '[aria-label="Send prompt"]',
]
const STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  '[data-testid="composer-stop-button"]',
  'button[aria-label*="Stop"]',
]
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]'
const NEW_CHAT_SELECTORS = [
  '[data-testid="create-new-chat"]',
  'a[href="/"]',
  'button[aria-label*="New chat"]',
  '[data-testid="sidebar-create-new-chat-button"]',
  'button[aria-label*="Close sidebar"]',
]

const DEFAULT_CONFIG = { mode: 'single', max_chars: 400000, max_turns: 40, max_age_hours: 48, project_mode: {} }
const allowedVerdicts = new Set(['approve', 'approve-with-changes', 'request-changes', 'reject'])

const NEW_PROJECT_BTN_SELECTORS = ['button[aria-label="New project"]']
const PROJECT_NAME_INPUT = '#project-name, input[name="projectName"]'
const CREATE_PROJECT_BTN_SELECTORS = [
  '[data-testid="create-new-project-form"] button[type="submit"]',
  'button:has-text("Create project")',
  '[data-testid="modal-new-project-enhanced"] button:has-text("Create project")',
]

function usage() {
  console.error(`
 chatgpt-review bridge - sends a prompt to ChatGPT Plus (web) and reads the reply.
Reuses one conversation per repo+branch; creates a new one when the context gets long.

USAGE:
  chatgpt-review.mjs login [--auto] [--switch] [--wait=SECONDS]   Sign in (manual once, or --auto from .env).
  chatgpt-review.mjs ask            Read prompt from stdin (or --file=FILE), send to ChatGPT, print reply.
  chatgpt-review.mjs status         Check whether a signed-in profile exists.
  chatgpt-review.mjs chats          List per-repo conversation state.
  chatgpt-review.mjs reset          Drop the saved conversation mapping for the current repo+branch.
  chatgpt-review.mjs approval       Get/set/clear the review approval state (get|set <verdict> <sha>|clear).
  chatgpt-review.mjs project        Manage ChatGPT Projects (create/list/attach/detach/resolve).
  chatgpt-review.mjs projects       Alias for "project list".
  chatgpt-review.mjs sources        Manage Project Sources ZIP sync (hybrid .git + metadata)
  chatgpt-review.mjs src            Alias for "sources"
  chatgpt-review.mjs src-sync       Alias for "sources sync --force" (active manual sync)
  chatgpt-review.mjs src-status     Alias for "sources status"

LOGIN OPTIONS:
  --auto / --from-env / --env   Sign in automatically with credentials from .env (no manual typing).
  --switch              Keep browser open to switch account (waits for session token to change; does not auto-close if already logged in).
  --wait=SECONDS        After a new login is detected, keep browser open for SECONDS (default 0; implies --switch).
  --keep-open / --stay-open   Alias for --switch.
  --headless / --headful       Browser visibility for login (default headful; headless may hit Cloudflare).
  --timeout=SECONDS     Max seconds to wait for auto-login (default 120).

OPTIONS (for ask):
  --file=FILE        Read the prompt from FILE instead of stdin.
  --timeout=SECONDS  Max seconds to wait for the reply (default 300).
  --new              Force a new conversation (drop the saved mapping) for this repo+branch.
  --project          Use (or create) a ChatGPT Project for this repo's reviews.
  --no-project       Force plain single-chat mode for this call.
  --no-auto-login    Do NOT attempt .env auto-login when the session is missing (default: auto-try if configured).
  --headless         Try headless mode (may be blocked by Cloudflare; default headful).
  --headful          Always show the browser window (default).

ENV FILE (~/.config/opencode/chatgpt-bridge/.env, mode 600, never committed):
  CHATGPT_EMAIL=you@example.com
  CHATGPT_PASSWORD=your-password
  # aliases: OPENAI_EMAIL / OPENAI_PASSWORD. Shell env overrides the file.
  # Google-linked ChatGPT accounts: login goes through Google OAuth, so
  # CHATGPT_PASSWORD must be the GOOGLE account password.
  # Custom path: CHATGPT_ENV_FILE=/path/to/.env chatgpt-review login --auto

CONFIG (bridge-config.json):
  mode              "single" (default) or "project" — global default for all repos.
  project_mode      { "<repoName>": true } — enable projects per repo, overrides mode.
  max_chars / max_turns / max_age_hours — create a new chat when any threshold is reached.
`)
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ---------- cross-process lock (serialize bridge runs: 1 Chrome profile) ----------

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function acquireLock(timeoutSec = 300) {
  mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + timeoutSec * 1000
  while (true) {
    try {
      const fd = openSync(LOCK_FILE, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    // Lock exists: is the owner still alive? If not, clear stale lock.
    let ownerPid = null
    try { ownerPid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10) } catch {}
    if (ownerPid && !pidAlive(ownerPid)) {
      try { unlinkSync(LOCK_FILE) } catch {}
      continue
    }
    if (Date.now() > deadline) {
      throw new Error(`another chatgpt-review is running (pid=${ownerPid || '?'}); timed out after ${timeoutSec}s waiting for the lock`)
    }
    console.error(`[bridge] waiting for lock (pid=${ownerPid || '?'})…`)
    // synchronous sleep (no async in this path)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE) } catch {}
}

// ---------- state / config ----------

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function saveJson(path, value) {
  mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function normalizeState(value) {
  return value && typeof value === 'object' && value.chats && typeof value.chats === 'object'
    ? value
    : { chats: {} }
}

function loadChats() {
  return normalizeState(loadJson(STATE_FILE, { chats: {} }))
}

function saveChats(chats) {
  saveJson(STATE_FILE, chats)
}

function repoContext() {
  let root = process.cwd()
  let branch = 'default'
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
  let identity = root
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const match = remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i)
    if (match) identity = match[1]
  } catch {}
  return {
    root,
    name: basename(root),
    branch,
    identity,
    key: `${identity}:${branch}`,
    legacy_key: `${basename(root)}:${branch}`,
  }
}

function repoKey() {
  return repoContext().key
}

function isStale(chat, config) {
  if (!chat) return true
  const now = Date.now()
  if (chat.turns >= config.max_turns) return true
  if (chat.chars >= config.max_chars) return true
  if (chat.lastUsedAt && now - chat.lastUsedAt > config.max_age_hours * 3600 * 1000) return true
  return false
}

function chatIdFromUrl(url) {
  const m = url.match(/\/c\/([0-9a-f-]{8,})/)
  return m ? m[1] : null
}

function repoName() {
  return repoContext().name
}

function loadProjects() {
  const value = loadJson(PROJECTS_FILE, { projects: {} })
  return value && typeof value === 'object' && value.projects && typeof value.projects === 'object'
    ? value
    : { projects: {} }
}

function saveProjects(projects) {
  saveJson(PROJECTS_FILE, projects)
}

function projectEnabledForRepo(config, repo) {
  if (config.mode === 'project') return true
  if (config.project_mode && config.project_mode[repo] === true) return true
  return false
}

function projectUrl(project) {
  return `https://chatgpt.com/g/${project.slug}/project`
}

async function listProjectsFromWeb(page) {
  // Prefer direct fetch (reliable, no race) — page has auth cookies
  try {
    const data = await page.evaluate(async () => {
      const r = await fetch('/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=5&limit=20', {
        credentials: 'include',
      })
      if (!r.ok) throw new Error('sidebar fetch ' + r.status)
      return r.json()
    })
    if (data && Array.isArray(data.items)) {
      const items = data.items
        .map((i) => {
          const g = i.gizmo && i.gizmo.gizmo
          return {
            id: g && g.id,
            slug: g && g.short_url,
            name: g && g.display && g.display.name,
          }
        })
        .filter((p) => p.id)
      return items
    }
  } catch (e) {
    console.error('[bridge] direct sidebar fetch failed:', e.message, '— falling back to response capture')
  }

  // Fallback: capture the in-page response (older method)
  const captureOnce = () =>
    new Promise((resolve) => {
      const handler = async (r) => {
        const u = r.url()
        if (u.includes('/backend-api/gizmos/snorlax/sidebar')) {
          try {
            const j = await r.json()
            page.off('response', handler)
            resolve(j)
          } catch {}
        }
      }
      page.on('response', handler)
      setTimeout(() => {
        page.off('response', handler)
        resolve(null)
      }, 20000)
    })
  if (!page.url().includes('chatgpt.com')) await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // First try: if a sidebar response is already in-flight, capture it
  let data = await captureOnce()
  if (!data) {
    // Second try: start listening BEFORE navigating so we don't miss the request
    const secondCapture = captureOnce()
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await handleCloudflare(page)
    // Give the app time to fire the request while listener is active
    data = await secondCapture
    if (!data) {
      // Last resort: force reload
      const thirdCapture = captureOnce()
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
      await handleCloudflare(page)
      data = await thirdCapture
    }
  }
  if (!data) throw new Error('could not fetch projects list from ChatGPT web')
  const items = (data.items || [])
    .map((i) => {
      const g = i.gizmo && i.gizmo.gizmo
      return {
        id: g && g.id,
        slug: g && g.short_url,
        name: g && g.display && g.display.name,
      }
    })
    .filter((p) => p.id)
  return items
}

async function findProjectId(page, name) {
  const projects = await listProjectsFromWeb(page)
  const hit = projects.find(p => (p.name || '').toLowerCase() === String(name).toLowerCase())
  return hit || null
}

async function createProject(page, name) {
  // Ensure sidebar is open — the New project button lives in the expanded sidebar header
  // and the click is ignored when the sidebar is collapsed (repro: dbg3 vs dbg4).
  try {
    const openBtn = page.locator('button[aria-label="Open sidebar"]').first()
    if (await openBtn.count()) {
      const state = await page.locator('#stage-slideover-sidebar').getAttribute('data-state').catch(() => null)
      // data-state="closed" means collapsed; click to expand
      if (state === 'closed' || (await openBtn.isVisible().catch(() => false))) {
        // Only click if the New project button is not yet visible/interactable
        const newProjVisible = await page
          .locator(NEW_PROJECT_BTN_SELECTORS.join(', '))
          .first()
          .isVisible()
          .catch(() => false)
        if (!newProjVisible) {
          await openBtn.click({ force: true })
          await page.waitForTimeout(1500)
        } else if (state === 'closed') {
          // Even if visible in DOM, the collapsed rail may intercept clicks — expand anyway
          await openBtn.click({ force: true })
          await page.waitForTimeout(1200)
        }
      }
    }
  } catch {}

  const btn = page.locator(NEW_PROJECT_BTN_SELECTORS.join(', ')).first()
  if (await btn.count()) {
    await btn.click({ force: true })
  } else {
    throw new Error('New project button not found')
  }
  // Wait for the create form to appear — ChatGPT animates the dialog
  let input = null
  for (let i = 0; i < 15; i++) {
    input = page.locator(PROJECT_NAME_INPUT).first()
    if (await input.count()) break
    // Fallback: also check inside the dedicated form container
    input = page.locator('[data-testid="create-new-project-form"] input').first()
    if (await input.count()) break
    await page.waitForTimeout(500)
  }
  input = page.locator(PROJECT_NAME_INPUT).first()
  if (await input.count() === 0) {
    input = page.locator('[data-testid="create-new-project-form"] input').first()
  }
  if (!(await input.count())) throw new Error('project name input not found')
  await input.fill(String(name))
  await page.waitForTimeout(300)
  let clicked = false
  for (const sel of CREATE_PROJECT_BTN_SELECTORS) {
    const b = page.locator(sel).first()
    if (await b.count()) {
      await b.click()
      clicked = true
      break
    }
  }
  if (!clicked) {
    await input.press('Enter')
  }
  await page.waitForTimeout(4000)
  const found = await findProjectId(page, name)
  if (found) return found
  throw new Error(`project created but could not resolve its id`)
}

async function resolveProject(page, repo, config, opts) {
  // Returns { id, slug, name } or null. May create a project if auto-create allowed.
  const projects = loadProjects()
  const saved = projects.projects[repo]
  if (!opts.recheck) {
    if (saved && saved.slug) return { ...saved }
  }
  const found = await findProjectId(page, repo)
  if (found) {
    projects.projects[repo] = { id: found.id, slug: found.slug, name: found.name, createdAt: Date.now() }
    saveProjects(projects)
    return { ...found }
  }
  if (opts.create) {
    const created = await createProject(page, repo)
    projects.projects[repo] = { id: created.id, slug: created.slug, name: created.name, createdAt: Date.now() }
    saveProjects(projects)
    return { ...created }
  }
  return null
}

async function gotoProject(page, project) {
  const url = projectUrl(project)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await handleCloudflare(page)
  const ok = await waitForInput(page, 12)
  const finalUrl = page.url()
  if (!ok) return false
  return finalUrl.includes('/project')
}

// ---------- browser ----------

async function isLoggedIn(page) {
  try {
    const cookies = await page.context().cookies('https://chatgpt.com/')
    return cookies.some(c => c.name.startsWith('__Secure-next-auth.session-token'))
  } catch {
    return false
  }
}

async function launchPersistent(headful) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: getExecutable(),
    headless: !headful,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  })
  return ctx
}

// ---------- env credentials + auto-login (no manual typing) ----------

function loadChatgptCreds() {
  return loadBridgeCreds({
    bridgeDir: BRIDGE_DIR,
    envFileVar: 'CHATGPT_ENV_FILE',
    emailKeys: CHATGPT_KEYS.emailKeys,
    passwordKeys: CHATGPT_KEYS.passwordKeys,
  })
}

async function hasRealBox(el) {
  try {
    const box = await el.boundingBox()
    return !!box && box.width >= 2 && box.height >= 2
  } catch {
    return false
  }
}

async function fillFirstVisible(page, selectors, value, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel)
        const n = await loc.count()
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i)
          try {
            if (!(await hasRealBox(el))) continue
            if (!(await el.isVisible().catch(() => false))) continue
            await el.click({ timeout: 2000 }).catch(() => {})
            await el.fill(value, { timeout: 5000 })
            return sel
          } catch {}
        }
      } catch {}
    }
    await sleep(500)
  }
  return null
}

async function clickFirstVisible(page, selectors, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel)
        const n = await loc.count()
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i)
          try {
            if (!(await hasRealBox(el))) continue
            if (!(await el.isVisible().catch(() => false))) continue
            await el.click({ timeout: 3000 })
            return sel
          } catch {}
        }
      } catch {}
    }
    await sleep(500)
  }
  return null
}

async function pageBodyText(page) {
  try {
    return String(await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '')).toLowerCase()
  } catch {
    return ''
  }
}

function detectChatgptBlocker(bodyText, url) {
  if (!bodyText) return null
  if (/wrong (email|password)|incorrect.*password|invalid.*credentials|wrong.*credentials/.test(bodyText)) {
    return 'ChatGPT báo sai email/password — kiểm tra lại .env rồi thử lại.'
  }
  if (/verify you are human|captcha|challenge|unusual activity|suspicious|verify.*identity/.test(bodyText)) {
    return 'ChatGPT yêu cầu xác minh người thật (CAPTCHA/Cloudflare) — hoàn thành 1 lần bằng `login` thủ công, các lần sau dùng session đã lưu.'
  }
  if (/two-?factor|2fa|multi-?factor|mfa|authenticator|verification code|check your email|we sent you|enter.*code/.test(bodyText)) {
    return 'Tài khoản bật 2FA/mã xác minh qua email — auto-login không thể tự qua bước này. Đăng nhập thủ công 1 lần (`login`), session sẽ được tái dùng.'
  }
  if (/this browser or app may not be secure|browser.*not.*secure|couldn.t sign you in/.test(bodyText)) {
    return 'ChatGPT/Google chặn trình duyệt tự động — đăng nhập thủ công 1 lần (`login`) để lưu session.'
  }
  if (/rate.?limit|too many (attempts|requests)|try again later/.test(bodyText)) {
    return 'Bị giới hạn số lần đăng nhập — đợi vài phút rồi thử lại.'
  }
  if (url.includes('__cf_chl') || url.includes('challenges.cloudflare')) {
    return 'Đang kẹt ở Cloudflare challenge — thử lại ở môi trường có display (headful) hoặc login thủ công 1 lần.'
  }
  return null
}

// Auth0 may render this generic 400 when the login transaction is stale,
// expired, or resumed with mismatched transaction state.
const isAuth0ErrorPage = (bodyText) =>
  /oops,? an error occurred|route error|invalid content type/.test(bodyText || '')

// Drop only Auth0/OpenAI auth transaction cookies. Keep the persistent browser
// profile and unrelated cookies so Google/ChatGPT sessions are not wiped.
async function clearAuthTransaction(page) {
  try {
    if (page.isClosed && page.isClosed()) return
    const ctx = page.context()
    const all = await ctx.cookies()
    for (const cookie of all) {
      const domain = cookie.domain || ''
      const name = cookie.name || ''
      if (/auth0|auth\.openai/i.test(domain) || /^auth0/i.test(name)) {
        try {
          await ctx.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path })
        } catch {}
      }
    }
  } catch {}
}

async function restartChatgptLoginFlow(page) {
  if (page.isClosed && page.isClosed()) throw new Error('browser/page already closed')
  await clearAuthTransaction(page)
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await handleCloudflare(page)
}

const CHATGPT_LOGIN_BTN = [
  'button[data-testid="login-button"]',
  'a[data-testid="login-button"]',
  // Exact text first: :has-text() also matches zero-size parents/children,
  // so exact match avoids the hidden duplicates on the landing page.
  'button:text-is("Log in")',
  'a:text-is("Log in")',
  'button:has-text("Log in")',
  'a:has-text("Log in")',
  '[data-testid="login-link"]',
]
const CHATGPT_EMAIL_INPUT = [
  'input[type="email"]',
  'input[name="username"]',
  'input[name="email"]',
  '#email-input',
  'input[id*="email"]',
  'input[autocomplete="username"]',
]
const CHATGPT_PASSWORD_INPUT = [
  'input[type="password"]',
  'input[name="password"]',
  '#password',
  'input[autocomplete="current-password"]',
]
const CHATGPT_CONTINUE_BTN = [
  'button[type="submit"]',
  'button:has-text("Continue")',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
]

// Fill the first real (non-zero-size, visible) field matching selectors, then
// submit via the button in the SAME form (avoids hitting unrelated submits on
// pages that contain several forms, e.g. the chatgpt.com landing page).
async function fillFieldAndSubmit(page, selectors, value, fallbackBtns, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      for (const sel of selectors) {
        const loc = page.locator(sel)
        const n = await loc.count()
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i)
          try {
            if (!(await hasRealBox(el))) continue
            if (!(await el.isVisible().catch(() => false))) continue
            await el.click({ timeout: 2000 }).catch(() => {})
            await el.fill(value, { timeout: 5000 })
            await page.waitForTimeout(400)
            // Scoped submit: button in the same form as the filled field.
            try {
              const scoped = el.locator('xpath=ancestor::form//button[@type="submit"]').first()
              if ((await scoped.count()) > 0 && (await hasRealBox(scoped)) && (await scoped.isVisible().catch(() => false))) {
                await scoped.click({ timeout: 3000 })
                return true
              }
            } catch {}
            // Fallback: generic continue buttons.
            if (await clickFirstVisible(page, fallbackBtns, 4000)) return true
            return true // filled at least; page may auto-advance
          } catch {}
        }
      }
    } catch {}
    await sleep(500)
  }
  return false
}

async function anyRealVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel)
      const n = await loc.count()
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i)
        if ((await hasRealBox(el)) && (await el.isVisible().catch(() => false))) return true
      }
    } catch {}
  }
  return false
}

const GOOGLE_ID_INPUT = [
  '#identifierId',
  'input[name="identifier"]',
  'input[autocomplete*="username"]',
]
const GOOGLE_ID_NEXT = [
  '#identifierNext',
  'button:text-is("Next")',
  'button:has-text("Next")',
]
const GOOGLE_PW_INPUT = [
  'input[name="Passwd"]',
  'input[type="password"]',
]
const GOOGLE_PW_NEXT = [
  '#passwordNext',
  'button:text-is("Next")',
  'button:has-text("Next")',
]
const GOOGLE_ALLOW_BTN = [
  '#submit_approve_access',
  'button:text-is("Allow")',
  'button:text-is("Continue")',
]
const OPENAI_CODE_INPUT = [
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
]

// Fill email+password from .env and submit. Handles three login shapes:
//  1. chatgpt.com "Log in" modal (email) → 2a or 2b
//  2a. auth.openai.com password screen (email+password accounts)
//  2b. Google OAuth (Google-linked accounts): identifier → password → consent
// Throws with a human-readable message when a manual step is required.
async function tryAutoLoginChatGPT(page, creds, { timeoutSec = 150 } = {}) {
  if (await isLoggedIn(page)) return true
  console.error(`[bridge] auto-login as ${maskEmail(creds.email)} (from ${creds.emailSource === 'env' ? 'env' : creds.envPath})…`)
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await handleCloudflare(page)

  for (let i = 0; i < 5; i++) {
    if (await isLoggedIn(page)) return true
    await sleep(1000)
  }

  const onGoogle = () => page.url().includes('accounts.google.com')
  const onAuthHost = () => /auth\.openai\.com|auth0\.com|accounts\.openai\.com/.test(page.url())
  const deadline = Date.now() + timeoutSec * 1000
  let acted = false // set once we submitted any credential (gates blocker aborts)
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true
    const url = page.url()
    const body = await pageBodyText(page)

    if (isAuth0ErrorPage(body)) {
      console.error('[bridge] trang lỗi Auth0 (Route Error / transaction hỏng) — xóa auth transaction và bắt đầu lại login flow…')
      acted = false
      try {
        await restartChatgptLoginFlow(page)
      } catch (e) {
        throw new Error(`Không thể restart ChatGPT login flow sau Auth0 Route Error: ${e.message}`)
      }
      await sleep(1500)
      continue
    }

    // Email-code screen (unknown email): prefer password login when offered.
    if (await anyRealVisible(page, OPENAI_CODE_INPUT)) {
      const pwOpt = page.locator('button:text-is("Continue with password")').first()
      try {
        if ((await pwOpt.count()) > 0 && (await hasRealBox(pwOpt))) {
          console.error('[bridge] email-code screen — switching to password login…')
          await pwOpt.click({ timeout: 3000 })
          acted = true
          await page.waitForTimeout(2500)
          continue
        }
      } catch {}
      throw new Error('ChatGPT gửi mã xác minh về email (tài khoản chưa có password) — nhập mã thủ công 1 lần (`login`), hoặc bấm "Continue with password" trong bản web. Auto-login không đọc được inbox.')
    }

    const blocker = detectChatgptBlocker(body, url)
    if (blocker && acted) throw new Error(blocker)

    if (onGoogle()) {
      // Google consent screen (has Allow button) takes precedence — the
      // identifier page also mentions "continue to OpenAI".
      if (await anyRealVisible(page, GOOGLE_ALLOW_BTN)) {
        console.error('[bridge] Google consent — approving…')
        await clickFirstVisible(page, GOOGLE_ALLOW_BTN, 5000)
        acted = true
        await page.waitForTimeout(3000)
        continue
      }
      if (await anyRealVisible(page, GOOGLE_PW_INPUT)) {
        console.error('[bridge] Google password screen…')
        if (await fillFieldAndSubmit(page, GOOGLE_PW_INPUT, creds.password, GOOGLE_PW_NEXT, 8000)) acted = true
        await page.waitForTimeout(3000)
        continue
      }
      if (await anyRealVisible(page, GOOGLE_ID_INPUT)) {
        console.error('[bridge] Google identifier screen…')
        if (await fillFieldAndSubmit(page, GOOGLE_ID_INPUT, creds.email, GOOGLE_ID_NEXT, 8000)) acted = true
        await page.waitForTimeout(3000)
        continue
      }
      await sleep(2000)
      continue
    }

    if (onAuthHost()) {
      if (await anyRealVisible(page, CHATGPT_PASSWORD_INPUT)) {
        console.error('[bridge] ChatGPT password screen…')
        if (await fillFieldAndSubmit(page, CHATGPT_PASSWORD_INPUT, creds.password, CHATGPT_CONTINUE_BTN, 8000)) acted = true
        await page.waitForTimeout(3000)
        await handleCloudflare(page)
        continue
      }
      if (await anyRealVisible(page, CHATGPT_EMAIL_INPUT)) {
        if (await fillFieldAndSubmit(page, CHATGPT_EMAIL_INPUT, creds.email, CHATGPT_CONTINUE_BTN, 6000)) acted = true
        await page.waitForTimeout(2500)
        continue
      }
      await sleep(2000)
      continue
    }

    // chatgpt.com landing / login modal.
    if (await anyRealVisible(page, CHATGPT_EMAIL_INPUT)) {
      console.error('[bridge] login modal — submitting email…')
      if (await fillFieldAndSubmit(page, CHATGPT_EMAIL_INPUT, creds.email, CHATGPT_CONTINUE_BTN, 6000)) acted = true
      await page.waitForTimeout(2500)
      await handleCloudflare(page)
      continue
    }
    await clickFirstVisible(page, CHATGPT_LOGIN_BTN, 4000)
    await page.waitForTimeout(2000)
    await handleCloudflare(page)
  }
  const lastUrl = page.url()
  const lastBody = (await pageBodyText(page)).slice(0, 200)
  const finalBlocker = detectChatgptBlocker(await pageBodyText(page), lastUrl)
  throw new Error(finalBlocker || `Timed out after ${timeoutSec}s waiting for ChatGPT login as ${maskEmail(creds.email)} (last url: ${lastUrl.slice(0, 80)} — "${lastBody}"). Kiểm tra email/password trong .env hoặc đăng nhập thủ công 1 lần: chatgpt-review login`)
}

// Shared by `ask`/`project`: reuse session, else auto-login from .env when
// available (unless --no-auto-login). Returns true when logged in.
async function ensureChatgptLoggedIn(page, { allowAuto = true } = {}) {
  for (let i = 0; i < 6; i++) {
    if (await isLoggedIn(page)) return true
    await sleep(1000)
  }
  if (!allowAuto) return false
  const creds = loadChatgptCreds()
  for (const w of creds.warnings) console.error(`[bridge] WARN: ${w}`)
  if (!creds.configured) return false
  console.error(`[bridge] session hết hạn — tự đăng nhập lại từ .env (${maskEmail(creds.email)})…`)
  try {
    await tryAutoLoginChatGPT(page, creds)
    return await isLoggedIn(page)
  } catch (e) {
    console.error(`[bridge] auto-login thất bại: ${e.message}`)
    return false
  }
}

async function handleCloudflare(page) {
  for (let i = 0; i < 60; i++) {
    const url = page.url()
    if (!url.includes('__cf_chl') && !url.includes('challenges.cloudflare')) {
      return
    }
    await sleep(2000)
  }
}

async function newChat(page) {
  for (const sel of NEW_CHAT_SELECTORS) {
    const btn = page.locator(sel).first()
    if (await btn.count()) {
      try { await btn.click({ timeout: 3000 }); return } catch {}
    }
  }
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' })
}

async function findInput(page) {
  for (const sel of PROMPT_SELECTORS) {
    const loc = page.locator(sel).first()
    if (await loc.count()) return loc
  }
  return null
}

async function waitForInput(page, loops = 15) {
  for (let i = 0; i < loops; i++) {
    if (await findInput(page)) return true
    await sleep(2000)
  }
  return false
}

async function gotoConversation(page, id) {
  const url = `https://chatgpt.com/c/${id}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await handleCloudflare(page)
  await waitForInput(page, 10)
  const finalUrl = page.url()
  return finalUrl.includes(`/c/${id}`)
}

async function typePrompt(page, text) {
  const input = await findInput(page)
  if (!input) throw new Error('prompt textarea not found; ChatGPT UI may have changed or login required')
  await input.click()
  await input.fill(text)
  await sleep(500)
  return input
}

async function clickSend(page) {
  for (const sel of SEND_SELECTORS) {
    const btn = page.locator(sel).first()
    if (await btn.count()) {
      await btn.click()
      return true
    }
  }
  const input = await findInput(page)
  if (input) {
    await input.press('Enter')
    return true
  }
  return false
}

async function waitForReply(page, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const stopped = page.locator(STOP_SELECTORS.join(', ')).first()
    const stopCount = await stopped.count()
    if (stopCount === 0) {
      const msgs = page.locator(ASSISTANT_SELECTOR)
      const n = await msgs.count()
      if (n > 0) {
        const last = msgs.nth(n - 1)
        const text = (await last.innerText()) || ''
        if (text.trim().length > 5) {
          const streaming = last.locator('[class*="streaming"], .result-streaming')
          if ((await streaming.count()) === 0) return text
        }
      }
    }
    await sleep(1500)
  }
  throw new Error(`timeout after ${timeoutSec}s waiting for ChatGPT reply`)
}

// ---------- commands ----------

async function doLogin() {
  const loginArgs = args.slice(1)
  const has = (flag) => loginArgs.includes(flag)
  const waitArg = loginArgs.find((a) => a.startsWith('--wait='))
  const autoMode = has('--auto') || has('--from-env') || has('--env')
  let keepOpenSec = 0
  let switchMode = has('--switch') || has('--stay-open') || has('--keep-open') || !!waitArg
  if (waitArg) {
    const v = parseInt(waitArg.slice(7), 10)
    if (!isNaN(v) && v >= 0) keepOpenSec = v
  } else if (has('--wait') || has('--stay-open') || has('--keep-open')) {
    keepOpenSec = 0
  }
  // --- non-interactive login from .env: no manual typing ---
  if (autoMode) {
    const creds = loadChatgptCreds()
    for (const w of creds.warnings) console.error(`[bridge] WARN: ${w}`)
    if (!creds.configured) {
      console.error(credsHelp({ bridgeLabel: 'ChatGPT', envPath: creds.envPath, emailKeys: CHATGPT_KEYS.emailKeys, passwordKeys: CHATGPT_KEYS.passwordKeys }))
      process.exit(1)
    }
    const timeoutArg = loginArgs.find((a) => a.startsWith('--timeout='))
    const loginTimeout = timeoutArg ? parseInt(timeoutArg.slice(10), 10) || 120 : 120
    const headful = has('--headless') ? false : true
    const ctx = await launchPersistent(headful)
    const page = ctx.pages()[0] || (await ctx.newPage())
    try {
      await tryAutoLoginChatGPT(page, creds, { timeoutSec: loginTimeout })
      console.error('LOGIN OK — session saved (auto-login from .env).')
      await ctx.close()
      return
    } catch (e) {
      console.error(`Auto-login thất bại: ${e.message}`)
      console.error('Fallback: chạy `chatgpt-review login` thủ công 1 lần để lưu session (2FA/CAPTCHA không tự qua được).')
      try { await ctx.close() } catch {}
      process.exit(1)
    }
  }
  const ctx = await launchPersistent(true)
  const page = ctx.pages()[0] || (await ctx.newPage())
  let browserClosed = false
  ctx.on('close', () => {
    browserClosed = true
  })
  // also watch page close (user closes window)
  page.on('close', () => {
    browserClosed = true
  })
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await handleCloudflare(page)
  console.error('Browser opened. Sign in to ChatGPT in the window.')
  if (switchMode) {
    console.error(
      'Switch mode: browser will stay open. If already logged in, log out in the window and sign in with the new account.',
    )
    if (keepOpenSec > 0) {
      console.error(`Waiting for a new session (up to 20 min), then keeping open ${keepOpenSec}s after login...`)
    } else {
      console.error('Waiting for a new session (up to 20 min)... Press Ctrl+C to abort, or close the window to finish.')
    }
  } else {
    console.error('Waiting for a real signed-in session cookie to appear...')
    console.error('Tip: to switch account, run:  chatgpt-review login --switch   (keeps browser open)')
    console.error('Tip: for non-interactive login from .env, run:  chatgpt-review login --auto')
  }

  // capture initial token to detect account change in switch mode
  let initialToken = null
  try {
    const cookies = await page.context().cookies('https://chatgpt.com/')
    const c = cookies.find((c) => c.name.startsWith('__Secure-next-auth.session-token'))
    initialToken = c ? c.value : null
  } catch {}
  const initiallyLoggedIn = !!initialToken
  if (switchMode && initiallyLoggedIn) {
    console.error('[switch] already logged in — waiting for you to log out and log in with the other account...')
  }

  let authRecoveryAttempts = 0
  let authErrNotified = false
  for (let i = 0; i < 600; i++) {
    if (browserClosed) {
      console.error('Browser was closed by user.')
      let tok = null
      try {
        const cookies = await page.context().cookies('https://chatgpt.com/')
        const c = cookies.find((c) => c.name.startsWith('__Secure-next-auth.session-token'))
        tok = c ? c.value : null
      } catch {}
      if (tok) {
        console.error('LOGIN OK — session saved (browser closed).')
        try {
          await ctx.close()
        } catch {}
        return
      }
      console.error('No session cookie found — session not saved.')
      try {
        await ctx.close()
      } catch {}
      process.exit(1)
    }
    try {
      const cookies = await page.context().cookies('https://chatgpt.com/')
      const c = cookies.find((c) => c.name.startsWith('__Secure-next-auth.session-token'))
      const token = c ? c.value : null
      const loggedIn = !!token
      if (loggedIn) {
        if (!switchMode) {
          await sleep(2000)
          console.error('LOGIN OK — session saved.')
          await ctx.close()
          return
        }
        // switch mode: require a new token if we started logged in
        if (initiallyLoggedIn) {
          if (token !== initialToken) {
            console.error('New session detected — LOGIN OK.')
            if (keepOpenSec > 0) {
              console.error(`Keeping browser open for ${keepOpenSec}s so you can verify... (close window to finish early)`)
              for (let w = 0; w < keepOpenSec; w++) {
                if (browserClosed) break
                await sleep(1000)
              }
            } else {
              await sleep(2000)
            }
            console.error('LOGIN OK — session saved.')
            await ctx.close()
            return
          }
          // still same account — keep waiting
        } else {
          // started logged out — any login is success
          if (keepOpenSec > 0) {
            console.error(`Login detected — keeping browser open for ${keepOpenSec}s...`)
            for (let w = 0; w < keepOpenSec; w++) {
              if (browserClosed) break
              await sleep(1000)
            }
          } else {
            await sleep(2000)
          }
          console.error('LOGIN OK — session saved.')
          await ctx.close()
          return
        }
      }
    } catch {}

    // A stale Auth0 transaction never recovers by waiting. In manual login,
    // restart the transaction automatically but keep retries bounded so a
    // persistent server-side problem does not loop forever.
    if (i % 5 === 0 && !browserClosed) {
      try {
        const body = await pageBodyText(page)
        if (isAuth0ErrorPage(body)) {
          if (authRecoveryAttempts < 3) {
            authRecoveryAttempts++
            console.error(`[bridge] Auth0 Route Error — tự restart login flow (lần ${authRecoveryAttempts}/3)…`)
            try {
              await restartChatgptLoginFlow(page)
              authErrNotified = false
              await sleep(1000)
              continue
            } catch (e) {
              console.error(`[bridge] restart login flow thất bại: ${e.message}`)
            }
          }
          if (!authErrNotified) {
            console.error('[bridge] Auth0 vẫn lỗi sau 3 lần recovery — đóng browser rồi chạy `chatgpt-review logout` + `chatgpt-review login` để tạo profile sạch; không F5/back giữa flow.')
            authErrNotified = true
          }
        } else {
          authErrNotified = false
        }
      } catch {}
    }

    await sleep(2000)
  }
  console.error('Timed out waiting for login (20 min). Session not saved.')
  await ctx.close()
  process.exit(1)
}

async function doAsk() {
  let prompt = ''
  let timeoutSec = 300
  let headful = true
  let forceNew = false
  let useProject = null
  let projectArg = null
  let allowAutoLogin = true
  for (const a of args.slice(1)) {
    if (a.startsWith('--file=')) prompt = readFileSync(a.slice(7), 'utf8')
    else if (a.startsWith('--timeout=')) timeoutSec = parseInt(a.slice(10), 10)
    else if (a === '--headless') headful = false
    else if (a === '--new') forceNew = true
    else if (a === '--project') useProject = true
    else if (a === '--no-project') useProject = false
    else if (a === '--no-auto-login') allowAutoLogin = false
    else if (a.startsWith('--project=')) { useProject = true; projectArg = a.slice(10) }
  }
  if (!prompt) {
    prompt = readFileSync(0, 'utf8')
  }
  prompt = prompt.trim()
  if (!prompt) { console.error('empty prompt'); process.exit(1) }

  const config = loadConfig()
  const ctxRepo = repoContext()
  const key = ctxRepo.key
  const legacyKey = ctxRepo.legacy_key
  const repo = ctxRepo.name
  const chats = loadChats()
  let chat = chats.chats[key] || chats.chats[legacyKey]

  if (!forceNew && chat && !isStale(chat, config)) {
    console.error(`[bridge] reusing chat for ${key} (${chat.id}, turns=${chat.turns}, chars=${chat.chars})`)
  } else {
    if (forceNew) console.error(`[bridge] forcing new chat for ${key}`)
    else if (chat) console.error(`[bridge] chat for ${key} is stale (turns=${chat.turns}, chars=${chat.chars}) — starting fresh`)
    chat = null
    delete chats.chats[key]
    if (legacyKey !== key) delete chats.chats[legacyKey]
  }

  const useProjectMode = useProject === null ? projectEnabledForRepo(config, repo) : useProject
  if (useProjectMode) console.error(`[bridge] project mode ON for ${repo}`)

  const ctx = await launchPersistent(headful)
  const page = ctx.pages()[0] || await ctx.newPage()
  try {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await handleCloudflare(page)

    const loggedIn = await ensureChatgptLoggedIn(page, { allowAuto: allowAutoLogin })
    if (!loggedIn) {
      const creds = loadChatgptCreds()
      const hint = creds.configured
        ? 'Auto-login từ .env thất bại — thử `login --auto` để xem chi tiết, hoặc `login` thủ công 1 lần.'
        : `ChatGPT not signed in. Chạy thủ công 1 lần:  chatgpt-review login   — hoặc cấu hình .env rồi chạy:  chatgpt-review login --auto  (xem --help). File: ${creds.envPath}`
      throw new Error(hint)
    }

    let project = null
    if (useProjectMode) {
      if (projectArg) {
        project = await findProjectId(page, projectArg) || { name: projectArg, slug: null, id: null }
        if (!project.slug) project = await createProject(page, projectArg)
      } else {
        project = await resolveProject(page, repo, config, { create: true, recheck: false })
      }
      if (project && project.slug) {
        const ok = await gotoProject(page, project)
        if (!ok) {
          console.error(`[bridge] could not open project ${project.slug} — falling back to plain chat`)
          await newChat(page)
          await page.waitForTimeout(1500)
        }
      }
    }

    let reused = false
    if (chat && chat.id) {
      reused = await gotoConversation(page, chat.id)
      if (!reused) {
        console.error(`[bridge] could not open saved chat ${chat.id} — starting a new one`)
        if (useProjectMode && project && project.slug) {
          const ok = await gotoProject(page, project)
          if (!ok) await newChat(page)
        } else {
          await newChat(page)
        }
        await page.waitForTimeout(1500)
      }
    } else {
      if (!(await waitForInput(page))) {
        throw new Error('ChatGPT loaded but prompt textarea not found; UI may have changed')
      }
    }

    await typePrompt(page, prompt)
    const sent = await clickSend(page)
    if (!sent) throw new Error('could not click send')
    const reply = await waitForReply(page, timeoutSec)

    const id = chatIdFromUrl(page.url()) || (reused ? chat.id : null)
    const now = Date.now()
    if (id) {
      chats.chats[key] = {
        id,
        turns: (reused ? chat.turns : 0) + 1,
        chars: (reused ? chat.chars : 0) + prompt.length + reply.length,
        createdAt: (reused ? chat.createdAt : now) || now,
        lastUsedAt: now,
      }
      if (legacyKey !== key) delete chats.chats[legacyKey]
      saveChats(chats)
    }

    process.stdout.write(reply)
  } finally {
    await ctx.close()
  }
}

async function doStatus() {
  const localState = join(PROFILE_DIR, 'Local State')
  const cookies = join(PROFILE_DIR, 'Default', 'Cookies')
  const hasProfile = existsSync(PROFILE_DIR)
  const creds = loadChatgptCreds()
  let loggedIn = false
  if (hasProfile && existsSync(localState)) {
    try {
      const ctx = await launchPersistent(true)
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await handleCloudflare(page)
      for (let i = 0; i < 15; i++) {
        if (await isLoggedIn(page)) { loggedIn = true; break }
        await sleep(2000)
      }
      const url = page.url()
      const title = await page.title()
      console.error(`[status] url=${url.slice(0, 40)} title="${title}" loggedIn=${loggedIn}`)
      await ctx.close()
    } catch (e) {
      console.error(`[status] error: ${e.message}`)
    }
  }
  console.log(JSON.stringify({ profileExists: hasProfile, cookiesExist: existsSync(cookies), loggedIn, envConfigured: creds.configured, envFileExists: creds.fileExists }))
}

async function doChats() {
  const ctx = repoContext()
  const key = ctx.key
  const legacyKey = ctx.legacy_key
  const chats = loadChats()
  console.log(JSON.stringify({ currentKey: key, current: chats.chats[key] || chats.chats[legacyKey] || null, all: chats.chats }, null, 2))
}

async function doReset() {
  const ctx = repoContext()
  const key = ctx.key
  const legacyKey = ctx.legacy_key
  const chats = loadChats()
  const had = !!(chats.chats[key] || chats.chats[legacyKey])
  delete chats.chats[key]
  if (legacyKey !== key) delete chats.chats[legacyKey]
  saveChats(chats)
  console.log(had ? `reset ${key} — next ask will start a new conversation` : `no saved chat for ${key}`)
}

async function doApproval() {
  const sub = args[1] || 'get'
  const ctx = repoContext()
  const key = ctx.key
  const legacyKey = ctx.legacy_key
  const chats = loadChats()
  const entry = chats.chats[key] || chats.chats[legacyKey] || {}

  if (sub === 'get') {
    console.log(JSON.stringify(entry.approval || null))
  } else if (sub === 'set') {
    const verdict = args[2]
    const headSha = args[3]
    const rawPr = args[4] !== undefined ? args[4] : (entry.approval?.pr ?? entry.approval?.pr === 0 ? String(entry.approval.pr) : 'none')
    if (!allowedVerdicts.has(verdict)) {
      console.error(`invalid verdict: ${verdict || '(missing)'} (allowed: ${[...allowedVerdicts].join(', ')})`)
      process.exit(1)
    }
    if (!/^[0-9a-f]{40}$/i.test(headSha || '')) {
      console.error('HEAD_SHA must be a full 40-character hexadecimal Git commit')
      process.exit(1)
    }
    let pr = null
    if (rawPr !== undefined && rawPr !== null && rawPr !== 'none' && rawPr !== '') {
      const parsed = Number.parseInt(String(rawPr), 10)
      if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(rawPr)) {
        console.error('PR must be a positive integer or none')
        process.exit(1)
      }
      pr = parsed
    } else if (rawPr === 'none' || rawPr === '' || rawPr === null) {
      pr = null
    }
    const nowIso = new Date().toISOString()
    const approval = {
      verdict,
      headSha: headSha.toLowerCase(),
      head_sha: headSha.toLowerCase(),
      pr,
      repo: ctx.identity,
      branch: ctx.branch,
      reviewer: 'chatgpt-review',
      reviewedAt: Date.now(),
      reviewed_at: nowIso,
    }
    const newEntry = { ...entry, approval }
    chats.chats[key] = newEntry
    if (legacyKey !== key) delete chats.chats[legacyKey]
    saveChats(chats)
    console.log(JSON.stringify({ key, approval: newEntry.approval }))
  } else if (sub === 'clear') {
    delete entry.approval
    // Keep entry if it has other fields (like id), else remove
    if (Object.keys(entry).length) {
      chats.chats[key] = entry
    } else {
      delete chats.chats[key]
    }
    if (legacyKey !== key) delete chats.chats[legacyKey]
    saveChats(chats)
    console.log(`cleared approval for ${key}`)
  } else {
    console.error('usage: approval get|set <verdict> <headSha> [pr]|clear')
    process.exit(1)
  }
}

async function doProject() {
  const sub = args[1] || 'list'
  const repo = repoName()
  const config = loadConfig()
  const ctx = await launchPersistent(true)
  const page = ctx.pages()[0] || await ctx.newPage()
  try {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await handleCloudflare(page)
    if (!(await waitForInput(page, 12))) {
      throw new Error('ChatGPT not ready — run login first')
    }
    if (sub === 'list') {
      const list = await listProjectsFromWeb(page)
      console.log(JSON.stringify(list, null, 2))
    } else if (sub === 'create') {
      const name = args[2] || repo
      const created = await createProject(page, name)
      console.log(JSON.stringify({ created: true, name, ...created }, null, 2))
    } else if (sub === 'attach') {
      const name = args[2]
      if (!name) { console.error('usage: project attach <name>'); process.exit(1) }
      const found = await findProjectId(page, name)
      if (!found) { console.error(`project "${name}" not found`); process.exit(1) }
      const projects = loadProjects()
      projects.projects[repo] = { id: found.id, slug: found.slug, name: found.name, createdAt: Date.now() }
      saveProjects(projects)
      console.log(`attached ${repo} → project "${found.name}" (${found.slug})`)
    } else if (sub === 'detach') {
      const projects = loadProjects()
      const had = !!projects.projects[repo]
      delete projects.projects[repo]
      saveProjects(projects)
      console.log(had ? `detached ${repo} from its project` : `no project attached to ${repo}`)
    } else if (sub === 'resolve') {
      const projects = loadProjects()
      const saved = projects.projects[repo]
      const enabled = projectEnabledForRepo(config, repo)
      let live = null
      if (enabled) {
        live = saved && saved.slug ? saved : await findProjectId(page, repo)
      }
      console.log(JSON.stringify({ repo, projectModeEnabled: enabled, saved, live }, null, 2))
    } else {
      console.error(`unknown project subcommand: ${sub}\nusage: project list|create <name>|attach <name>|detach|resolve`)
      process.exit(1)
    }
  } finally {
    await ctx.close()
  }
}

async function doSources() {
  // Delegate to chatgpt-sources-sync.mjs (hybrid .git + metadata)
  // Resolve script location: try bridge bin first, then repo bin, then alongside this script
  const candidates = [
    join(BRIDGE_DIR, 'bin', 'chatgpt-sources-sync.mjs'),
    join(repoContext().root, 'bin', 'chatgpt-sources-sync.mjs'),
    join(join(import.meta.url.replace('file://','').replace(/\/[^/]+$/, '')), 'chatgpt-sources-sync.mjs'),
  ]
  let script = null
  for(const p of candidates){
    if(existsSync(p)){ script=p; break }
  }
  if(!script) throw new Error('chatgpt-sources-sync.mjs not found (run bash install.sh --config)')
  // Map aliases: src-sync -> sources sync --force, src-status -> sources status, etc.
  let passArgs = args.slice(1)
  // If called as `chatgpt-review src-sync` (mode is src-sync), translate to `sources sync --force`
  if(mode === 'src-sync'){
    passArgs = ['sync', '--force', ...passArgs]
    // ensure we call sources sync
    execFileSync('node', [script, 'sync', '--force', ...args.slice(1)], {stdio: 'inherit'})
    return
  }
  if(mode === 'src-status'){
    execFileSync('node', [script, 'status', ...args.slice(1)], {stdio: 'inherit'})
    return
  }
  if(mode === 'src-reset'){
    execFileSync('node', [script, 'reset', ...args.slice(1)], {stdio: 'inherit'})
    return
  }
  if(mode === 'src-build'){
    execFileSync('node', [script, 'build', ...args.slice(1)], {stdio: 'inherit'})
    return
  }
  if(mode === 'src-upload'){
    execFileSync('node', [script, 'upload', ...args.slice(1)], {stdio: 'inherit'})
    return
  }
  // Normal: chatgpt-review sources <subcmd>  or  chatgpt-review src <subcmd>
  // If no subcmd, default to status
  if(passArgs.length===0) passArgs=['status']
  execFileSync('node', [script, ...passArgs], {stdio: 'inherit'})
}

function withLock(fn) {
  return async () => {
    acquireLock()
    try {
      await fn()
    } finally {
      releaseLock()
    }
  }
}

if (mode === 'login') { await withLock(doLogin)() }
else if (mode === 'ask') { await withLock(doAsk)() }
else if (mode === 'status') { await withLock(doStatus)() }
else if (mode === 'chats') { await doChats() }
else if (mode === 'reset') { await withLock(doReset)() }
else if (mode === 'approval') { await withLock(doApproval)() }
else if (mode === 'project' || mode === 'projects') { await withLock(doProject)() }
else if (mode === 'sources' || mode === 'src') { await doSources() }
else if (mode === 'src-sync') { await doSources() }
else if (mode === 'src-status') { await doSources() }
else if (mode === 'src-reset') { await doSources() }
else if (mode === 'src-build') { await doSources() }
else if (mode === 'src-upload') { await doSources() }
else if (mode.startsWith('src-')) { await doSources() }
else { usage(); process.exit(1) }
