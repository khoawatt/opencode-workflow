#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'
import { chromium } from 'playwright'

const HOME = homedir()
const BRIDGE_DIR = join(HOME, '.config/opencode/chatgpt-bridge')
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

const EXECUTABLE = resolveChromium()
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
  chatgpt-review.mjs login [--switch] [--wait=SECONDS]   Open a visible browser so you can sign in to ChatGPT once.
  chatgpt-review.mjs ask            Read prompt from stdin (or --file=FILE), send to ChatGPT, print reply.
  chatgpt-review.mjs status         Check whether a signed-in profile exists.
  chatgpt-review.mjs chats          List per-repo conversation state.
  chatgpt-review.mjs reset          Drop the saved conversation mapping for the current repo+branch.
  chatgpt-review.mjs approval       Get/set/clear the review approval state (get|set <verdict> <sha>|clear).
  chatgpt-review.mjs project        Manage ChatGPT Projects (create/list/attach/detach/resolve).
  chatgpt-review.mjs projects       Alias for "project list".

LOGIN OPTIONS:
  --switch              Keep browser open to switch account (waits for session token to change; does not auto-close if already logged in).
  --wait=SECONDS        After a new login is detected, keep browser open for SECONDS (default 0; implies --switch).
  --keep-open / --stay-open   Alias for --switch.

OPTIONS (for ask):
  --file=FILE        Read the prompt from FILE instead of stdin.
  --timeout=SECONDS  Max seconds to wait for the reply (default 300).
  --new              Force a new conversation (drop the saved mapping) for this repo+branch.
  --project          Use (or create) a ChatGPT Project for this repo's reviews.
  --no-project       Force plain single-chat mode for this call.
  --headless         Try headless mode (may be blocked by Cloudflare; default headful).
  --headful          Always show the browser window (default).

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
  const m = url.match(/\/c\/([0-9a-f-]{8,})/)
  return m ? m[1] : null
}

function repoName() {
  return repoKey().split(':')[0]
}

function loadProjects() {
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
  } catch {
    return { projects: {} }
  }
}

function saveProjects(projects) {
  mkdirSync(BRIDGE_DIR, { recursive: true })
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2))
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
    executablePath: EXECUTABLE,
    headless: !headful,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  })
  return ctx
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
  let keepOpenSec = 0
  let switchMode = has('--switch') || has('--stay-open') || has('--keep-open') || !!waitArg
  if (waitArg) {
    const v = parseInt(waitArg.slice(7), 10)
    if (!isNaN(v) && v >= 0) keepOpenSec = v
  } else if (has('--wait') || has('--stay-open') || has('--keep-open')) {
    keepOpenSec = 0
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
  for (const a of args.slice(1)) {
    if (a.startsWith('--file=')) prompt = readFileSync(a.slice(7), 'utf8')
    else if (a.startsWith('--timeout=')) timeoutSec = parseInt(a.slice(10), 10)
    else if (a === '--headless') headful = false
    else if (a === '--new') forceNew = true
    else if (a === '--project') useProject = true
    else if (a === '--no-project') useProject = false
    else if (a.startsWith('--project=')) { useProject = true; projectArg = a.slice(10) }
  }
  if (!prompt) {
    prompt = readFileSync(0, 'utf8')
  }
  prompt = prompt.trim()
  if (!prompt) { console.error('empty prompt'); process.exit(1) }

  const config = loadConfig()
  const key = repoKey()
  const repo = repoName()
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

  const useProjectMode = useProject === null ? projectEnabledForRepo(config, repo) : useProject
  if (useProjectMode) console.error(`[bridge] project mode ON for ${repo}`)

  const ctx = await launchPersistent(headful)
  const page = ctx.pages()[0] || await ctx.newPage()
  try {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await handleCloudflare(page)

    let loggedIn = false
    for (let i = 0; i < 15; i++) {
      if (await isLoggedIn(page)) { loggedIn = true; break }
      await sleep(2000)
    }
    if (!loggedIn) {
      throw new Error('ChatGPT not signed in. Run:  chatgpt-review.mjs login   first.')
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

async function doApproval() {
  const sub = args[1] || 'get'
  const key = repoKey()
  const chats = loadChats()
  const entry = chats.chats[key] || {}

  if (sub === 'get') {
    console.log(JSON.stringify(entry.approval || null))
  } else if (sub === 'set') {
    const verdict = args[2]
    const headSha = args[3]
    if (!verdict || !headSha) { console.error('usage: approval set <verdict> <headSha> [pr]'); process.exit(1) }
    const pr = args[4] || entry.approval?.pr || null
    chats.chats[key] = { ...entry, approval: { verdict, headSha, pr, reviewedAt: Date.now() } }
    saveChats(chats)
    console.log(JSON.stringify({ key, approval: chats.chats[key].approval }))
  } else if (sub === 'clear') {
    delete entry.approval
    chats.chats[key] = entry
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
else { usage(); process.exit(1) }
