#!/usr/bin/env node
// Gemini web bridge — sends a prompt to Google Gemini (gemini.google.com/app)
// and scrapes the reply. Mirrors chatgpt-review.mjs: one conversation per
// repo+branch, persistent Chrome profile, cross-process lock.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'
import { chromium } from 'playwright'

const HOME = homedir()
const BRIDGE_DIR = join(HOME, '.config/opencode/gemini-bridge')
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

const EXECUTABLE = resolveChromium()
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

const DEFAULT_CONFIG = { max_chars: 400000, max_turns: 40, max_age_hours: 48 }

function usage() {
  console.error(`
gemini-review bridge - sends a prompt to Google Gemini (web) and reads the reply.
Reuses one conversation per repo+branch; creates a new one when the context gets long.

USAGE:
  gemini-review.mjs login          Open a visible browser so you can sign in to your Google account once.
  gemini-review.mjs ask            Read prompt from stdin (or --file=FILE), send to Gemini, print reply.
  gemini-review.mjs status         Check whether a signed-in profile exists.
  gemini-review.mjs chats          List per-repo conversation state.
  gemini-review.mjs reset          Drop the saved conversation mapping for the current repo+branch.

OPTIONS (for ask):
  --file=FILE        Read the prompt from FILE instead of stdin.
  --timeout=SECONDS  Max seconds to wait for the reply (default 300).
  --new              Force a new conversation (drop the saved mapping) for this repo+branch.
  --headless         Try headless mode; default headful.
  --headful          Always show the browser window (default).

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
  mkdirSync(BRIDGE_DIR, { recursive: true })
  const deadline = Date.now() + timeoutSec * 1000
  while (true) {
    try {
      const fd = openSync(LOCK_FILE, 'wx')
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

function loadChats() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { chats: {} }
  }
}

function saveChats(chats) {
  mkdirSync(BRIDGE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(chats, null, 2))
}

function repoKey() {
  try {
    const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
    let branch = 'default'
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
    } catch {}
    return `${basename(top)}:${branch}`
  } catch {
    return `${basename(process.cwd())}:default`
  }
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

async function isLoggedIn(page) {
  try {
    const cookies = await page.context().cookies(['https://gemini.google.com/', 'https://accounts.google.com/'])
    return cookies.some(c => c.name === '__Secure-1PSID' || c.name === '__Secure-3PSID' || c.name === 'SAPISID')
  } catch {
    return false
  }
}

async function launchPersistent(headful) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: EXECUTABLE,
    headless: !headful,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  })
  return ctx
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
  const ctx = await launchPersistent(true)
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  console.error('Browser opened. Sign in to your Google account (and any consent screen) in the window.')
  console.error('Waiting for a real signed-in session cookie to appear...')
  for (let i = 0; i < 600; i++) {
    try {
      if (page.url().includes('gemini.google.com') && await isLoggedIn(page)) {
        await sleep(2000)
        console.error('LOGIN OK — session saved.')
        await ctx.close()
        return
      }
    } catch {}
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
  for (const a of args.slice(1)) {
    if (a.startsWith('--file=')) prompt = readFileSync(a.slice(7), 'utf8')
    else if (a.startsWith('--timeout=')) timeoutSec = parseInt(a.slice(10), 10)
    else if (a === '--headless') headful = false
    else if (a === '--new') forceNew = true
  }
  if (!prompt) {
    prompt = readFileSync(0, 'utf8')
  }
  prompt = prompt.trim()
  if (!prompt) { console.error('empty prompt'); process.exit(1) }

  const config = loadConfig()
  const key = repoKey()
  const chats = loadChats()
  let chat = chats.chats[key]

  if (!forceNew && chat && !isStale(chat, config)) {
    console.error(`[bridge] reusing chat for ${key} (${chat.id}, turns=${chat.turns}, chars=${chat.chars})`)
  } else {
    if (forceNew) console.error(`[bridge] forcing new chat for ${key}`)
    else if (chat) console.error(`[bridge] chat for ${key} is stale (turns=${chat.turns}, chars=${chat.chars}) — starting fresh`)
    chat = null
    delete chats.chats[key]
  }

  const ctx = await launchPersistent(headful)
  const page = ctx.pages()[0] || await ctx.newPage()
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await handleGoogleGate(page)

    let loggedIn = false
    for (let i = 0; i < 15; i++) {
      if (await isLoggedIn(page)) { loggedIn = true; break }
      await sleep(2000)
    }
    if (!loggedIn) {
      throw new Error('Google account not signed in. Run:  gemini-review.mjs login   first.')
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
  let loggedIn = false
  if (hasProfile && existsSync(localState)) {
    try {
      const ctx = await launchPersistent(true)
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await handleGoogleGate(page)
      for (let i = 0; i < 15; i++) {
        if (await isLoggedIn(page)) { loggedIn = true; break }
        await sleep(2000)
      }
      const title = await page.title()
      console.error(`[status] url=${page.url().slice(0, 40)} title="${title}" loggedIn=${loggedIn}`)
      await ctx.close()
    } catch (e) {
      console.error(`[status] error: ${e.message}`)
    }
  }
  console.log(JSON.stringify({ profileExists: hasProfile, cookiesExist: existsSync(cookies), loggedIn }))
}

async function doChats() {
  const key = repoKey()
  const chats = loadChats()
  console.log(JSON.stringify({ currentKey: key, current: chats.chats[key] || null, all: chats.chats }, null, 2))
}

async function doReset() {
  const key = repoKey()
  const chats = loadChats()
  const had = !!chats.chats[key]
  delete chats.chats[key]
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
