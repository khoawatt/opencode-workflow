export const MAX_ROUTE_RECOVERIES = 3
export const OPENAI_AUTH_STUCK_MS = 25000
export const OPENAI_AUTH_HARD_TIMEOUT_MS = 60000
export const OPENAI_AUTH_TRANSACTION_STORAGE_KEY_PATTERN = '(^|[._-])(state|nonce|transaction|transact|pkce|code[_-]?verifier|csrf)([._-]|$)|^a0\\.spajs\\.txs\\.'

export const ROUTE_RECOVERY_EXHAUSTED_MESSAGE = [
  'Auth0 Route Error vẫn lặp lại sau 3 lần recovery.',
  'Chạy lần lượt:',
  'chatgpt-review logout',
  'chatgpt-review login',
].join('\n')

export function isAuth0RouteError(bodyText) {
  return /oops,? an error occurred|route error|invalid content type/i.test(bodyText || '')
}

export function detectOpenAiAuthBlocker(bodyText, url) {
  if (!bodyText) return null
  bodyText = String(bodyText).toLowerCase()
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

export function isOpenAiAuthTransactionCookie(cookie) {
  const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase()
  const onAuthOrigin = domain === 'auth.openai.com'
    || domain === 'accounts.openai.com'
    || domain === 'auth0.openai.com'
    || domain.endsWith('.auth0.com')
  if (!onAuthOrigin) return false

  const name = String(cookie?.name || '').toLowerCase()
  return isOpenAiAuthTransactionStorageKey(name)
}

export function isOpenAiAuthTransactionStorageKey(key) {
  return new RegExp(OPENAI_AUTH_TRANSACTION_STORAGE_KEY_PATTERN, 'i').test(String(key || ''))
}

export function isOpenAiAuthUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === 'auth.openai.com'
      || hostname === 'accounts.openai.com'
      || hostname === 'auth0.openai.com'
      || hostname.endsWith('.auth0.com')
  } catch {
    return false
  }
}

export function isRecoverableOpenAiRouteError(bodyText, url) {
  return isOpenAiAuthUrl(url) && isAuth0RouteError(bodyText)
}

export function createOpenAiAuthAttempt(maxRecoveries = MAX_ROUTE_RECOVERIES) {
  return {
    maxRecoveries,
    recoveries: 0,
    passwordSubmitted: false,
  }
}

export function claimPasswordSubmit(attempt) {
  if (attempt.passwordSubmitted) return false
  attempt.passwordSubmitted = true
  return true
}

export function claimRouteRecovery(attempt) {
  if (attempt.recoveries >= attempt.maxRecoveries) return false
  attempt.recoveries++
  attempt.passwordSubmitted = false
  return true
}

export async function waitForOpenAiPasswordOutcome({
  observe,
  wait,
  now = Date.now,
  pollMs = 750,
  stuckMs = OPENAI_AUTH_STUCK_MS,
  hardTimeoutMs = OPENAI_AUTH_HARD_TIMEOUT_MS,
}) {
  const startedAt = now()
  while (true) {
    const observation = await observe()
    if (observation.state !== 'pending') return observation

    const elapsed = now() - startedAt
    if (elapsed >= hardTimeoutMs) return { state: 'timeout' }
    if (!observation.busy && elapsed >= stuckMs) return { state: 'stuck' }

    await wait(Math.min(pollMs, hardTimeoutMs - elapsed))
  }
}
