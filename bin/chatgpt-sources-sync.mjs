#!/usr/bin/env node
// chatgpt-sources-sync — probe spike for Project Sources ZIP ingestion
// Reuses global bridge lock (~/.config/opencode/chatgpt-bridge/.lock) and atomic saveJson
// Usage: node bin/chatgpt-sources-sync.mjs status | upload [--file=PATH] [--headless] [--timeout=300]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, writeSync, closeSync, unlinkSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch { const r2=require.createRequire('/home/audition/.config/opencode/chatgpt-bridge/package.json'); ({ chromium } = r2('playwright')) }

const HOME = homedir()
const BRIDGE_DIR = join(HOME, '.config/opencode/chatgpt-bridge')
const PROFILE_DIR = join(BRIDGE_DIR, 'profile')
const LIB_DIR = join(BRIDGE_DIR, 'libs')
const LOCK_FILE = join(BRIDGE_DIR, '.lock')
const PROJECTS_FILE = join(BRIDGE_DIR, 'projects.json')
const STATE_DIR = resolve(process.cwd(), '.chatgpt-sources')
const STATE_FILE = join(STATE_DIR, 'state.json')

process.env.LD_LIBRARY_PATH = `${LIB_DIR}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`

function resolveChromium() {
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p } catch {}
  const cacheRoot = join(HOME, '.cache', 'ms-playwright')
  try {
    const dirs = readdirSync(cacheRoot).sort().reverse()
    for (const d of dirs) {
      if (!d.startsWith('chromium-')) continue
      for (const c of [join(cacheRoot,d,'chrome-linux','chrome'), join(cacheRoot,d,'chrome-linux64','chrome')]) {
        if (existsSync(c)) return c
      }
    }
  } catch {}
  throw new Error('Chromium not found. Run: npm exec --prefix ~/.config/opencode/chatgpt-bridge playwright install chromium')
}
const EXECUTABLE = resolveChromium()

// ---- lock (reuse bridge global lock) ----
function pidAlive(pid){ try{process.kill(pid,0);return true}catch{return false} }
function acquireLock(timeoutSec=300){
  mkdirSync(BRIDGE_DIR,{recursive:true,mode:0o700})
  const deadline=Date.now()+timeoutSec*1000
  while(true){
    try{ const fd=openSync(LOCK_FILE,'wx',0o600); writeSync(fd,String(process.pid)); closeSync(fd); return }catch(e){ if(e.code!=='EEXIST') throw e }
    let owner=null; try{owner=parseInt(readFileSync(LOCK_FILE,'utf8').trim(),10)}catch{}
    if(owner && !pidAlive(owner)){ try{unlinkSync(LOCK_FILE)}catch{}; continue }
    if(Date.now()>deadline) throw new Error(`another bridge is running (pid=${owner||'?'}); timeout ${timeoutSec}s`)
    console.error(`[sources-sync] waiting for lock (pid=${owner||'?'})...`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000)
  }
}
function releaseLock(){ try{unlinkSync(LOCK_FILE)}catch{} }

// ---- helpers ----
function loadJson(p,fb){ try{return JSON.parse(readFileSync(p,'utf8'))}catch{return fb} }
function saveJsonAtomic(p,val){
  mkdirSync(join(p,'..').replace(/\/[^/]+$/, ''),{recursive:true})
  try{ mkdirSync(STATE_DIR,{recursive:true})}catch{}
  const dir = p.substring(0,p.lastIndexOf('/'))||'.'
  try{ mkdirSync(dir,{recursive:true})}catch{}
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(val,null,2)+'\n',{mode:0o600})
  renameSync(tmp,p)
}
import { createHash } from 'node:crypto'
function sha256File(p){
  const h=createHash('sha256'); h.update(readFileSync(p)); return h.digest('hex')
}
function checkSizeGate(zipPath){
  const s=statSync(zipPath); const mb=s.size/(1024*1024)
  const hard=512, soft=100
  if(s.size > hard*1024*1024) throw new Error(`SIZE_GATE_HARD: ${zipPath} ${mb.toFixed(1)}MB > ${hard}MB hard limit`)
  if(s.size > soft*1024*1024) console.error(`[sources-sync] SIZE_GATE_SOFT warn: ${mb.toFixed(1)}MB > ${soft}MB (still allowed, probe for large repo)`)
  console.error(`[sources-sync] size gate ok: ${(s.size/1024).toFixed(1)}K / ${mb.toFixed(2)}MB`)
  return s.size
}
function scanZipForSecrets(zipPath){
  // Fail-closed secret scan: scan zip contents for common secret patterns
  // Uses python to avoid extra npm deps
  const pyscript = `
import zipfile, re, sys, pathlib
path = sys.argv[1]
# Keep .git + metadata hybrid, but scan fail-closed only for real secrets, not doc mentions
patterns = [
    (r'-----BEGIN (RSA )?PRIVATE KEY-----', 'private_key'),
    (r'-----BEGIN OPENSSH PRIVATE KEY-----', 'openssh_key'),
    (r'-----BEGIN PGP PRIVATE KEY', 'pgp_key'),
    (r'AKIA[0-9A-Z]{16}', 'aws_access_key'),
    (r'aws_secret_access_key', 'aws_secret'),
    (r'ghp_[0-9a-zA-Z]{36}', 'github_pat'),
    (r'gho_[0-9a-zA-Z]{36}', 'github_oauth'),
    (r'sk-[A-Za-z0-9]{32,}', 'openai_sk'),  # longer to avoid false on short sk- mentions
    (r'sk-proj-[A-Za-z0-9-_]{32,}', 'openai_proj'),
    (r'xox[bpras]-[0-9A-Za-z-]{10,}', 'slack_token'),
]
deny_files = [r'(^|/)\\.env$', r'(^|/)\\.env\\..*', r'.*\\.pem$', r'.*\\.key$', r'.*\\.p12$', r'.*credentials.*\\.json$']
skip_content_scan = {'bin/chatgpt-sources-sync.mjs', 'bin/chatgpt-review.mjs', 'bin/gemini-review.mjs'}
# Metadata dir is generated and contains diffs that may include scanner patterns as diff context - skip content scan there
skip_prefixes = ('.chatgpt-review-metadata/',)
issues=[]
try:
    z=zipfile.ZipFile(path)
    for info in z.infolist():
        name=info.filename
        if name.endswith('.env.example'):
            continue
        for pat in deny_files:
            if re.search(pat, name, re.I):
                issues.append(f"DENY_FILE:{name} matches {pat}")
        if name in skip_content_scan or name.startswith(skip_prefixes):
            continue
        if info.file_size > 500*1024:
            continue
        try:
            data=z.read(name).decode('utf-8', errors='ignore')
        except:
            continue
        for regex, label in patterns:
            if re.search(regex, data):
                issues.append(f"SECRET:{label} in {name}")
                break
    if issues:
        for i in issues[:20]:
            print(i)
        print(f"TOTAL_ISSUES:{len(issues)}")
        sys.exit(2)
    else:
        print("SCAN_OK")
        sys.exit(0)
except Exception as e:
    print(f"SCAN_ERROR:{e}")
    sys.exit(1)
`
  try{
    const out=execFileSync('python3',['-c', pyscript, zipPath],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
    console.error(`[sources-sync] secret scan: ${out.trim()}`)
    if(out.includes('SCAN_OK')) return true
    throw new Error(`secret scan failed: ${out}`)
  }catch(e){
    const msg=e.stdout ? e.stdout.toString() : e.message
    const stderr=e.stderr ? e.stderr.toString() : ''
    console.error(`[sources-sync] secret scan output: ${msg} ${stderr}`)
    if(e.status===2) throw new Error(`PACKAGE_ABORTED_SECRET_DETECTED: ${msg.slice(0,2000)}`)
    throw new Error(`secret scan error: ${msg} ${stderr}`)
  }
}
function repoContext(){
  let root=process.cwd(), branch='default'
  try{ root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
       branch=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
  }catch{}
  let identity=root
  try{ const remote=execFileSync('git',['remote','get-url','origin'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
       const m=remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i)
       if(m) identity=m[1]
  }catch{}
  return {root,name:basename(root),branch,identity,key:`${identity}:${branch}`}
}
async function isLoggedIn(page){
  try{ const cookies=await page.context().cookies('https://chatgpt.com/'); return cookies.some(c=>c.name.startsWith('__Secure-next-auth.session-token')) }catch{return false}
}
async function handleCloudflare(page){
  for(let i=0;i<60;i++){ const url=page.url(); if(!url.includes('__cf_chl')&&!url.includes('challenges.cloudflare')) return; await new Promise(r=>setTimeout(r,2000)) }
}
async function launchPersistent(headful){
  return await chromium.launchPersistentContext(PROFILE_DIR,{
    executablePath: EXECUTABLE,
    headless: !headful,
    args: ['--no-sandbox','--disable-blink-features=AutomationControlled'],
    viewport:{width:1280,height:900}
  })
}
function projectUrl(proj){ return `https://chatgpt.com/g/${proj.slug}/project` }
async function waitForInput(page, loops=15){
  const sels=['#prompt-textarea','div[contenteditable="true"][role="textbox"]']
  for(let i=0;i<loops;i++){
    for(const s of sels){ if(await page.locator(s).first().count()) return true }
    await new Promise(r=>setTimeout(r,2000))
  }
  return false
}

async function gotoProject(page, project){
  const url=projectUrl(project)
  console.error(`[sources-sync] goto ${url}`)
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000})
  await handleCloudflare(page)
  // wait a bit for project to load
  await new Promise(r=>setTimeout(r,3000))
  const u=page.url()
  console.error(`[sources-sync] after goto url=${u.slice(0,80)} title=${await page.title().catch(()=>'-')}`)
  return u.includes('/project') || u.includes(project.slug) || u.includes(project.id)
}

// ---- Sources UI helpers ----
async function findSourcesTab(page){
  const candidates = [
    page.getByRole('tab', {name: /Sources/i}),
    page.getByRole('button', {name: /Sources/i}),
    page.locator('[data-testid*="sources"]'),
    page.locator('a:has-text("Sources")'),
    page.locator('button:has-text("Sources")'),
    page.locator('text=Sources'),
  ]
  for(const loc of candidates){
    try{ if(await loc.first().count()){ const visible=await loc.first().isVisible().catch(()=>false); if(visible) return loc.first() } }catch{}
  }
  // fallback: look for Vietnamese
  const vi = [page.getByRole('tab',{name:/Nguồn/i}), page.locator('text=Nguồn')]
  for(const loc of vi){ try{ if(await loc.first().count()) return loc.first()}catch{} }
  return null
}
async function findAddSourceButton(page){
  const cands=[
    page.getByRole('button',{name:/Add source/i}),
    page.getByRole('button',{name:/Add sources/i}),
    page.getByRole('button',{name:/Upload/i}),
    page.locator('[data-testid*="add-source"]'),
    page.locator('button:has-text("Add")'),
    page.locator('text=Add source'),
    page.locator('text=Add sources'),
  ]
  for(const loc of cands){
    try{ if(await loc.first().count()){ if(await loc.first().isVisible().catch(()=>false)) return loc.first() } }catch{}
  }
  const vi=[page.getByRole('button',{name:/Thêm nguồn/i}), page.locator('text=Thêm nguồn')]
  for(const loc of vi){ try{ if(await loc.first().count()) return loc.first()}catch{} }
  return null
}

function usage(){
  console.error(`
chatgpt-sources-sync — Project Sources sync (hybrid: keeps .git + .chatgpt-review-metadata)

USAGE:
  chatgpt-sources-sync.mjs status                      Show local state + project + zips
  chatgpt-sources-sync.mjs build [--sentinel=STR]      Build new ZIP (hybrid .git + metadata, respects .gitignore)
  chatgpt-sources-sync.mjs upload [--file=PATH] [--headless] [--timeout=SECONDS]
  chatgpt-sources-sync.mjs delete [--file=NAME]        Delete one file (local+remote)
  chatgpt-sources-sync.mjs reset [--yes]               Delete ALL local zips + ALL remote Sources + clear state (for privacy)
  chatgpt-sources-sync.mjs sync [--force]              Active manual sync: build + upload + verify + clean (re-build even if HEAD already verified with --force)
  chatgpt-sources-sync.mjs list                        (alias for status)

OPTIONS:
  --file=PATH      ZIP to upload/delete (default: current from state)
  --timeout=SECONDS wait for upload (default 180)
  --headless       try headless (may be blocked by Cloudflare)
  --headful        default
  --yes            skip confirm for reset
  --force          force rebuild even if HEAD already verified (for active manual sync)

Hybrid mode: ZIP keeps .git (source of truth) + .chatgpt-review-metadata/ for efficient retrieval. Secret scan + size gate fail-closed.
State is canonical at .chatgpt-sources/state.json (atomic). Global lock at ~/.config/opencode/chatgpt-bridge/.lock is reused.
Reset clears both local and GPT web so next sync auto re-creates.
`)
}
async function doStatus(){
  const ctx=repoContext()
  const state=loadJson(STATE_FILE,null)
  const projects=loadJson(PROJECTS_FILE,{projects:{}})
  const proj=projects.projects[ctx.name]
  console.log(JSON.stringify({repo:ctx.name, branch:ctx.branch, project:proj||null, state:state||null},null,2))
  try{
    const files=readdirSync(ctx.root).filter(f=>f.endsWith('.zip'))
    console.log('\nLocal zips in repo root:')
    for(const f of files){
      try{ const s=statSync(join(ctx.root,f)); console.log(`  ${f} ${Math.round(s.size/1024)}K ${s.mtime.toISOString()}`)}catch{}
    }
  }catch{}
}

async function doBuild(){
  let sentinelArg=null
  for(const a of process.argv.slice(3)){
    if(a.startsWith('--sentinel=')) sentinelArg=a.slice(11)
  }
  const ctx=repoContext()
  const headSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
  const shortSha=execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
  const branch=execFileSync('git',['rev-parse','--abbrev-ref','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
  const sentinel = sentinelArg || `CHATGPT_SOURCE_ZIP_PROBE_${Math.random().toString(16).slice(2,10).toUpperCase()}`
  const rand = Math.random().toString(16).slice(2,8)
  const zipName = `opencode-workflow_${shortSha}_probe_${rand}.zip`
  const zipPath = join(ctx.root, zipName)
  const staging = `/tmp/opencode-workflow-build-${rand}`
  console.error(`[build] HEAD=${headSha} short=${shortSha} branch=${branch} sentinel=${sentinel}`)
  console.error(`[build] zip=${zipName} staging=${staging}`)
  // Use rsync respecting .gitignore, exclude .git and existing zips and state
  const { execSync } = await import('node:child_process')
  try{ execSync(`rm -rf "${staging}" && mkdir -p "${staging}" && mkdir -p "${staging}/.chatgpt-review-metadata"`) }catch{}
  // rsync
  try{
    execFileSync('rsync',['-a','--filter=:- .gitignore','--exclude=.git','--exclude=*.zip','--exclude=.chatgpt-sources','--exclude=tracking-last-version.json','./', staging],{stdio:'inherit', cwd: ctx.root})
  }catch(e){
    console.error(`[build] rsync failed, fallback to git ls-files`)
    // fallback handled via python if rsync missing
  }
  // Keep .git as requested (hybrid)
  try{ execFileSync('cp',['-a', join(ctx.root,'.git'), staging],{stdio:'ignore'}) }catch{}
  // Create sentinel
  writeFileSync(join(staging,'__chatgpt_source_probe__.txt'), `${sentinel}\nRepo: opencode-workflow\nHEAD: ${headSha}\nShort: ${shortSha}\nBranch: ${branch}\nCreated: ${new Date().toISOString()}\nPurpose: hybrid probe - keeps .git + metadata\n`)
  // Metadata
  const manifest = {repo:'opencode-workflow', headSha, shortSha, branch, sentinel, zipName, createdAt: new Date().toISOString(), hybrid:true, note:'keeps .git + .chatgpt-review-metadata as requested'}
  writeFileSync(join(staging,'.chatgpt-review-metadata/manifest.json'), JSON.stringify(manifest,null,2))
  try{ writeFileSync(join(staging,'.chatgpt-review-metadata/HEAD.txt'), headSha+'\n') }catch{}
  try{ writeFileSync(join(staging,'.chatgpt-review-metadata/branch.txt'), branch+'\n') }catch{}
  try{ const st=execFileSync('git',['status','--porcelain'],{encoding:'utf8', cwd: ctx.root}); writeFileSync(join(staging,'.chatgpt-review-metadata/status.txt'), st) }catch{}
  try{ const lg=execFileSync('git',['log','--oneline','-n','20'],{encoding:'utf8', cwd: ctx.root}); writeFileSync(join(staging,'.chatgpt-review-metadata/log.txt'), lg) }catch{}
  try{ const rm=execFileSync('git',['remote','-v'],{encoding:'utf8', cwd: ctx.root}); writeFileSync(join(staging,'.chatgpt-review-metadata/remotes.txt'), rm) }catch{}
  try{ const diffStat=execFileSync('git',['diff','--stat', `origin/${branch}...HEAD`],{encoding:'utf8', cwd: ctx.root}); writeFileSync(join(staging,'.chatgpt-review-metadata/diff-stat.txt'), diffStat) }catch{}
  try{ const diff=execFileSync('git',['diff', `origin/${branch}...HEAD`],{encoding:'utf8', cwd: ctx.root}); writeFileSync(join(staging,'.chatgpt-review-metadata/diff.patch'), diff.slice(0,500000)) }catch{}
  // Zip via python (hybrid)
  const py = `
import pathlib, zipfile, os
staging=pathlib.Path("${staging}")
zip_path=pathlib.Path("${zipPath}")
with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(staging):
        for f in files:
            full=pathlib.Path(root)/f
            rel=full.relative_to(staging)
            if rel.suffix==".zip": continue
            z.write(full, arcname=str(rel))
print(f"Built {zip_path} total {len(list(zipfile.ZipFile(zip_path).infolist()))} entries")
`
  execFileSync('python3',['-c', py],{stdio:'inherit'})
  // Gates
  const sz=checkSizeGate(zipPath)
  const sha=sha256File(zipPath)
  console.error(`[build] sha256 ${sha}`)
  scanZipForSecrets(zipPath)
  console.error(`[build] secret scan PASS`)
  // Update state.json atomically (keep .git hybrid)
  let state=loadJson(STATE_FILE, {schemaVersion:1, projects:{}})
  const key = `${ctx.name}:${branch}`
  if(!state.projects[key]) state.projects[key] = {projectUrl:null, current:null, previous:null}
  const prev = state.projects[key].current
  const now = new Date().toISOString()
  state.projects[key].previous = prev
  state.projects[key].current = {artifact: zipName, hash: zipName.replace('.zip',''), headSha, shortSha, sentinel, size: sz, sha256: sha, createdAt: now, uploadedAt:null, remoteSourceId:null, remoteName:null, status:'local-only-hybrid', hybrid:true}
  saveJsonAtomic(STATE_FILE, state)
  // Also update legacy tracking-last-version.json for compatibility
  try{
    const legacyPath = join(ctx.root,'tracking-last-version.json')
    let legacy=loadJson(legacyPath, {schemaVersion:1, lastTwo:[], history:[]})
    legacy.current=zipName
    legacy.previous=prev ? prev.artifact : null
    legacy.lastTwo=[zipName, ...(prev? [prev.artifact]:[])].slice(0,2)
    legacy.history.push({artifact:zipName, headSha, shortSha, sentinel, size:sz, createdAt:now, hybrid:true})
    saveJsonAtomic(legacyPath, legacy)
  }catch{}
  console.log(JSON.stringify({built: zipName, sentinel, sha256: sha, size: sz, hybrid:true},null,2))
  // Cleanup staging
  try{ execFileSync('rm',['-rf', staging]) }catch{}
}

async function doUpload(){
  let fileArg=null, timeoutSec=180, headful=true
  for(const a of process.argv.slice(3)){
    if(a.startsWith('--file=')) fileArg=a.slice(7)
    else if(a.startsWith('--timeout=')) timeoutSec=parseInt(a.slice(10),10)
    else if(a==='--headless') headful=false
    else if(a==='--headful') headful=true
  }
  const ctx=repoContext()
  const state=loadJson(STATE_FILE,null)
  if(!state) throw new Error(`state.json not found at ${STATE_FILE}`)
  const projKey = Object.keys(state.projects)[0]
  const projState = state.projects[projKey]
  let zipPath = fileArg ? resolve(fileArg) : resolve(ctx.root, projState.current.artifact)
  if(!existsSync(zipPath)) throw new Error(`ZIP not found: ${zipPath}`)
  const zipName = basename(zipPath)
  const sentinel = projState.current.sentinel || 'unknown'
  const shortSha = projState.current.shortSha || ctx.branch
  console.error(`[sources-sync] repo=${ctx.name} branch=${ctx.branch} zip=${zipName} sentinel=${sentinel} timeout=${timeoutSec}s headful=${headful}`)
  // Production gates (keep .git + metadata hybrid as requested)
  console.error(`[sources-sync] running size gate...`)
  const zipSize = checkSizeGate(zipPath)
  const zipSha256 = sha256File(zipPath)
  console.error(`[sources-sync] sha256 ${zipSha256.slice(0,16)}... size ${(zipSize/1024).toFixed(1)}K`)
  console.error(`[sources-sync] running secret scan (fail-closed, keeps .git but scans it)...`)
  scanZipForSecrets(zipPath)
  console.error(`[sources-sync] secret scan PASS (hybrid .git + .chatgpt-review-metadata kept as requested)`)

  const projects=loadJson(PROJECTS_FILE,{projects:{}})
  let project = projects.projects[ctx.name]
  if(!project) throw new Error(`No project attached for ${ctx.name}. Run: chatgpt-review project attach <name>`)

  const ctxP = await launchPersistent(headful)
  const page = ctxP.pages()[0] || await ctxP.newPage()
  try{
    await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:60000})
    await handleCloudflare(page)
    let logged=false
    for(let i=0;i<15;i++){ if(await isLoggedIn(page)){logged=true;break} await new Promise(r=>setTimeout(r,2000)) }
    if(!logged) throw new Error('ChatGPT not signed in. Run: chatgpt-review login')

    const ok = await gotoProject(page, project)
    if(!ok) console.error(`[sources-sync] warning: project navigation may have failed, continuing`)

    // Try to find and click Sources tab
    console.error(`[sources-sync] looking for Sources tab...`)
    let sourcesTab = await findSourcesTab(page)
    if(!sourcesTab){
      // dump page content for debugging
      const title=await page.title().catch(()=>'-')
      const url=page.url()
      console.error(`[sources-sync] Sources tab not found. url=${url} title=${title}`)
      // try to screenshot
      try{ await page.screenshot({path:'/tmp/sources-sync-no-tab.png'}); console.error(`[sources-sync] screenshot saved to /tmp/sources-sync-no-tab.png`)}catch{}
      throw new Error('Sources tab not found — UI may have changed')
    }
    console.error(`[sources-sync] clicking Sources tab...`)
    await sourcesTab.click({force:true})
    await new Promise(r=>setTimeout(r,2500))

    // Look for Add source button
    console.error(`[sources-sync] looking for Add source button...`)
    let addBtn = await findAddSourceButton(page)
    // alternative: wait a bit and retry
    for(let i=0;i<5 && !addBtn;i++){ await new Promise(r=>setTimeout(r,1500)); addBtn=await findAddSourceButton(page) }
    if(!addBtn){
      const html = await page.content().catch(()=> '')
      console.error(`[sources-sync] Add source button not found. Page html snippet: ${html.slice(0,2000)}`)
      try{ await page.screenshot({path:'/tmp/sources-sync-no-add.png'}); console.error(`screenshot /tmp/sources-sync-no-add.png`)}catch{}
      throw new Error('Add source button not found')
    }
    console.error(`[sources-sync] clicking Add source...`)
    // Need to handle file chooser - Sources panel has dedicated hidden input
    // The Sources input is inside [data-project-home-sources-surface] and is the last input[type=file] without accept
    const sourcesInput = page.locator('[data-project-home-sources-surface] input[type="file"]').first()
    const inputsInPanel = page.getByRole('tabpanel').locator('input[type="file"]')
    console.error(`[sources-sync] sourcesInput count ${await sourcesInput.count()}, panel inputs ${await inputsInPanel.count()}`)
    // Try fileChooser from Add sources button first
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', {timeout: 8000}).catch(()=>null),
      addBtn.click({force:true})
    ])
    if(fileChooser){
      console.error(`[sources-sync] fileChooser detected, setting ${zipPath}`)
      await fileChooser.setFiles(zipPath)
    } else if(await sourcesInput.count()){
      console.error(`[sources-sync] no fileChooser, using Sources panel input directly`)
      await sourcesInput.setInputFiles(zipPath)
      console.error(`[sources-sync] setInputFiles via Sources input done`)
    } else if(await inputsInPanel.count()){
      console.error(`[sources-sync] fallback to tabpanel input`)
      await inputsInPanel.first().setInputFiles(zipPath)
      console.error(`[sources-sync] setInputFiles via tabpanel input done`)
    } else {
      console.error(`[sources-sync] no fileChooser event, trying generic input[type=file]`)
      const input = page.locator('input[type="file"]').first()
      if(await input.count()){
        await input.setInputFiles(zipPath)
        console.error(`[sources-sync] setInputFiles via generic input done (may go to chat, not Sources)`)
      } else {
        throw new Error('file chooser not detected and no input[type=file] found')
      }
    }

    // After file selected, some UIs show a confirmation button (Add/Upload/Save/Create)
    await new Promise(r=>setTimeout(r,1500))
    const confirmCands = [
      page.getByRole('button', {name: /Upload/i}),
      page.getByRole('button', {name: /^Add$/i}),
      page.getByRole('button', {name: /Add source/i}),
      page.getByRole('button', {name: /Save/i}),
      page.getByRole('button', {name: /Confirm/i}),
      page.getByRole('button', {name: /Create/i}),
      page.locator('button:has-text("Upload")'),
      page.locator('button:has-text("Add")'),
    ]
    for(const c of confirmCands){
      try{
        if(await c.first().count()){
          const vis = await c.first().isVisible().catch(()=>false)
          const enabled = await c.first().isEnabled().catch(()=>true)
          if(vis && enabled){
            const txt = await c.first().innerText().catch(()=>'')
            console.error(`[sources-sync] clicking confirm button: "${txt.slice(0,30)}"`)
            await c.first().click({force:true})
            await new Promise(r=>setTimeout(r,1500))
            break
          }
        }
      }catch{}
    }

    // Wait for upload to complete - look for filename in Sources list (more precise)
    console.error(`[sources-sync] waiting for "${zipName}" to appear in Sources list (timeout ${timeoutSec}s)...`)
    const deadline=Date.now()+timeoutSec*1000
    let found=false
    // We need to distinguish between file-chooser preview (text appears immediately) vs actual Sources row.
    // Sources rows are typically in a list with delete/menu buttons nearby. We'll wait a bit and check for stable presence.
    await new Promise(r=>setTimeout(r,2000))
    while(Date.now()<deadline){
      // Count occurrences - if more than one, likely one is in list
      const locs = page.locator(`text=${zipName}`)
      const n = await locs.count()
      if(n>0){
        // Check if any of them is inside a list item that looks like a source row (has delete/trash icon nearby)
        // For now, check that page content after Sources click contains the file and no obvious error toast
        const body = await page.content().catch(()=> '')
        const hasError = body.includes('Failed') || body.includes('Error') || body.includes('error')
        if(hasError) console.error(`[sources-sync] page contains error hint`)
        // If file appears and we have waited at least 3s after setFiles, consider it found, but also check for upload spinner gone
        const spinner = page.locator('[class*="spinner"], [class*="uploading"], text=Uploading').first()
        const spinning = await spinner.count().then(c=>c>0 && spinner.isVisible().catch(()=>false)).catch(()=>false)
        if(!spinning){
          console.error(`[sources-sync] FOUND ${zipName} in page (count=${n}, spinner=${spinning})`)
          found=true
          break
        } else {
          console.error(`[sources-sync] found ${zipName} but still uploading (spinner visible) count=${n}`)
        }
      }
      await new Promise(r=>setTimeout(r,2000))
    }
    if(!found){
      try{
        const body = await page.content().catch(()=> '')
        console.error(`[sources-sync] page body snippet after timeout: ${body.slice(body.indexOf(zipName)-500, body.indexOf(zipName)+500)}`)
        await page.screenshot({path:'/tmp/sources-sync-no-file.png', fullPage:true}); console.error(`screenshot /tmp/sources-sync-no-file.png`)
      }catch{}
      throw new Error(`Timeout waiting for ${zipName} to appear in Sources (after ${timeoutSec}s)`)
    }
    // Extra wait for backend to index
    console.error(`[sources-sync] waiting extra 5s for backend indexing...`)
    await new Promise(r=>setTimeout(r,5000))

    // Take screenshot for evidence
    try{ await page.screenshot({path:'/tmp/sources-sync-success.png', fullPage:true}); console.error(`[sources-sync] success screenshot /tmp/sources-sync-success.png`)}catch{}

    // Capture actual remoteName as displayed in Sources (may have (1) suffix on duplicate)
    let remoteName = zipName
    try{
      const truncates = await page.getByRole('tabpanel').locator('.truncate').all()
      for(const el of truncates){
        const txt = await el.innerText().catch(()=>'')
        if(txt.includes(shortSha) || txt.includes(sentinel.slice(-4)) || txt.includes(zipName.replace('.zip','').slice(-6))){
          remoteName = txt.trim()
          console.error(`[sources-sync] detected remoteName: ${remoteName}`)
          break
        }
      }
      // Fallback: search for any text containing zipName base
      if(remoteName===zipName){
        const loc = page.locator(`text=${zipName.replace('.zip','')}`).first()
        if(await loc.count()){
          const txt = await loc.innerText().catch(()=> '')
          if(txt && txt.includes('.zip')) remoteName = txt.trim().split('\n')[0]
        }
      }
    }catch(e){ console.error(`[sources-sync] remoteName detection failed: ${e.message}`) }

    // Update state.json atomically: mark uploaded (hybrid keeps .git)
    console.error(`[sources-sync] updating state.json: uploadedAt, status=uploaded-unverified, remoteName=${remoteName}`)
    const newState = loadJson(STATE_FILE, state)
    const pk = Object.keys(newState.projects)[0]
    newState.projects[pk].current.uploadedAt = new Date().toISOString()
    newState.projects[pk].current.status = 'uploaded-unverified'
    newState.projects[pk].current.remoteName = remoteName
    newState.projects[pk].current.remoteSourceId = null
    newState.projects[pk].current.sha256 = zipSha256
    newState.projects[pk].current.size = zipSize
    newState.projects[pk].current.hybrid = true
    const tmp = `${STATE_FILE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(newState,null,2)+'\n',{mode:0o600})
    renameSync(tmp, STATE_FILE)
    console.log(JSON.stringify({uploaded: zipName, remoteName, sentinel, sha256: zipSha256, size: zipSize, status:'uploaded-unverified', hybrid:true, screenshot:'/tmp/sources-sync-success.png'},null,2))

    // Keep browser open a bit for visual verification
    await new Promise(r=>setTimeout(r,3000))

  } finally {
    await ctxP.close()
  }
}

async function deleteRemoteFile(page, targetName){
  // Find the file row containing targetName, click its Source actions button, then Delete
  console.error(`[delete] looking for remote file "${targetName}"`)
  const panel = page.getByRole('tabpanel')
  // Find the button that contains the file name
  const fileBtn = panel.locator(`button:has-text("${targetName}")`).first()
  let row = null
  if(await fileBtn.count()){
    // The row is the parent group/file-row
    row = fileBtn.locator('xpath=ancestor::div[contains(@class,"group/file-row")]').first()
    if(!(await row.count())) row = fileBtn.locator('xpath=../..').first()
  } else {
    // Fallback: search by truncate text
    const trunc = panel.locator(`.truncate:has-text("${targetName.replace('.zip','')}")`).first()
    if(await trunc.count()){
      row = trunc.locator('xpath=ancestor::div[contains(@class,"group/file-row")]').first()
    }
  }
  if(!row || !(await row.count())){
    console.error(`[delete] row not found for ${targetName}, trying global search`)
    // Last fallback: any row containing text
    const anyLoc = panel.locator(`text=${targetName}`).first()
    if(await anyLoc.count()){
      row = anyLoc.locator('xpath=ancestor::div[contains(@class,"group/file-row")]').first()
    }
  }
  if(!row || !(await row.count())) throw new Error(`Remote file row not found: ${targetName}`)
  console.error(`[delete] found row for ${targetName}`)
  const actionsBtn = row.locator('button[aria-label="Source actions"], button:has-text("Source actions")').first()
  let btn = actionsBtn
  if(!(await btn.count())){
    // Fallback: any button with menu icon in row
    btn = row.locator('button[aria-haspopup="menu"]').first()
  }
  if(!(await btn.count())) throw new Error(`Source actions button not found for ${targetName}`)
  console.error(`[delete] clicking Source actions for ${targetName}`)
  await btn.click({force:true})
  await new Promise(r=>setTimeout(r,1200))
  // Menu should appear - look for Delete / Remove / Xóa
  const deleteCands = [
    page.getByRole('menuitem', {name: /Delete/i}),
    page.getByRole('menuitem', {name: /Remove/i}),
    page.getByRole('button', {name: /Delete/i}),
    page.locator('[role="menuitem"]:has-text("Delete")'),
    page.locator('text=Delete').first(),
    page.locator('text=Xóa').first(),
    page.locator('text=Remove').first(),
  ]
  let delBtn=null
  for(const c of deleteCands){
    try{
      if(await c.count()){
        const vis = await c.isVisible().catch(()=>false)
        if(vis){ delBtn=c.first(); break }
      }
    }catch{}
  }
  if(!delBtn) throw new Error(`Delete menuitem not found for ${targetName}`)
  console.error(`[delete] clicking Delete for ${targetName}`)
  await delBtn.click({force:true})
  await new Promise(r=>setTimeout(r,1200))
  // Confirmation dialog may appear (Delete / Confirm / Yes)
  const confirmCands = [
    page.getByRole('button', {name: /Delete/i}),
    page.getByRole('button', {name: /Confirm/i}),
    page.getByRole('button', {name: /Yes/i}),
    page.locator('button:has-text("Delete")'),
    page.locator('[data-testid*="confirm"]'),
  ]
  for(const c of confirmCands){
    try{
      if(await c.count()){
        const vis = await c.isVisible().catch(()=>false)
        const txt = await c.innerText().catch(()=> '')
        if(vis && txt && /Delete|Confirm|Yes|Xóa/i.test(txt)){
          console.error(`[delete] confirming with "${txt.slice(0,30)}"`)
          await c.first().click({force:true})
          await new Promise(r=>setTimeout(r,1500))
          break
        }
      }
    }catch{}
  }
  // Wait for file to disappear
  const deadline=Date.now()+15000
  while(Date.now()<deadline){
    const still = await panel.locator(`text=${targetName}`).first().count()
    if(still===0){ console.error(`[delete] ${targetName} no longer in panel - success`); return true }
    await new Promise(r=>setTimeout(r,800))
  }
  console.error(`[delete] warning: ${targetName} still visible after delete`)
  return false
}

async function doDelete(){
  let target=null, headful=true
  for(const a of process.argv.slice(3)){
    if(a.startsWith('--file=')) target=a.slice(7)
    else if(a==='--headless') headful=false
    else if(a==='--headful') headful=true
    else if(!a.startsWith('--')) target=a
  }
  const ctx=repoContext()
  let toDelete = target
  if(!toDelete){
    // Default: delete oldest local zip beyond retention (keep 2 latest)
    const state=loadJson(STATE_FILE,null)
    if(state){
      const key=Object.keys(state.projects)[0]
      const prev = state.projects[key].previous
      // If we have 3 local files, the oldest is the one not in current/previous
      const files = readdirSync(ctx.root).filter(f=>f.endsWith('.zip')).sort()
      const keep = new Set([state.projects[key].current?.artifact, prev?.artifact].filter(Boolean))
      const candidates = files.filter(f=>!keep.has(f))
      if(candidates.length>0) toDelete = candidates[0]
      else throw new Error('No file to delete (all local files are current/previous)')
    }
  }
  if(!toDelete) throw new Error('No target file specified')
  const localPath = join(ctx.root, toDelete)
  console.error(`[delete] target local: ${localPath} exists=${existsSync(localPath)}`)

  const projects=loadJson(PROJECTS_FILE,{projects:{}})
  let project = projects.projects[ctx.name]
  if(!project) throw new Error(`No project attached for ${ctx.name}`)

  // Remote delete via Playwright
  const ctxP = await launchPersistent(headful)
  const page = ctxP.pages()[0] || await ctxP.newPage()
  let remoteOk=false
  try{
    await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:60000})
    await handleCloudflare(page)
    let logged=false
    for(let i=0;i<15;i++){ if(await isLoggedIn(page)){logged=true;break} await new Promise(r=>setTimeout(r,2000)) }
    if(!logged) throw new Error('ChatGPT not signed in')
    const ok = await gotoProject(page, project)
    if(!ok) console.error(`[delete] project navigation warning`)
    const tab = await findSourcesTab(page)
    if(!tab) throw new Error('Sources tab not found')
    await tab.click({force:true})
    await new Promise(r=>setTimeout(r,2500))
    // Try to delete remote
    try{
      remoteOk = await deleteRemoteFile(page, toDelete)
    }catch(e){
      console.error(`[delete] remote delete failed: ${e.message}`)
      // Also try with remoteName variant (with (1))
      if(toDelete.includes('probe')){
        const alt = toDelete.replace('.zip','(1).zip')
        try{
          console.error(`[delete] retry with alt name ${alt}`)
          remoteOk = await deleteRemoteFile(page, alt)
        }catch(e2){ console.error(`[delete] alt also failed: ${e2.message}`) }
      }
      if(!remoteOk) throw e
    }
    await page.screenshot({path:'/tmp/delete-success.png', fullPage:true}).catch(()=>{})
    console.error(`[delete] screenshot /tmp/delete-success.png`)
  } finally {
    await ctxP.close()
  }

  // Local delete
  let localOk=false
  if(existsSync(localPath)){
    try{ unlinkSync(localPath); localOk=true; console.error(`[delete] local deleted ${toDelete}`)}catch(e){ console.error(`[delete] local delete failed: ${e.message}`)}
  } else {
    console.error(`[delete] local file not found, already deleted`)
    localOk=true
  }

  // Update state if needed (if deleted file was tracked)
  try{
    const state=loadJson(STATE_FILE,null)
    if(state){
      const key=Object.keys(state.projects)[0]
      // If we deleted the previous, clear it
      if(state.projects[key].previous?.artifact === toDelete){
        state.projects[key].previous = null
        saveJsonAtomic(STATE_FILE, state)
        console.error(`[delete] cleared previous in state.json`)
      }
    }
  }catch{}

  console.log(JSON.stringify({deleted: toDelete, remote: remoteOk, local: localOk},null,2))
}

async function doSync(){
  // Full rotation: build (if HEAD changed or no zip) -> upload -> verify -> delete oldest
  // Active manual sync: use --force to rebuild even if HEAD already verified (different from auto waiting for feature)
  console.error(`[sync] starting full sync (build+upload+verify+clean) - active manual mode`)
  const force = process.argv.includes('--force')
  const ctx=repoContext()
  const headSha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
  let state=loadJson(STATE_FILE,null)
  let needBuild = true
  if(state && !force){
    const key=Object.keys(state.projects)[0]
    const cur = state.projects[key]?.current
    if(cur && cur.headSha===headSha && cur.status==='verified'){
      console.error(`[sync] current already verified for HEAD ${headSha.slice(0,7)}, use --force to rebuild anyway (active manual sync)`)
      needBuild=false
    } else if(cur && cur.headSha===headSha && cur.uploadedAt){
      console.error(`[sync] current already built for HEAD ${headSha.slice(0,7)}, use --force to rebuild`)
      needBuild=false
    }
  } else if(force){
    console.error(`[sync] --force: will rebuild even though HEAD ${headSha.slice(0,7)} already has verified artifact`)
  }
  if(needBuild){
    console.error(`[sync] building new hybrid ZIP for HEAD ${headSha.slice(0,7)}`)
    await doBuild()
    state=loadJson(STATE_FILE,null)
  }
  console.error(`[sync] uploading current...`)
  await doUpload()
  // Verify via fresh chat (use bridge)
  console.error(`[sync] verifying via fresh Project chat...`)
  const cur = loadJson(STATE_FILE,null).projects[Object.keys(loadJson(STATE_FILE,null).projects)[0]].current
  const sentinel = cur.sentinel
  // Use bridge ask to verify
  const { execFileSync: ef } = await import('node:child_process')
  const prompt = `Trong Project auto-zip, đọc file __chatgpt_source_probe__.txt trong ZIP vừa upload. Trả lời chính xác dòng đầu tiên (CHATGPT_SOURCE_ZIP_PROBE_...). Nếu không thấy, trả lời NOT_FOUND. Sentinel mong đợi: ${sentinel}`
  let verifyOk=false
  try{
    const out = ef(`cat <<'PROMPT' | NODE_PATH=/home/audition/.config/opencode/chatgpt-bridge/node_modules /home/audition/.config/opencode/chatgpt-bridge/bin/chatgpt-review ask --project --new --timeout=90 2>&1
${prompt}
PROMPT`, {encoding:'utf8', shell:'/bin/bash', timeout:120000})
    console.error(`[sync] verify output: ${out.slice(0,500)}`)
    if(out.includes(sentinel)) verifyOk=true
  }catch(e){
    console.error(`[sync] verify failed: ${e.message}`)
  }
  if(!verifyOk) throw new Error(`Verification failed: sentinel ${sentinel} not retrieved`)
  console.error(`[sync] verify PASS, promoting and cleaning old...`)
  // Mark verified
  state=loadJson(STATE_FILE,null)
  const key=Object.keys(state.projects)[0]
  state.projects[key].current.status='verified'
  state.projects[key].current.verifiedAt=new Date().toISOString()
  saveJsonAtomic(STATE_FILE, state)
  // Clean oldest local (beyond retention 2)
  const files = readdirSync(ctx.root).filter(f=>f.endsWith('.zip')).sort()
  const keep = new Set([state.projects[key].current?.artifact, state.projects[key].previous?.artifact].filter(Boolean))
  const toDeleteLocal = files.filter(f=>!keep.has(f))
  for(const f of toDeleteLocal){
    try{ unlinkSync(join(ctx.root,f)); console.error(`[sync] cleaned old local ${f}`)}catch{}
  }
  console.log(JSON.stringify({synced: cur.artifact, sentinel, verified: verifyOk},null,2))
}

async function doReset(){
  let headful=true, yes=false
  for(const a of process.argv.slice(3)){
    if(a==='--headless') headful=false
    else if(a==='--headful') headful=true
    else if(a==='--yes' || a==='-y') yes=true
  }
  const ctx=repoContext()
  if(!yes){
    console.error(`[reset] This will DELETE:`)
    try{
      const files=readdirSync(ctx.root).filter(f=>f.endsWith('.zip'))
      console.error(`  local zips (${files.length}): ${files.join(', ') || '(none)'}`)
    }catch{}
    console.error(`  remote Sources in project auto-zip (all files)`)
    console.error(`  local state: .chatgpt-sources/state.json + tracking-last-version.json`)
    console.error(`[reset] Run with --yes to confirm`)
    process.exit(1)
  }
  // 1) Delete ALL remote Sources via Playwright
  console.error(`[reset] deleting ALL remote Sources...`)
  const projects=loadJson(PROJECTS_FILE,{projects:{}})
  let project = projects.projects[ctx.name]
  if(project){
    const ctxP = await launchPersistent(headful)
    const page = ctxP.pages()[0] || await ctxP.newPage()
    try{
      await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:60000})
      await handleCloudflare(page)
      let logged=false
      for(let i=0;i<15;i++){ if(await isLoggedIn(page)){logged=true;break} await new Promise(r=>setTimeout(r,2000)) }
      if(!logged) throw new Error('ChatGPT not signed in')
      const ok = await gotoProject(page, project)
      if(!ok) console.error(`[reset] project navigation warning`)
      const tab = await findSourcesTab(page)
      if(!tab) throw new Error('Sources tab not found')
      await tab.click({force:true})
      await new Promise(r=>setTimeout(r,2500))
      // Enumerate all file rows and delete one by one
      let deletedCount=0
      while(true){
        const panel = page.getByRole('tabpanel')
        const rows = await panel.locator('div.group\\/file-row').all()
        if(rows.length===0){ console.error(`[reset] no more remote files`); break }
        // Get first row's file name
        let firstName=null
        try{
          const trunc = await rows[0].locator('.truncate').first().innerText().catch(()=> '')
          firstName = trunc.trim()
        }catch{}
        if(!firstName){
          try{
            const txt = await rows[0].innerText()
            const m=txt.match(/opencode-workflow[^\n]*\.zip/)
            if(m) firstName=m[0]
          }catch{}
        }
        if(!firstName) firstName = `row0`
        console.error(`[reset] deleting remote file ${deletedCount+1}/${rows.length}: ${firstName}`)
        const actionsBtn = rows[0].locator('button[aria-label="Source actions"], button[aria-haspopup="menu"]').first()
        if(!(await actionsBtn.count())){ console.error(`[reset] actions button not found`); break }
        await actionsBtn.click({force:true})
        await new Promise(r=>setTimeout(r,1000))
        const delBtn = page.getByRole('menuitem', {name: /Delete/i}).first()
        let delFound=false
        if(await delBtn.count() && await delBtn.isVisible().catch(()=>false)){
          await delBtn.click({force:true})
          delFound=true
        } else {
          const alt = page.locator('text=Delete').first()
          if(await alt.count()){ await alt.click({force:true}); delFound=true }
        }
        if(!delFound){ console.error(`[reset] Delete menuitem not found`); break }
        await new Promise(r=>setTimeout(r,1000))
        // Confirm
        const confirmBtn = page.getByRole('button', {name: /Delete/i}).first()
        if(await confirmBtn.count() && await confirmBtn.isVisible().catch(()=>false)){
          await confirmBtn.click({force:true})
          await new Promise(r=>setTimeout(r,1500))
        }
        await new Promise(r=>setTimeout(r,1500))
        deletedCount++
        if(deletedCount>20){ console.error(`[reset] too many deletions, abort`); break }
      }
      console.error(`[reset] remote delete done, deleted ${deletedCount} files`)
      await page.screenshot({path:'/tmp/reset-remote.png', fullPage:true}).catch(()=>{})
    } finally {
      await ctxP.close()
    }
  } else {
    console.error(`[reset] no project attached, skipping remote delete`)
  }
  // 2) Delete ALL local zips
  try{
    const files=readdirSync(ctx.root).filter(f=>f.endsWith('.zip') || f.endsWith('.md') && f.startsWith('opencode-workflow_'))
    for(const f of files){
      try{ unlinkSync(join(ctx.root,f)); console.error(`[reset] deleted local ${f}`)}catch(e){ console.error(`[reset] failed to delete ${f}: ${e.message}`)}
    }
  }catch{}
  // 3) Clear state
  try{
    const statePath = STATE_FILE
    if(existsSync(statePath)) { unlinkSync(statePath); console.error(`[reset] deleted ${statePath}`)}
    // Also try to remove dir if empty
    try{ const dirFiles=readdirSync(STATE_DIR); if(dirFiles.length===0) { const { rmdirSync } = await import('node:fs'); rmdirSync(STATE_DIR) } }catch{}
  }catch{}
  try{
    const legacyPath = join(ctx.root,'tracking-last-version.json')
    if(existsSync(legacyPath)) { unlinkSync(legacyPath); console.error(`[reset] deleted ${legacyPath}`)}
  }catch{}
  try{
    const altPath = join(ctx.root,'.sources-tracking.json')
    if(existsSync(altPath)) unlinkSync(altPath)
  }catch{}
  console.log(JSON.stringify({reset: true, note: 'Local and remote Sources cleared. Next sync will auto rebuild and upload.'},null,2))
}

const cmd = process.argv[2]
if(!cmd || cmd==='help' || cmd==='--help'){ usage(); process.exit(0) }
if(cmd==='status' || cmd==='list'){ await doStatus() }
else if(cmd==='build'){
  acquireLock(300)
  try{ await doBuild() } finally{ releaseLock() }
}
else if(cmd==='upload'){
  acquireLock(300)
  try{ await doUpload() } finally{ releaseLock() }
}
else if(cmd==='delete' || cmd==='clean'){
  acquireLock(300)
  try{ await doDelete() } finally{ releaseLock() }
}
else if(cmd==='reset'){
  acquireLock(300)
  try{ await doReset() } finally{ releaseLock() }
}
else if(cmd==='sync'){
  acquireLock(300)
  try{ await doSync() } finally{ releaseLock() }
} else { console.error(`unknown cmd: ${cmd}`); usage(); process.exit(1) }
