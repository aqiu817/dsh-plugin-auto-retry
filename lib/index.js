/**
 * Take over a model-request failure the harness's own retry executor declined.
 *
 * `@deepseek-ai/dsh-llm-retry` is mounted by `@deepseek-ai/dsh-base` and owns
 * recovery on the `agent/request-error` waterfall. It retries only a fixed set
 * of codes inside a bounded budget; whenever it decides *not* to retry, it calls
 * `next()`, which is where this plugin sits. Because a waterfall runs its
 * listeners outermost-first in registration order and the base bundle loads
 * before any profile bundle, official is always outermost and this plugin is
 * always downstream — so it observes exactly the failures official passed on,
 * and can never duplicate one official already handled.
 *
 * There is no client-side message injection here: a retry happens inside the
 * still-open step, on the same durable history, before any tool result is
 * synthesized. That keeps the request reconstructible from the session log and
 * avoids re-running side-effectful tools whose outcome the loop deliberately
 * left unknown.
 *
 * The browser half renders the full failure detail the native transcript
 * discards; see `client.js`.
 *
 * @module dsh-plugin-auto-retry
 */

import { randomUUID } from 'node:crypto';

import z from '@deepseek-ai/schemastery';

import {
  DEFAULT_RETRYABLE_CODES,
  DEFAULTS,
  decide,
  officialRetries,
  policyKey,
} from './policy.js';

export {
  DEFAULT_RETRYABLE_CODES,
  DEFAULTS,
  NEVER_RETRY_CODES,
  POLICY_KEY_NAMESPACE,
} from './policy.js';

/** Composition entry name; the id the profile patch row resolves to. */
export const name = 'auto-retry';

/**
 * The shared retry projection is where official's progress is read from, and
 * `agents` is what puts this listener inside every agent's dispatch scope.
 * Both are required before the listener can do anything useful.
 */
export const inject = ['agents', 'sessionProjections'];

/** The session projection `@deepseek-ai/dsh-llm-retry` registers its counts under. */
const RETRY_PROJECTION_KEY = 'llmRetry';

/** The session event types a scheduled retry is recorded as. */
const RETRY_EVENT = 'llm/retry';
const RETRY_STARTED_EVENT = 'llm/retry-started';

/**
 * Field bounds, shared with the `Config` schema.
 *
 * The schema only guards the initial composition: a `.volatile()` field is
 * written straight into its reference cell by the settings page, with no
 * re-validation. So every read defends for itself, and these constants are the
 * one source both halves agree on.
 */
export const LIMITS = Object.freeze({
  extraRetries: Object.freeze({ min: 0, max: 10 }),
  initialDelayMs: Object.freeze({ min: 0, max: 600_000 }),
  maxDelayMs: Object.freeze({ min: 0, max: 600_000 }),
  jitterRatio: Object.freeze({ min: 0, max: 1 }),
});

/**
 * Editable surface. Every field is `.volatile()` so a change on the Plugins
 * page mutates the reference cell in place instead of reloading this fiber —
 * which is what makes "stop retrying" take effect mid-chain.
 *
 * The top-level `.default({})` matters: the loader validates an entry's
 * composed config against this schema and throws on issues, so an entry row
 * that omits `config:` entirely must still resolve to a valid object.
 */
export const Config = z
  .object({
    /** Switch the plugin off without uninstalling it. */
    enabled: z
      .boolean()
      .default(DEFAULTS.enabled)
      .description('take over a model-request failure the harness retry executor declined')
      .volatile(),
    /**
     * Attempts allowed on top of whatever the official executor already spent.
     * `0` means "never intervene", which is the safe way to keep the plugin
     * installed but inert.
     */
    extraRetries: z
      .number()
      .step(1)
      .min(LIMITS.extraRetries.min)
      .max(LIMITS.extraRetries.max)
      .default(DEFAULTS.extraRetries)
      .description('additional retries beyond the harness executor budget; 0 disables this plugin')
      .volatile(),
    /**
     * Where our own curve starts when the official executor never tried. When
     * it did try, the official curve is continued instead and this value only
     * bounds the fallback.
     */
    initialDelayMs: z
      .number()
      .step(1)
      .min(LIMITS.initialDelayMs.min)
      .max(LIMITS.initialDelayMs.max)
      .default(DEFAULTS.initialDelayMs)
      .description('first delay when the harness executor never retried this failure')
      .volatile(),
    /** Outer ceiling for any delay, including a provider-requested one. */
    maxDelayMs: z
      .number()
      .step(1)
      .min(LIMITS.maxDelayMs.min)
      .max(LIMITS.maxDelayMs.max)
      .default(DEFAULTS.maxDelayMs)
      .description('maximum milliseconds this plugin will ever wait before a retry')
      .volatile(),
    /** Symmetric jitter around each local delay, as a fraction of it. */
    jitterRatio: z
      .number()
      .min(LIMITS.jitterRatio.min)
      .max(LIMITS.jitterRatio.max)
      .default(DEFAULTS.jitterRatio)
      .description('symmetric random spread around each locally computed delay')
      .volatile(),
    /**
     * The failure codes this plugin is willing to retry. Codes absent from this
     * list — including `QUOTA`, `INVALID_REQUEST`, and `UNKNOWN` — are left
     * terminal, because each is as likely to be permanent as transient.
     */
    retryableCodes: z
      .array(z.string())
      .default([...DEFAULT_RETRYABLE_CODES])
      .description('failure codes this plugin retries; QUOTA, INVALID_REQUEST and UNKNOWN stay opt-in')
      .volatile(),
  })
  .default({});

/**
 * Unwrap a volatile reference cell, if the value is one.
 *
 * A `.volatile()` field reaches `apply()` as a frozen `{ get }` cell rather
 * than as a plain value, so every read goes through `get()` to observe a
 * setting change without a reload. Ordinary fields pass through untouched,
 * which is why every read site can go through here unconditionally.
 *
 * @param {unknown} value - a resolved config field value.
 * @returns {unknown} the plain value behind a volatile cell, else the value.
 */
function plain(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function'
    ? value.get()
    : value;
}

/** Coerce an optional integer field onto a closed range, else fall back. */
function within(value, fallback, bounds) {
  return Number.isInteger(value) && value >= bounds.min && value <= bounds.max
    ? value
    : fallback;
}

/** Coerce an optional fractional field onto a closed range, else fall back. */
function ratioWithin(value, fallback, bounds) {
  return typeof value === 'number' && Number.isFinite(value) && value >= bounds.min && value <= bounds.max
    ? value
    : fallback;
}

/**
 * Coerce the allowlist into a non-empty, de-duplicated list of code strings.
 *
 * A list that survives neither the type check nor the emptiness check falls
 * back to the defaults rather than to "retry nothing": an empty allowlist is
 * how a typo looks, and reading it as a deliberate opt-out would silently turn
 * the plugin off while the settings page still shows it enabled.
 *
 * @param {unknown} value - the resolved `retryableCodes` field.
 * @returns {readonly string[]}
 */
function codesWithin(value) {
  if (!Array.isArray(value)) return DEFAULT_RETRYABLE_CODES;
  const codes = [...new Set(value.filter((code) => typeof code === 'string' && code.length > 0))];
  return codes.length === 0 ? DEFAULT_RETRYABLE_CODES : Object.freeze(codes);
}

/**
 * Read the current settings, tolerating a missing, partial, or badly typed
 * entry config.
 *
 * Every field is coerced or clamped rather than only defaulted, so a wrong
 * value can never disable a safety gate. Negative numbers fall back to the
 * default rather than to `0`, because `0` is the power to switch a gate off and
 * a mistyped negative must not have it.
 *
 * @param {Record<string, unknown> | undefined} config - the composed entry config.
 * @returns {{enabled: boolean, extraRetries: number, initialDelayMs: number, maxDelayMs: number, jitterRatio: number, retryableCodes: readonly string[]}}
 */
export function readSettings(config) {
  const source = config ?? {};
  return {
    enabled: typeof plain(source.enabled) === 'boolean' ? plain(source.enabled) : DEFAULTS.enabled,
    extraRetries: within(plain(source.extraRetries), DEFAULTS.extraRetries, LIMITS.extraRetries),
    initialDelayMs: within(plain(source.initialDelayMs), DEFAULTS.initialDelayMs, LIMITS.initialDelayMs),
    maxDelayMs: within(plain(source.maxDelayMs), DEFAULTS.maxDelayMs, LIMITS.maxDelayMs),
    jitterRatio: ratioWithin(plain(source.jitterRatio), DEFAULTS.jitterRatio, LIMITS.jitterRatio),
    retryableCodes: codesWithin(plain(source.retryableCodes)),
  };
}

/**
 * Wait for one delay, abandoning it the moment either signal aborts.
 *
 * Mirrors `@deepseek-ai/dsh-llm-retry`'s own `cancellableDelay`: the timer is
 * always cleared on abort, so a cancelled turn leaves nothing scheduled.
 *
 * @param {number} delayMs - how long to wait.
 * @param {AbortSignal} signal - the fused turn and plugin-lifetime signal.
 * @returns {Promise<boolean>} whether the wait ran to completion.
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Plugin entry point — synchronous Cordis `apply()`.
 *
 * @param {object} ctx - the plugin context.
 * @param {Record<string, unknown> | undefined} config - composed entry config.
 * @param {object} [hooks] - test seam.
 * @param {() => number} [hooks.random] - jitter source; defaults to `Math.random`.
 */
export function apply(ctx, config, hooks = {}) {
  const random = typeof hooks.random === 'function' ? hooks.random : Math.random;
  const lifetime = new AbortController();
  /** In-flight recoveries, awaited by the teardown so nothing outlives the fiber. */
  const active = new Set();

  /** Track one recovery so disposal can drain it. */
  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(void 0);
    return track(recover(payload, next));
  });

  ctx.effect(() => async () => {
    disposeListener();
    lifetime.abort(new Error('auto-retry plugin disposed'));
    await Promise.allSettled([...active]);
  }, 'auto-retry: abort and drain active recovery');

  /**
   * Decide and schedule one recovery, then answer the waterfall.
   *
   * Reached only after the official executor called `next()`, so every branch
   * here is a failure it declined. Returning anything other than
   * `{ kind: 'retry' }` leaves the failure terminal, which is the correct
   * fallback whenever a durable record cannot be written or the turn was
   * cancelled mid-wait.
   *
   * @param {object} payload - the waterfall payload.
   * @param {{session: {append: Function}}} payload.agent - injected by `agentEvents`.
   * @param {number} payload.turn - the turn that owns the failed step.
   * @param {number} payload.step - the failed step.
   * @param {string} payload.provider - the provider route that failed.
   * @param {{code?: unknown, message?: unknown, providerRetryAfterMs?: unknown}} payload.failure
   * @param {object | undefined} payload.retryPolicy - official's resolved policy.
   * @param {AbortSignal} payload.signal - the turn's cancellation signal.
   * @param {() => Promise<unknown>} next - the next listener, else the terminal default.
   * @returns {Promise<{kind: 'retry'} | unknown>}
   */
  async function recover({ agent, turn, step, provider, failure, retryPolicy, signal }, next) {
    // Downstream first: another listener may already own this failure.
    const terminal = await next();
    if (terminal !== void 0) return terminal;
    if (lifetime.signal.aborted || signal.aborted) return terminal;

    const settings = readSettings(config);
    const state = ctx.sessionProjections.stateOf(agent.session, RETRY_PROJECTION_KEY);
    const key = policyKey(settings);
    const entry = state?.[JSON.stringify([provider, key])];
    const previousRetry = Number.isSafeInteger(entry?.retry) ? entry.retry : 0;

    const verdict = decide({
      failure,
      settings,
      previousRetry,
      officialRetry: officialRetries(state, provider),
      officialPolicy: retryPolicy,
      signalAborted: signal.aborted,
      random,
    });

    if (verdict.action !== 'retry') {
      if (verdict.why === 'cap-reached') {
        ctx.logger.warn(
          'auto-retry: provider "%s" exhausted its %d extra attempt(s) at turn %d step %d; the failure stays terminal',
          provider,
          settings.extraRetries,
          turn,
          step
        );
      }
      return terminal;
    }

    // Official preserves one retry id across a whole provider-policy chain, and
    // the invariant companion checks that continuity, so an existing id is
    // reused rather than replaced.
    const retryId = typeof entry?.retryId === 'string' && entry.retryId !== ''
      ? entry.retryId
      : randomUUID();

    // Durable before the wait: a crash must never leave a pending retry that
    // nothing can see. A rejected append therefore abandons the retry instead
    // of proceeding without a record.
    try {
      agent.session.append(RETRY_EVENT, {
        retryId,
        turn,
        step,
        provider,
        mode: 'normal',
        policyKey: key,
        retry: verdict.retry,
        maxRetries: settings.extraRetries,
        delayMs: verdict.delayMs,
        failure,
      });
    } catch (error) {
      ctx.logger.error(error);
      return terminal;
    }

    const fused = AbortSignal.any([signal, lifetime.signal]);
    if (!(await cancellableDelay(verdict.delayMs, fused))) return terminal;

    try {
      agent.session.append(RETRY_STARTED_EVENT, {
        retryId,
        turn,
        step,
        retry: verdict.retry,
      });
    } catch (error) {
      ctx.logger.error(error);
      return terminal;
    }

    ctx.logger.info(
      'auto-retry: retry #%d/%d for provider "%s" at turn %d step %d after %d ms',
      verdict.retry,
      settings.extraRetries,
      provider,
      turn,
      step,
      Math.round(verdict.delayMs)
    );
    return { kind: 'retry' };
  }
}
