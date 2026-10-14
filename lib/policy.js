/**
 * Retry policy for a model request the harness's own retry executor declined.
 *
 * This module is deliberately free of any Cordis or harness import: every
 * allow/deny rule and every delay lives here so the whole decision surface can
 * be exercised with `node --test` against a plain object, with no harness to
 * boot and no mock of the runtime to reason about. `lib/index.js` owns the
 * wiring only.
 *
 * The policy exists because `@deepseek-ai/dsh-llm-retry` — the executor the
 * harness mounts by default — retries only a narrow, fixed set of failure codes
 * within a bounded budget. When it declines, it calls its waterfall's `next()`,
 * which is where this plugin is attached. So the decision surface here is
 * exactly "official said no; should we say yes?".
 *
 * @module dsh-plugin-auto-retry/policy
 */

/**
 * Failure codes this plugin is willing to take over by default.
 *
 * The first five are the harness's own default retryable set
 * (`@deepseek-ai/dsh-llm`'s `DEFAULT_RETRYABLE_CODES`). Listing them here is
 * what turns "official exhausted its five attempts" into "we add three more":
 * by the time a failure reaches this plugin the official budget is already
 * spent, so accepting the code extends the chain rather than duplicating it.
 *
 * The last two are the catch-all codes the two adapters in this profile fall
 * back to when their own classifiers recognize nothing:
 * `dsh-llm-pi-ai`'s `classifyPiAiError()` returns `PI_AI_ERROR`, and
 * `dsh-plugin-kilo-gateway`'s `failureCodeForStatus()` returns
 * `PROVIDER_ERROR`. Neither is in the official set, so today neither is ever
 * retried at all — which is the largest single gap this plugin closes.
 *
 * `QUOTA`, `ACCOUNT_QUOTA`, `INVALID_REQUEST`, and `UNKNOWN` are deliberately
 * absent: each is just as likely to be a genuinely terminal failure as a
 * transient one, so the deployment decides by adding it to `retryableCodes`.
 * Routing on code — never on message text — is the harness's own rule.
 */
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'PROVIDER_ERROR',
  'PI_AI_ERROR',
]);

/**
 * Failure codes this plugin never retries, whatever the allowlist says.
 *
 * A hard floor rather than a default, because every member is a failure that a
 * retry provably cannot fix, or one that another component already owns:
 *
 * - `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` — a credential fails
 *   identically on every attempt.
 * - `NO_ADAPTER`, `INVALID_MODEL`, `INVALID_CONFIG` — composition errors.
 * - `CONTEXT_WINDOW_EXCEEDED` — owned by the compaction pipeline.
 * - `IMAGE_OFFLOAD_REQUIRED` — owned by `dsh-compaction-image-offload`, which
 *   retries itself after offloading more images.
 * - `ABORTED` — the user cancelled; retrying would fight them.
 *
 * The check runs before the allowlist, so a typo that lands one of these in
 * `retryableCodes` cannot unlock it.
 */
export const NEVER_RETRY_CODES = Object.freeze(
  new Set([
    'AUTH',
    'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL',
    'NO_ADAPTER',
    'INVALID_MODEL',
    'INVALID_CONFIG',
    'CONTEXT_WINDOW_EXCEEDED',
    'IMAGE_OFFLOAD_REQUIRED',
    'ABORTED',
  ]),
);

/**
 * The namespace our policy key starts with.
 *
 * `@deepseek-ai/dsh-llm-retry` derives its own key as
 * `JSON.stringify([mode, ...])`, so its keys always begin `["normal"` or
 * `["always"`. Ours begins `["auto-retry"`, which is what keeps the two chains
 * separate inside the shared `llmRetry` session projection: official's counter
 * and ours advance independently, and neither can exhaust the other's budget.
 */
export const POLICY_KEY_NAMESPACE = 'auto-retry';

/** Serialized prefix used to recognize our own entries in the shared projection. */
const POLICY_KEY_PREFIX = `["${POLICY_KEY_NAMESPACE}"`;

/**
 * Defaults for an ordinary interactive session.
 *
 * `extraRetries: 3` is what the deployment chose: enough to ride out a flapping
 * relay without letting a permanently broken route multiply every turn.
 * `initialDelayMs: 1000` applies only when the official executor never tried —
 * when it did, {@link continuationDelay} continues the official curve instead.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  extraRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
});

/**
 * Whether a failure code is one this plugin is willing to retry.
 *
 * @param {{code?: unknown} | null | undefined} failure - one `LlmFailure`.
 * @param {{enabled: boolean, retryableCodes: readonly string[]}} settings
 * @returns {{eligible: boolean, why: string}}
 */
export function isEligible(failure, settings) {
  if (failure === null || typeof failure !== 'object') {
    return { eligible: false, why: 'malformed-failure' };
  }
  if (typeof failure.code !== 'string' || failure.code.length === 0) {
    return { eligible: false, why: 'malformed-failure' };
  }
  // The hard floor runs first: it is the one rule an allowlist entry cannot
  // override, so it has to be evaluated before the allowlist is consulted.
  if (NEVER_RETRY_CODES.has(failure.code)) {
    return { eligible: false, why: 'hard-denied' };
  }
  if (!settings.enabled) return { eligible: false, why: 'disabled' };
  // `Array.isArray` is load-bearing, not defensive noise: a bare string reaches
  // `String.prototype.includes`, where any substring would match and an
  // allowlist typo would silently authorize codes nobody listed.
  if (!Array.isArray(settings.retryableCodes) || !settings.retryableCodes.includes(failure.code)) {
    return { eligible: false, why: 'code-not-listed' };
  }
  return { eligible: true, why: 'eligible' };
}

/**
 * Bounded exponential backoff with symmetric jitter, matching the harness's own
 * `localDelay()` in `@deepseek-ai/dsh-llm-retry` term for term.
 *
 * Reproduced rather than configured because the curve shape is not a knob the
 * deployment tunes — the attempt budget and the two endpoints are. Keeping it
 * identical means our continuation of an official chain is indistinguishable
 * from the chain's own next step.
 *
 * @param {number} retry - 1-based position on the curve.
 * @param {{initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} curve
 * @param {() => number} random - uniform [0, 1) source.
 * @returns {number} the delay in milliseconds.
 */
export function localDelay(retry, curve, random) {
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(curve.initialDelayMs * 2 ** exponent, curve.maxDelayMs);
  const jitter = 1 - curve.jitterRatio + 2 * curve.jitterRatio * random();
  return Math.min(exponential * jitter, curve.maxDelayMs);
}

/**
 * The delay for one of our attempts, continuing the official curve rather than
 * restarting it.
 *
 * The deployment's rule is: if the official executor never tried this failure,
 * start at our own `initialDelayMs` (a second — nothing has been waited out
 * yet); if it did try, pick up where it left off, one step past the longest
 * delay it already used. Continuing matters because official's own curve is
 * already deep into its backoff by the time it gives up: restarting at one
 * second would hammer a provider that had just asked us to slow down.
 *
 * The curve's parameters come from official's resolved policy carried on the
 * waterfall payload, so the continuation is numerically seamless. Our own
 * `maxDelayMs` stays the outer ceiling regardless.
 *
 * @param {number} officialRetry - retries official already scheduled this step.
 * @param {number} ourRetry - our 1-based attempt index.
 * @param {{initialDelayMs?: unknown, maxDelayMs?: unknown, jitterRatio?: unknown} | undefined} officialPolicy
 * @param {{initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} settings
 * @param {() => number} random - uniform [0, 1) source.
 * @returns {number} the delay in milliseconds.
 */
export function continuationDelay(officialRetry, ourRetry, officialPolicy, settings, random) {
  if (!Number.isSafeInteger(officialRetry) || officialRetry <= 0) {
    return localDelay(ourRetry, settings, random);
  }
  const curve = {
    initialDelayMs: positive(officialPolicy?.initialDelayMs, settings.initialDelayMs),
    maxDelayMs: Math.min(positive(officialPolicy?.maxDelayMs, settings.maxDelayMs), settings.maxDelayMs),
    jitterRatio: ratio(officialPolicy?.jitterRatio, settings.jitterRatio),
  };
  return localDelay(officialRetry + ourRetry, curve, random);
}

/**
 * Let a provider-requested delay win over the computed one.
 *
 * A valid `Retry-After` is the provider telling us exactly when it will accept
 * requests again, which is better information than any local curve. It is
 * clamped to our `maxDelayMs` so a hostile or mistaken header cannot park a
 * turn for an hour.
 *
 * Deliberate divergence from `@deepseek-ai/dsh-llm-retry`: its normal mode
 * declines to retry at all when `providerRetryAfterMs > maxDelayMs`. Clamping
 * instead keeps the attempt, on the grounds that the provider asked us to wait
 * rather than to stop.
 *
 * @param {{providerRetryAfterMs?: unknown} | null | undefined} failure
 * @param {number} computedDelay - the locally computed delay.
 * @param {{maxDelayMs: number}} settings
 * @returns {number}
 */
export function resolveDelay(failure, computedDelay, settings) {
  const provider = failure?.providerRetryAfterMs;
  if (Number.isFinite(provider) && provider > 0) {
    return Math.min(provider, settings.maxDelayMs);
  }
  return computedDelay;
}

/**
 * Our policy key, namespaced so it can never collide with official's.
 *
 * Every field that changes behaviour is part of the key, because the shared
 * `llmRetry` projection tracks a separate counter per `(provider, policyKey)`:
 * editing the budget or the allowlist must start a fresh chain rather than
 * inherit an exhausted one. The allowlist is sorted so a reordering alone does
 * not fork the chain.
 *
 * @param {{extraRetries: number, retryableCodes: readonly string[], initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} settings
 * @returns {string}
 */
export function policyKey(settings) {
  return JSON.stringify([
    POLICY_KEY_NAMESPACE,
    settings.extraRetries,
    [...settings.retryableCodes].sort(),
    settings.initialDelayMs,
    settings.maxDelayMs,
    settings.jitterRatio,
  ]);
}

/**
 * How many retries official already scheduled for one provider in this step.
 *
 * Read from the shared `llmRetry` projection, whose entries are keyed
 * `JSON.stringify([provider, policyKey])` and whose state resets on `step/start`
 * and `turn/end` — exactly the per-step scope this question needs. Our own
 * entries are skipped by their namespace prefix, and the maximum across a
 * provider's chains wins, because that is the deepest point the official curve
 * reached.
 *
 * The projection is host state that may be absent, mid-materialization, or
 * shaped differently after a harness upgrade, so every read is defensive: a
 * value that cannot be understood reads as "official never tried", which makes
 * us start from our own one-second delay rather than inherit a bogus index.
 *
 * @param {unknown} state - `ctx.sessionProjections.stateOf(session, 'llmRetry')`.
 * @param {string} provider - the failed request's provider route.
 * @returns {number}
 */
export function officialRetries(state, provider) {
  if (state === null || typeof state !== 'object') return 0;
  let deepest = 0;
  for (const [key, entry] of Object.entries(state)) {
    const pair = parsePair(key);
    if (pair === undefined) continue;
    const [keyProvider, keyPolicy] = pair;
    if (keyProvider !== provider) continue;
    // Our own chains share this projection, so they have to be excluded by the
    // namespace *inside* the policy key. The outer key begins with the provider
    // for official and ours alike, so testing it would never match.
    if (typeof keyPolicy === 'string' && keyPolicy.startsWith(POLICY_KEY_PREFIX)) continue;
    const retry = entry?.retry;
    if (Number.isSafeInteger(retry) && retry > deepest) deepest = retry;
  }
  return deepest;
}

/**
 * Decide whether to take over one failure the official executor declined.
 *
 * Checks run in order and the first miss wins, so each skip reason is the most
 * specific one that applied. The abort check leads because a cancelled turn is
 * not ours to resurrect, and the hard floor precedes the allowlist because it
 * is the one rule the allowlist cannot relax.
 *
 * `officialPolicy` is unused for eligibility on purpose: a failure that
 * arrived before any adapter was resolved carries no policy, and that is
 * precisely the case worth retrying, so its absence must not read as a denial.
 *
 * @param {object} options
 * @param {{code?: unknown, providerRetryAfterMs?: unknown} | null | undefined} options.failure
 * @param {{enabled: boolean, extraRetries: number, retryableCodes: readonly string[], initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} options.settings
 * @param {number} options.previousRetry - our own prior retries for this chain.
 * @param {number} options.officialRetry - official's prior retries this step.
 * @param {object | undefined} options.officialPolicy - official's resolved policy.
 * @param {boolean} options.signalAborted - whether the turn's signal is aborted.
 * @param {() => number} [options.random] - uniform [0, 1) source.
 * @returns {{action: 'retry'|'skip', why: string, retry?: number, delayMs?: number}}
 */
export function decide(options) {
  const { failure, settings, previousRetry, officialRetry, officialPolicy, signalAborted } = options;
  const random = typeof options.random === 'function' ? options.random : Math.random;

  if (signalAborted) return { action: 'skip', why: 'aborted' };

  const eligibility = isEligible(failure, settings);
  if (!eligibility.eligible) return { action: 'skip', why: eligibility.why };

  const retry = (Number.isSafeInteger(previousRetry) ? previousRetry : 0) + 1;
  if (!Number.isSafeInteger(settings.extraRetries) || settings.extraRetries <= 0) {
    return { action: 'skip', why: 'cap-reached' };
  }
  if (retry > settings.extraRetries) return { action: 'skip', why: 'cap-reached' };

  const computed = continuationDelay(officialRetry, retry, officialPolicy, settings, random);
  return {
    action: 'retry',
    why: 'retry',
    retry,
    delayMs: resolveDelay(failure, computed, settings),
  };
}

/**
 * Coerce an optional positive finite number, else fall back.
 *
 * Official's resolved policy reaches us from the host rather than from our own
 * schema, so a missing or nonsensical field must not become a `NaN` delay —
 * which would make the durable `llm/retry` append fail its own JSON gate and
 * silently disable the retry.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Coerce an optional jitter ratio onto [0, 1], else fall back. */
function ratio(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/** Parse one `[provider, policyKey]` projection key, or `undefined` for anything else. */
function parsePair(key) {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) && parsed.length === 2 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
