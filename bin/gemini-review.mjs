#!/usr/bin/env node
// Gemini web bridge — sends a prompt to Google Gemini (gemini.google.com/app)
// and scrapes the reply. Mirrors chatgpt-review.mjs: one conversation per
// repo+branch, persistent Chrome profile, cross-process lock.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, writeSync, closeSync, unlinkSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { classifyGeminiSession, advanceLoginStability } from './session-auth.mjs'
import { loadBridgeCreds, credsHelp, maskEmail, resolveBridgeDir, GEMINI_KEYS } from './bridge-env.mjs'
const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch { try { const r2=createRequire(join(homedir(),'.config/opencode/gemini-bridge/package.json')); ({ chromium } = r2('playwright')) } catch { const r3=createRequire(join(homedir(),'.config/opencode/chatgpt-bridge/package.json')); ({ chromium } = r3('playwright')) } }

const HOME = homedir()
const BRIDGE_DIR = resolveBridgeDir(join(HOME, '.config/opencode/gemini-bridge'), 'GEMINI_BRIDGE_DIR')
const PROFILE_DIR = join(BRIDGE_DIR, 'profile')
const STATE_FILE = join(BRIDGE_DIR, 'chats.json')
const CONFIG_FILE = join(BRIDGE_DIR, 'bridge-config.json')
const LOCK_FILE = join(BRIDGE_DIR, '.lock')

// Reuse the user-space libs the ChatGPT bridge extracted, if present.
const LIB_DIRS = [
  join(BRIDGE_DIR, 'libs'),
  join(HOME, '.config/opencode/chatgpt-bridge/libs'),
].filter(existsSync)
process.env.LD_LIBRARY_PATH = `${LIB_DIRS.join(':')}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`

function resolveChromium() {
  try {
    const p = chromium.executablePath()
    if (p && existsSync(p)) return p
  } catch {}
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
  throw new Error('Chromium not found. Run: npm exec playwright install chromium  (or: bash install.sh --deps)')
}

let _executable = null
function getExecutable() {
  if (!_executable) _executable = resolveChromium()
  return _executable
}
const APP_URL = 'https://gemini.google.com/app'

const args = process.argv.slice(2)
const mode = args[0]

const PROMPT_SELECTORS = [
  'rich-textarea div.ql-editor',
  'div.ql-editor[contenteditable="true"]',
  '.ql-editor.textarea',
  'textarea[aria-label*="prompt" i]',
]
const SEND_SELECTORS = [
  'button[aria-label*="Send" i]',
  'button.send-button',
  'button[data-test-id="send-button"]',
]
const STOP_SELECTORS = [
  'button[aria-label*="Stop" i]',
  'button.stop-button',
]
const REPLY_SELECTORS = [
  'model-response .markdown',
  '.model-response-text',
  'model-response message-content',
  'model-response',
  '.response-container-content',
]
const SIGNED_OUT_SELECTORS = [
  'a[href*="accounts.google.com/ServiceLogin"]',
  'a[href*="accounts.google.com/v3/signin"]',
  'a[href*="accounts.google.com/signin"]',
  'a[href*="accounts.google.com/AccountChooser"]',
]
const ACCOUNT_IDENTITY_SELECTORS = [
  'a[href*="accounts.google.com/SignOutOptions"]',
  'a[href^="https://myaccount.google.com/"][aria-label]',
  'a[aria-label^="Google Account:"]',
  'button[aria-label^="Google Account:"]',
]

const DEFAULT_CONFIG = { max_chars: 400000, max_turns: 40, max_age_hours: 48 }

function usage() {
  console.error(`
gemini-review bridge - sends a prompt to Google Gemini (web) and reads the reply.
Reuses one conversation per repo+branch; creates a new one when the context gets long.

USAGE:
  gemini-review.mjs login [--auto]   Sign in once (manual, or --auto from .env with no typing).
  gemini-review.mjs ask            Read prompt from stdin (or --file=FILE), send to Gemini, print reply.
  gemini-review.mjs status         Check whether a signed-in profile exists.
  gemini-review.mjs chats          List per-repo conversation state.
  gemini-review.mjs reset          Drop the saved conversation mapping for the current repo+branch.

LOGIN OPTIONS:
  --auto / --from-env / --env   Sign in automatically with Google credentials from .env.
  --timeout=SECONDS     Max seconds to wait for auto-login (default 120).
  --headless / --headful       Browser visibility for login (default headful).

OPTIONS (for ask):
  --file=FILE        Read the prompt from FILE instead of stdin.
  --timeout=SECONDS  Max seconds to wait for the reply (default 300).
  --new              Force a new conversation (drop the saved mapping) for this repo+branch.
  --no-auto-login    Do NOT attempt .env auto-login when the session is missing.
  --headless         Try headless mode; default headful.
  --headful          Always show the browser window (default).

ENV FILE (~/.config/opencode/gemini-bridge/.env, mode 600, never committed):
  GEMINI_EMAIL=you@gmail.com
  GEMINI_PASSWORD=your-password
  # aliases: GOOGLE_EMAIL / GOOGLE_PASSWORD. Shell env overrides the file.
  # Custom path: GEMINI_ENV_FILE=/path/to/.env gemini-review login --auto

CONFIG (bridge-config.json):
  max_chars / max_turns / max_age_hours — create a new chat when any threshold is reached.
`)
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ---------- cross-process lock (1 Chrome profile) ----------

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
    let ownerPid = null
    try { ownerPid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10) } catch {}
    if (ownerPid && !pidAlive(ownerPid)) {
      try { unlinkSync(LOCK_FILE) } catch {}
      continue
    }
    if (Date.now() > deadline) {
      throw new Error(`another gemini-review is running (pid=${ownerPid || '?'}); timed out after ${timeoutSec}s waiting for the lock`)
    }
    console.error(`[bridge] waiting for lock (pid=${ownerPid || '?'})…`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE) } catch {}
}

// ---------- state / config ----------

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

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

function loadChats() {
  const v = loadJson(STATE_FILE, { chats: {} })
  return v && typeof v === 'object' && v.chats && typeof v.chats === 'object' ? v : { chats: {} }
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
  const m = url.match(/\/app\/([0-9a-f]{6,})/)
  return m ? m[1] : null
}

// ---------- browser ----------

async function anyVisible(page, selectors) {
  for (const selector of selectors) {
    const matches = page.locator(selector)
    for (let index = 0; index < (await matches.count()); index += 1) {
      if (await matches.nth(index).isVisible().catch(() => false)) return true
    }
  }
  return false
}

async function anyPresent(page, selectors) {
  for (const selector of selectors) {
    if (await page.locator(selector).count()) return true
  }
  return false
}

async function sessionState(page) {
  let onGeminiOrigin = false
  try { onGeminiOrigin = new URL(page.url()).hostname === 'gemini.google.com' } catch {}
  let cookies = []
  try {
    cookies = await page.context().cookies(['https://gemini.google.com/', 'https://accounts.google.com/'])
  } catch {}
  return classifyGeminiSession({
    onGeminiOrigin,
    explicitSignedOut: await anyPresent(page, SIGNED_OUT_SELECTORS),
    identityEvidence: await anyVisible(page, ACCOUNT_IDENTITY_SELECTORS),
    canAsk: Boolean(await findInput(page)),
    cookieNames: cookies.map((c) => c.name),
  })
}

async function isLoggedIn(page) {
  try {
    return (await sessionState(page)).loggedIn
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

function loadGeminiCreds() {
  return loadBridgeCreds({
    bridgeDir: BRIDGE_DIR,
    envFileVar: 'GEMINI_ENV_FILE',
    emailKeys: GEMINI_KEYS.emailKeys,
    passwordKeys: GEMINI_KEYS.passwordKeys,
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

function detectGoogleBlocker(bodyText, url) {
  if (!bodyText && !url) return null
  const t = bodyText || ''
  if (/this browser or app may not be secure|browser.*not.*secure|couldn'?t sign you in.*browser/.test(t)) {
    return 'Google chặn trình duyệt tự động ("browser may not be secure") — đăng nhập thủ công 1 lần (`login`) để lưu session, các lần sau tái dùng.'
  }
  if (/wrong password|incorrect.*password|wrong.*credentials|invalid.*password/.test(t)) {
    return 'Google báo sai password — kiểm tra lại GEMINI_PASSWORD trong .env.'
  }
  if (/couldn'?t find your google account|couldn'?t find.*account|enter a valid email/.test(t)) {
    return 'Google không tìm thấy tài khoản — kiểm tra lại GEMINI_EMAIL trong .env.'
  }
  if (/2-step|2 step|two-?factor|verification code|verify it'?s you|check your phone|authenticator|we sent.*code|enter.*code/.test(t)) {
    return 'Tài khoản bật xác minh 2 bước / mã OTP — auto-login không thể tự qua. Đăng nhập thủ công 1 lần (`login`), session sẽ được tái dùng.'
  }
  if (/captcha|unusual traffic|verify you are human|suspicious activity|try again later|too many/.test(t)) {
    return 'Google yêu cầu xác minh người thật / giới hạn thử lại — hoàn thành 1 lần bằng `login` thủ công.'
  }
  return null
}

const GOOGLE_EMAIL_INPUT = [
  '#identifierId',
  'input[name="identifier"]',
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[type="text"][name="identifier"]',
]
const GOOGLE_EMAIL_NEXT = [
  '#identifierNext',
  'button:has-text("Next")',
  'button[type="button"]:has-text("Next")',
]
const GOOGLE_PASSWORD_INPUT = [
  'input[name="Passwd"]',
  'input[type="password"]',
  '#password input',
  'input[autocomplete="current-password"]',
]
const GOOGLE_PASSWORD_NEXT = [
  '#passwordNext',
  'button:has-text("Next")',
  'button[type="button"]:has-text("Next")',
]

// Fill Google identifier+password from .env. Waits for manual 2FA/OTP; throws on other blocks.
async function tryAutoLoginGoogle(page, creds, { timeoutSec = 120 } = {}) {
  if (await isLoggedIn(page)) return true
  console.error(`[bridge] auto-login as ${maskEmail(creds.email)} (from ${creds.emailSource === 'env' ? 'env' : creds.envPath})…`)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(2500)

  const deadline = Date.now() + timeoutSec * 1000
  let emailDone = false
  let passwordDone = false
  let twoFactorNotified = false
  const isTwoFactorBlocker = (msg) => /2 bước|2-step|two-factor|OTP|mã OTP|xác minh 2/i.test(msg || '')
  const noteTwoFactor = () => {
    if (!twoFactorNotified) {
      console.error('[bridge] 2FA/OTP — hoàn tất xác minh trên điện thoại/trình duyệt, đang chờ hết timeout...')
      twoFactorNotified = true
    }
  }
  // Quick check: maybe already logged in via stored profile.
  for (let i = 0; i < 5; i++) {
    if (await isLoggedIn(page)) return true
    if (page.url().includes('accounts.google.com')) break
    await sleep(1000)
  }

  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true
    const url = page.url()
    const onGoogleAuth = url.includes('accounts.google.com')
    // If we are back on Gemini origin, re-evaluate login state.
    if (!onGoogleAuth && url.includes('gemini.google.com')) {
      const st = await sessionState(page).catch(() => null)
      if (st && st.loggedIn) return true
      // Consent / "unusual traffic" interstitial on gemini origin.
      const body = await pageBodyText(page)
      const blocker = detectGoogleBlocker(body, url)
      if (blocker && (emailDone || passwordDone)) {
        if (isTwoFactorBlocker(blocker)) { noteTwoFactor() }
        else throw new Error(blocker)
      }
      // Guest landing page (signed-out): click "Sign in" to reach accounts.google.com.
      if (!emailDone && !passwordDone) {
        try {
          const clicked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('button, a')].filter((el) => {
              const t = (el.innerText || '').trim()
              if (!/^\s*sign in\s*$/i.test(t)) return false
              const r = el.getBoundingClientRect()
              return r.width > 2 && r.height > 2
            })
            if (!els.length) return false
            els[0].click()
            return true
          })
          if (clicked) { await page.waitForTimeout(4000); continue }
        } catch {}
      }
    }
    const body = await pageBodyText(page)
    const blocker = detectGoogleBlocker(body, url)
    if (blocker && (emailDone || passwordDone)) {
      if (isTwoFactorBlocker(blocker)) { noteTwoFactor() }
      else throw new Error(blocker)
    }

    if (!emailDone && onGoogleAuth) {
      const hit = await fillFirstVisible(page, GOOGLE_EMAIL_INPUT, creds.email, 4000)
      if (hit) {
        await clickFirstVisible(page, GOOGLE_EMAIL_NEXT, 5000)
        await page.waitForTimeout(3000)
        emailDone = true
        continue
      }
      // Email field not yet rendered — keep waiting for the auth page.
    }
    if (emailDone && !passwordDone && onGoogleAuth) {
      const hit = await fillFirstVisible(page, GOOGLE_PASSWORD_INPUT, creds.password, 5000)
      if (hit) {
        passwordDone = true
        await clickFirstVisible(page, GOOGLE_PASSWORD_NEXT, 5000)
        await page.waitForTimeout(3500)
        continue
      }
    }
    if (emailDone && passwordDone) {
      // After password submit Google may show 2FA, consent, or redirect back.
      // 2FA needs a human: keep polling until the deadline instead of aborting.
      for (let i = 0; i < 8; i++) {
        if (await isLoggedIn(page)) return true
        const b2 = await pageBodyText(page)
        const blocker2 = detectGoogleBlocker(b2, page.url())
        if (blocker2) {
          if (isTwoFactorBlocker(blocker2)) { noteTwoFactor(); break }
          throw new Error(blocker2)
        }
        // Navigated back to Gemini but identity not yet settled — keep polling.
        await sleep(1500)
      }
    }
    await sleep(1500)
  }
  const finalBlocker = detectGoogleBlocker(await pageBodyText(page), page.url())
  throw new Error(finalBlocker || `Timed out after ${timeoutSec}s waiting for Google login as ${maskEmail(creds.email)}. Kiểm tra email/password trong .env hoặc đăng nhập thủ công 1 lần: gemini-review login`)
}

async function ensureGeminiLoggedIn(page, { allowAuto = true } = {}) {
  for (let i = 0; i < 6; i++) {
    if (await isLoggedIn(page)) return true
    await sleep(1000)
  }
  if (!allowAuto) return false
  const creds = loadGeminiCreds()
  for (const w of creds.warnings) console.error(`[bridge] WARN: ${w}`)
  if (!creds.configured) return false
  console.error(`[bridge] session hết hạn — tự đăng nhập lại từ .env (${maskEmail(creds.email)})…`)
  try {
    await tryAutoLoginGoogle(page, creds)
    return await isLoggedIn(page)
  } catch (e) {
    console.error(`[bridge] auto-login thất bại: ${e.message}`)
    return false
  }
}

async function handleGoogleGate(page) {
  // If Google bounces us to accounts/consent, wait briefly then fail with a clear message.
  for (let i = 0; i < 20; i++) {
    const url = page.url()
    if (url.includes('gemini.google.com')) return
    await sleep(1500)
  }
  throw new Error(`Google redirected to "${page.url().slice(0, 80)}" — session missing or consent required. Run:  gemini-review.mjs login`)
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
  const url = `${APP_URL}/${id}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await handleGoogleGate(page)
  await waitForInput(page, 10)
  return page.url().includes(`/app/${id}`)
}

async function replyLocator(page) {
  for (const sel of REPLY_SELECTORS) {
    const loc = page.locator(sel)
    try { if ((await loc.count()) > 0) return loc } catch {}
  }
  return null
}

async function replyCount(page) {
  const loc = await replyLocator(page)
  return loc ? await loc.count() : 0
}

async function typePrompt(page, text) {
  const input = await findInput(page)
  if (!input) throw new Error('prompt editor not found; Gemini UI may have changed or login required')
  await input.click()
  await input.fill(text)
  await sleep(500)
  return input
}

async function clickSend(page) {
  for (const sel of SEND_SELECTORS) {
    const btn = page.locator(sel).first()
    if (await btn.count()) {
      try { await btn.click({ timeout: 3000 }); return true } catch {}
    }
  }
  const input = await findInput(page)
  if (input) {
    await input.press('Enter')
    return true
  }
  return false
}

async function stopVisible(page) {
  const stop = page.locator(STOP_SELECTORS.join(', ')).first()
  return (await stop.count()) > 0 && (await stop.isVisible().catch(() => false))
}

async function waitForReply(page, timeoutSec, baselineCount) {
  const deadline = Date.now() + timeoutSec * 1000
  let started = false
  let prevText = ''
  while (Date.now() < deadline) {
    const stopping = await stopVisible(page)
    const n = await replyCount(page)
    if (!started && (stopping || n > baselineCount)) started = true
    if (started && !stopping && n > baselineCount) {
      const loc = await replyLocator(page)
      const last = loc.nth((await loc.count()) - 1)
      const text = (await last.innerText().catch(() => '')) || ''
      if (text.trim().length > 5 && text === prevText) return text
      prevText = text
    }
    await sleep(1500)
  }
  throw new Error(`timeout after ${timeoutSec}s waiting for Gemini reply`)
}

// ---------- commands ----------

async function doLogin() {
  const loginArgs = args.slice(1)
  const has = (flag) => loginArgs.includes(flag)
  if (has('--auto') || has('--from-env') || has('--env')) {
    const creds = loadGeminiCreds()
    for (const w of creds.warnings) console.error(`[bridge] WARN: ${w}`)
    if (!creds.configured) {
      console.error(credsHelp({ bridgeLabel: 'Gemini/Google', envPath: creds.envPath, emailKeys: GEMINI_KEYS.emailKeys, passwordKeys: GEMINI_KEYS.passwordKeys }))
      process.exit(1)
    }
    const timeoutArg = loginArgs.find((a) => a.startsWith('--timeout='))
    const loginTimeout = timeoutArg ? parseInt(timeoutArg.slice(10), 10) || 120 : 120
    const headful = has('--headless') ? false : true
    const ctx = await launchPersistent(headful)
    const page = ctx.pages()[0] || await ctx.newPage()
    try {
      await tryAutoLoginGoogle(page, creds, { timeoutSec: loginTimeout })
      // Require the same settled identity the manual flow requires (fast path:
      // one extra stable check instead of three — profile already persisted).
      let ok = false
      for (let i = 0; i < 10; i++) {
        if (await isLoggedIn(page)) { ok = true; break }
        await sleep(1500)
      }
      if (!ok) throw new Error('login xong nhưng chưa thấy account identity — có thể cần consent/2FA thủ công.')
      console.error('LOGIN OK — session saved (auto-login from .env).')
      await ctx.close()
      return
    } catch (e) {
      console.error(`Auto-login thất bại: ${e.message}`)
      console.error('Fallback: chạy `gemini-review login` thủ công 1 lần để lưu session (2FA/CAPTCHA/"browser not secure" không tự qua được).')
      try { await ctx.close() } catch {}
      process.exit(1)
    }
  }
  const ctx = await launchPersistent(true)
  const page = ctx.pages()[0] || await ctx.newPage()
  let documentVersion = 0
  let observedDocumentVersion = 0
  let lastNavigationAt = Date.now()
  let stableChecks = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      documentVersion += 1
      lastNavigationAt = Date.now()
    }
  })
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  observedDocumentVersion = documentVersion
  console.error('Browser opened. Sign in to your Google account (and any consent screen) in the window.')
  console.error('Waiting for a real signed-in session to settle (needs 3 stable checks)...')
  console.error('Tip: for non-interactive login from .env, run:  gemini-review login --auto')
  for (let i = 0; i < 600; i++) {
    try {
      if (page.isClosed()) throw new Error('browser window was closed before login completed')
      const state = await sessionState(page)
      const sameDocument = documentVersion === observedDocumentVersion
      const documentSettled = Date.now() - lastNavigationAt >= 5000
      stableChecks = advanceLoginStability(stableChecks, state, sameDocument, documentSettled)
      observedDocumentVersion = documentVersion
      if (stableChecks >= 3) {
        console.error('LOGIN OK — session saved.')
        await ctx.close()
        return
      }
    } catch (e) {
      stableChecks = 0
      observedDocumentVersion = documentVersion
      if (page.isClosed()) throw e
    }
    await sleep(1000)
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
  let allowAutoLogin = true
  for (const a of args.slice(1)) {
    if (a.startsWith('--file=')) prompt = readFileSync(a.slice(7), 'utf8')
    else if (a.startsWith('--timeout=')) timeoutSec = parseInt(a.slice(10), 10)
    else if (a === '--headless') headful = false
    else if (a === '--new') forceNew = true
    else if (a === '--no-auto-login') allowAutoLogin = false
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

  const ctx = await launchPersistent(headful)
  const page = ctx.pages()[0] || await ctx.newPage()
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await handleGoogleGate(page)

    const loggedIn = await ensureGeminiLoggedIn(page, { allowAuto: allowAutoLogin })
    if (!loggedIn) {
      const creds = loadGeminiCreds()
      const hint = creds.configured
        ? 'Auto-login từ .env thất bại — thử `login --auto` để xem chi tiết, hoặc `login` thủ công 1 lần.'
        : `Google account not signed in. Chạy thủ công 1 lần:  gemini-review login   — hoặc cấu hình .env rồi chạy:  gemini-review login --auto. File: ${creds.envPath}`
      throw new Error(hint)
    }

    let reused = false
    if (chat && chat.id) {
      reused = await gotoConversation(page, chat.id)
      if (!reused) {
        console.error(`[bridge] could not open saved chat ${chat.id} — starting a new one`)
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(1500)
      }
    }
    if (!(await waitForInput(page))) {
      throw new Error('Gemini loaded but prompt editor not found; UI may have changed')
    }

    const baseline = await replyCount(page)
    await typePrompt(page, prompt)
    const sent = await clickSend(page)
    if (!sent) throw new Error('could not click send')
    const reply = await waitForReply(page, timeoutSec, baseline)

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
  const creds = loadGeminiCreds()
  let loggedIn = false
  let guestAvailable = false
  let lastState = null
  if (hasProfile && existsSync(localState)) {
    let ctx
    try {
      ctx = await launchPersistent(true)
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await handleGoogleGate(page)
      for (let i = 0; i < 15; i++) {
        lastState = await sessionState(page)
        if (lastState.loggedIn) { loggedIn = true; guestAvailable = false; break }
        guestAvailable = lastState.guestAvailable
        await sleep(2000)
      }
      const title = await page.title().catch(() => '')
      console.error(`[status] url=${page.url().slice(0, 40)} title="${title}" loggedIn=${loggedIn} guestAvailable=${guestAvailable}`)
    } catch (e) {
      console.error(`[status] error: ${e.message}`)
    } finally {
      if (ctx) try { await ctx.close() } catch {}
    }
  }
  // Keep backward compat: always include loggedIn, add guestAvailable for richer diagnostics
  console.log(JSON.stringify({ profileExists: hasProfile, cookiesExist: existsSync(cookies), loggedIn, guestAvailable, envConfigured: creds.configured, envFileExists: creds.fileExists }))
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
else { usage(); process.exit(1) }
