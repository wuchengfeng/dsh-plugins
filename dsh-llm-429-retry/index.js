/**
 * dsh-llm-429-retry
 *
 * Recovers from transient rate-limit (HTTP 429) failures on model requests
 * that the built-in retry policy would otherwise drop or give up on too
 * quickly, and retries them with a robust, signal-aware backoff.
 *
 * Why this exists: the shipped classifier maps an HTTP 429 whose response
 * body mentions quota/balance wording to the terminal `QUOTA` code (the quota
 * check runs before the 429 check), so `dsh-llm-retry` never retries it and
 * the turn fails with "额度已用尽". A 429 is a transient rate limit, not a
 * permanent quota, so it is safe — and correct — to wait and retry.
 *
 * This listener takes over recovery (returns `{ kind: 'retry' }` without
 * calling `next()`) only for failures it can prove are transient:
 *   - `failure.status === 429`, or
 *   - `failure.code === 'RATE_LIMIT'`, or
 *   - rate-limit wording in `failure.message`/`failure.code` (without quota wording).
 * Every other failure delegates to `next()` so the default `llm-retry`
 * policy and any other listeners keep their normal behavior.
 *
 * Tunables live in the plugin row's `config` and are read with defaults below
 * (no external schema dependency, so a locally linked bundle always loads).
 */

export const name = 'llm-429-retry'

const DEFAULTS = {
  /** Maximum retries for one failed request attempt (after the first request). */
  maxRetries: 12,
  /** Initial backoff delay in milliseconds. */
  initialDelayMs: 1000,
  /** Upper bound on the locally computed backoff delay in milliseconds. */
  maxDelayMs: 60000,
  /** Honor a provider `Retry-After` hint (capped at maxDelayMs). */
  honorRetryAfter: true,
  /** Symmetric jitter ratio applied around each local delay (0..1). */
  jitterRatio: 0.2,
  /** When true, only providers listed in `providers` are retried. */
  restrictProviders: false,
  /** Provider ids to cover when `restrictProviders` is true. */
  providers: [],
}

function int(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function number(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value
  return fallback
}

function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    maxRetries: int(c.maxRetries, DEFAULTS.maxRetries, 1, 30),
    initialDelayMs: int(c.initialDelayMs, DEFAULTS.initialDelayMs, 100, 60000),
    maxDelayMs: int(c.maxDelayMs, DEFAULTS.maxDelayMs, 1000, 300000),
    honorRetryAfter: bool(c.honorRetryAfter, DEFAULTS.honorRetryAfter),
    jitterRatio: number(c.jitterRatio, DEFAULTS.jitterRatio, 0, 1),
    restrictProviders: bool(c.restrictProviders, DEFAULTS.restrictProviders),
    providers: Array.isArray(c.providers) ? c.providers.map(String) : [...DEFAULTS.providers],
  }
}

// Rate-limit / transient wording that a misclassified 429 may carry.
const RATE_LIMIT_WORDING = [
  /rate[\s_-]?limit/i,
  /too\s+many\s+requests/i,
  /throttl/i,
  /slow\s*down/i,
  /\b429\b/,
  // Chinese wording commonly returned by OpenAI-compatible gateways.
  /限流/,
  /请求过于频繁/,
  /访问频率/,
  /请求频率/,
  /稍后重试/,
  /请稍后再试/,
  /请稍后尝试/,
]

// Terminal quota wording — a genuine, permanent "balance exhausted" must NOT
// be retried, only a 429 (transient) may be. An explicit 429 status is treated
// as transient even if the body also carries quota wording, because the status
// code is authoritative for "try again later".
const QUOTA_WORDING = [
  /insufficient[\s_-]+(?:quota|balance|credits?)/i,
  /(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)/i,
  /out[\s_-]+of[\s_-]+(?:credits?|budget)/i,
  /(?:balance|credits?)[\s_-]+(?:exhausted|depleted)/i,
  /余额不足/,
  /额度已用尽/,
  /额度不足/,
  /配额不足/,
  /欠费/,
]

function isRetryableStatus(status) {
  return status === 429
}

function isRetryableCode(code) {
  return code === 'RATE_LIMIT'
}

function isRateLimitWording(text) {
  return RATE_LIMIT_WORDING.some((re) => re.test(text))
}

function isQuotaWording(text) {
  return QUOTA_WORDING.some((re) => re.test(text))
}

function providerInScope(provider, config) {
  if (!config.restrictProviders) return true
  return config.providers.includes(provider)
}

/**
 * Decide whether a failure is a transient rate limit worth retrying.
 * A 429 status is authoritative; quota wording alone (without 429) is
 * treated as terminal so we never mask a real "balance exhausted" error.
 */
function isTransientRateLimit(failure) {
  const { status, code, message } = failure
  if (status !== undefined && isRetryableStatus(status)) return true
  if (isRetryableCode(code)) return true
  // No explicit 429/RATE_LIMIT: only retry if the text clearly signals a
  // rate limit and does NOT signal an exhausted quota/balance.
  const text = `${code ?? ''} ${message ?? ''}`
  if (isRateLimitWording(text) && !isQuotaWording(text)) return true
  return false
}

function jitteredDelay(baseMs, jitterRatio, random) {
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.min(Math.max(0, baseMs * jitter), Number.MAX_SAFE_INTEGER)
}

function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install recovery for transient rate-limit failures. Per-request retry
 * bookkeeping is keyed by `${provider}\u0000${turn}\u0000${step}` so a fresh
 * step starts from zero while a burst within one step counts toward the cap.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const attempts = new Map()
  // Steps run sequentially, so a new turn/step makes older keys stale; prune
  // them to keep the map bounded over long sessions.
  let currentStep = null
  const random = Math.random

  const dispose = ctx.on('agent/request-error', async (payload, next) => {
    const { turn, step, provider, failure, signal } = payload

    if (!providerInScope(provider, config)) return next()
    if (!isTransientRateLimit(failure)) return next()

    const stepKey = `${turn}\u0000${step}`
    if (stepKey !== currentStep) {
      currentStep = stepKey
      attempts.clear()
    }
    const key = `${provider}\u0000${turn}\u0000${step}`
    const count = (attempts.get(key) ?? 0) + 1
    attempts.set(key, count)
    if (count > config.maxRetries) {
      attempts.delete(key)
      ctx.logger.warn(
        `llm-429-retry: provider "${provider}" exceeded ${config.maxRetries} retries (turn ${turn}, step ${step}); giving up`,
      )
      return next()
    }

    let delayMs
    const providerHint = failure.providerRetryAfterMs
    if (config.honorRetryAfter && Number.isFinite(providerHint) && providerHint > 0) {
      // Respect the provider's Retry-After hint, but never wait forever.
      delayMs = Math.min(providerHint, config.maxDelayMs)
    } else {
      const exponent = Math.min(count - 1, 20)
      const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
      delayMs = jitteredDelay(exponential, config.jitterRatio, random)
    }

    ctx.logger.info(
      `llm-429-retry: retrying provider "${provider}" (attempt ${count}/${config.maxRetries}, ` +
        `${Math.round(delayMs)}ms) after ${failure.code}` +
        `${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''}`,
    )

    if (!(await cancellableDelay(delayMs, signal))) {
      // Turn was aborted during the wait; do not retry.
      attempts.delete(key)
      return undefined
    }
    return { kind: 'retry' }
  })

  return () => {
    dispose()
    attempts.clear()
  }
}
