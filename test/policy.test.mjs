/**
 * Unit tests for the pure policy module.
 *
 * These run with a bare `node --test` against plain objects: no Cordis, no
 * harness, no plugin loader. That is the point of keeping every decision in
 * `policy.js` — the allow/deny surface is checkable without booting anything,
 * which is the only way a quiet plugin gets caught before it is installed.
 *
 * The delay assertions pin `random` to `0.5`, where symmetric jitter is exactly
 * `1`, so an expected number is the curve itself rather than a range.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RETRYABLE_CODES,
  DEFAULTS,
  NEVER_RETRY_CODES,
  POLICY_KEY_NAMESPACE,
  continuationDelay,
  decide,
  isEligible,
  localDelay,
  officialRetries,
  policyKey,
  resolveDelay,
} from '../lib/policy.js';

/** Jitter-neutral random source: `1 - r + 2r * 0.5 === 1` for every `r`. */
const NEUTRAL = () => 0.5;

/** Settings with a deliberately narrow allowlist, so tests name one code. */
function settings(overrides = {}) {
  return {
    enabled: true,
    extraRetries: DEFAULTS.extraRetries,
    retryableCodes: ['RATE_LIMIT'],
    initialDelayMs: DEFAULTS.initialDelayMs,
    maxDelayMs: DEFAULTS.maxDelayMs,
    jitterRatio: DEFAULTS.jitterRatio,
    ...overrides,
  };
}

/** Decide with defaults, letting the caller override the bits under test. */
function verdict(overrides = {}) {
  return decide({
    failure: { code: 'RATE_LIMIT' },
    settings: settings(),
    previousRetry: 0,
    officialRetry: 0,
    officialPolicy: undefined,
    signalAborted: false,
    random: NEUTRAL,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('the default policy is the one the patch entry ships with', () => {
  assert.deepEqual(DEFAULTS, {
    enabled: true,
    extraRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
    retryableCodes: DEFAULT_RETRYABLE_CODES,
  });
});

test('the default allowlist extends official coverage and adds the two catch-alls', () => {
  // The first five are the harness's own default retryable set; listing them
  // here is what makes our attempts a continuation rather than a duplicate.
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.equal(DEFAULT_RETRYABLE_CODES.includes(code), true, code);
  }
  // The two adapter catch-alls official never retries at all.
  assert.equal(DEFAULT_RETRYABLE_CODES.includes('PROVIDER_ERROR'), true);
  assert.equal(DEFAULT_RETRYABLE_CODES.includes('PI_AI_ERROR'), true);

  // The ambiguous ones stay out: each is as likely terminal as transient.
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'UNKNOWN']) {
    assert.equal(DEFAULT_RETRYABLE_CODES.includes(code), false, code);
  }
  assert.equal(Object.isFrozen(DEFAULT_RETRYABLE_CODES), true);
});

test('the hard floor holds every failure a retry cannot fix or another owner holds', () => {
  for (const code of [
    'AUTH',
    'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL',
    'NO_ADAPTER',
    'INVALID_MODEL',
    'INVALID_CONFIG',
    'CONTEXT_WINDOW_EXCEEDED',
    'IMAGE_OFFLOAD_REQUIRED',
    'ABORTED',
  ]) {
    assert.equal(NEVER_RETRY_CODES.has(code), true, code);
  }
  // Not denied — merely not defaulted — so a deployment can opt in.
  assert.equal(NEVER_RETRY_CODES.has('QUOTA'), false);
  assert.equal(NEVER_RETRY_CODES.has('UNKNOWN'), false);
  assert.equal(Object.isFrozen(NEVER_RETRY_CODES), true);
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('a listed code with a healthy failure is eligible', () => {
  assert.deepEqual(isEligible({ code: 'RATE_LIMIT' }, settings()), {
    eligible: true,
    why: 'eligible',
  });
});

test('the hard floor beats the allowlist, so a typo cannot unlock it', () => {
  for (const code of NEVER_RETRY_CODES) {
    const permissive = settings({ retryableCodes: [code] });
    assert.deepEqual(isEligible({ code }, permissive), {
      eligible: false,
      why: 'hard-denied',
    });
  }
});

test('a code outside the allowlist is skipped', () => {
  assert.deepEqual(isEligible({ code: 'INVALID_REQUEST' }, settings()), {
    eligible: false,
    why: 'code-not-listed',
  });
});

test('a disabled plugin sends nothing', () => {
  assert.deepEqual(isEligible({ code: 'RATE_LIMIT' }, settings({ enabled: false })), {
    eligible: false,
    why: 'disabled',
  });
});

test('a malformed failure is skipped rather than thrown on', () => {
  for (const failure of [null, undefined, 0, '', 'boom', [], {}, { code: 42 }, { code: '' }]) {
    assert.deepEqual(isEligible(failure, settings()), {
      eligible: false,
      why: 'malformed-failure',
    });
  }
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test('the local curve doubles from the first delay and saturates at the cap', () => {
  const curve = { initialDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0 };
  assert.equal(localDelay(1, curve, NEUTRAL), 1000);
  assert.equal(localDelay(2, curve, NEUTRAL), 2000);
  assert.equal(localDelay(3, curve, NEUTRAL), 4000);
  assert.equal(localDelay(4, curve, NEUTRAL), 8000);
  // Saturated, and it stays there rather than overflowing.
  assert.equal(localDelay(5, curve, NEUTRAL), 8000);
  assert.equal(localDelay(2000, curve, NEUTRAL), 8000);
});

test('symmetric jitter spans the documented range around the curve', () => {
  const curve = { initialDelayMs: 1000, maxDelayMs: 1_000_000, jitterRatio: 0.25 };
  assert.equal(localDelay(3, curve, () => 0), 4000 * 0.75);
  assert.equal(localDelay(3, curve, () => 1), 4000 * 1.25);
  assert.equal(localDelay(3, curve, NEUTRAL), 4000);
});

test('jitter never lifts a delay above the cap', () => {
  const curve = { initialDelayMs: 1000, maxDelayMs: 4000, jitterRatio: 1 };
  for (const random of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(localDelay(4, curve, () => random) <= 4000, true, `random ${random}`);
  }
});

// ---------------------------------------------------------------------------
// Continuation of the official curve
// ---------------------------------------------------------------------------

test('a failure official never tried starts from our own one-second delay', () => {
  const own = settings({ initialDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.2 });
  // `officialRetry: 0` is the "official never tried" case, whatever the policy.
  assert.equal(continuationDelay(0, 1, { initialDelayMs: 500 }, own, NEUTRAL), 1000);
  assert.equal(continuationDelay(0, 2, { initialDelayMs: 500 }, own, NEUTRAL), 2000);
  assert.equal(continuationDelay(0, 3, { initialDelayMs: 500 }, own, NEUTRAL), 4000);
});

test('a failure official did try continues its curve one step past its longest', () => {
  // Official defaults: base 500, cap 10000. At retry 5 the curve reads 8000;
  // retry 6 reads 16000 and saturates at 10000. That saturation is exactly the
  // "one step past the longest" the deployment asked for.
  const official = { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 };
  const own = settings({ initialDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.2 });
  assert.equal(continuationDelay(5, 1, official, own, NEUTRAL), 10_000);
  assert.equal(continuationDelay(5, 2, official, own, NEUTRAL), 10_000);
  assert.equal(continuationDelay(5, 3, official, own, NEUTRAL), 10_000);

  // Two official retries: the curve has not saturated yet, so ours keeps
  // doubling from where official stopped.
  assert.equal(continuationDelay(2, 1, official, own, NEUTRAL), 2000);
  assert.equal(continuationDelay(2, 2, official, own, NEUTRAL), 4000);
  assert.equal(continuationDelay(2, 3, official, own, NEUTRAL), 8000);
});

test('our own cap is the outer ceiling even when official allows more', () => {
  const official = { initialDelayMs: 1000, maxDelayMs: 600_000, jitterRatio: 0 };
  const own = settings({ initialDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 });
  assert.equal(continuationDelay(10, 1, official, own, NEUTRAL), 5000);
});

test('a malformed official policy falls back instead of producing NaN', () => {
  const own = settings({ initialDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.2 });
  const hostile = {
    initialDelayMs: 'fast',
    maxDelayMs: Number.NaN,
    jitterRatio: 7,
  };
  const delay = continuationDelay(3, 1, hostile, own, NEUTRAL);
  assert.equal(Number.isFinite(delay), true);
  // Official's index (3 + 1 = 4) on our own base of 1000 → 8000.
  assert.equal(delay, 8000);

  // A policy that is not an object at all takes the same path.
  assert.equal(Number.isFinite(continuationDelay(3, 1, null, own, NEUTRAL)), true);
  assert.equal(Number.isFinite(continuationDelay(3, 1, 'nope', own, NEUTRAL)), true);
});

test('a negative or fractional official retry count reads as "never tried"', () => {
  const own = settings({ initialDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.2 });
  const official = { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 };
  for (const officialRetry of [-1, 1.5, Number.NaN, undefined, null]) {
    assert.equal(
      continuationDelay(officialRetry, 1, official, own, NEUTRAL),
      1000,
      `officialRetry ${String(officialRetry)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Provider-requested delay
// ---------------------------------------------------------------------------

test('a valid provider delay replaces the computed one', () => {
  assert.equal(resolveDelay({ providerRetryAfterMs: 3000 }, 1000, settings()), 3000);
});

test('a provider delay is clamped to our ceiling rather than declined', () => {
  // Official's normal mode gives up here; we keep the attempt and clamp.
  assert.equal(resolveDelay({ providerRetryAfterMs: 120_000 }, 1000, settings()), 60_000);
});

test('an absent or nonsensical provider delay leaves the computed one alone', () => {
  for (const failure of [null, undefined, {}, { providerRetryAfterMs: 0 }, { providerRetryAfterMs: -5 }, { providerRetryAfterMs: Number.NaN }, { providerRetryAfterMs: 'soon' }]) {
    assert.equal(resolveDelay(failure, 1234, settings()), 1234, JSON.stringify(failure));
  }
});

// ---------------------------------------------------------------------------
// Policy key
// ---------------------------------------------------------------------------

test('our policy key is namespaced so it can never equal an official one', () => {
  const key = policyKey(settings());
  assert.equal(key.startsWith(`["${POLICY_KEY_NAMESPACE}"`), true);

  // Official's own derivation, reproduced: `JSON.stringify([mode, ...])`.
  const officialNormal = JSON.stringify(['normal', 5, ['RATE_LIMIT'], 500, 10_000, 0.1]);
  const officialAlways = JSON.stringify(['always', 500, 10_000, 0.1]);
  assert.notEqual(key, officialNormal);
  assert.notEqual(key, officialAlways);
  assert.equal(officialNormal.startsWith(`["${POLICY_KEY_NAMESPACE}"`), false);
});

test('every behaviour-bearing field forks the chain, but reordering does not', () => {
  const base = policyKey(settings());
  assert.equal(policyKey(settings({ retryableCodes: ['RATE_LIMIT'] })), base);
  assert.notEqual(policyKey(settings({ extraRetries: 4 })), base);
  assert.notEqual(policyKey(settings({ initialDelayMs: 2000 })), base);
  assert.notEqual(policyKey(settings({ maxDelayMs: 30_000 })), base);
  assert.notEqual(policyKey(settings({ jitterRatio: 0.5 })), base);
  assert.notEqual(policyKey(settings({ retryableCodes: ['SERVER', 'RATE_LIMIT'] })), base);
  // Sorting means the same set in another order is the same chain.
  assert.equal(
    policyKey(settings({ retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT'] })),
    policyKey(settings({ retryableCodes: ['TIMEOUT', 'RATE_LIMIT', 'SERVER'] })),
  );
});

// ---------------------------------------------------------------------------
// Reading official's progress
// ---------------------------------------------------------------------------

/** One projection key, shaped as the harness writes it. */
function projectionKey(provider, policy) {
  return JSON.stringify([provider, JSON.stringify(policy)]);
}

test('official progress is read per provider and our own chains are skipped', () => {
  const state = {
    [projectionKey('magpie', ['normal', 5, ['RATE_LIMIT'], 500, 10_000, 0.1])]: { retry: 5, retryId: 'a' },
    // Deliberately deeper than official's. The outer key starts with the
    // provider for official and ours alike, so a namespace check that looked
    // there instead of inside the policy key would answer 9 here.
    [projectionKey('magpie', ['auto-retry', 3, ['RATE_LIMIT'], 1000, 60_000, 0.2])]: { retry: 9, retryId: 'b' },
    [projectionKey('rina', ['normal', 5, ['RATE_LIMIT'], 500, 10_000, 0.1])]: { retry: 3, retryId: 'c' },
  };
  assert.equal(officialRetries(state, 'magpie'), 5);
  assert.equal(officialRetries(state, 'rina'), 3);
  assert.equal(officialRetries(state, 'sensenova'), 0);
});

test('a provider whose only chain is ours reads as never tried', () => {
  const state = {
    [projectionKey('magpie', ['auto-retry', 3, ['RATE_LIMIT'], 1000, 60_000, 0.2])]: { retry: 4, retryId: 'b' },
  };
  assert.equal(officialRetries(state, 'magpie'), 0);
});

test('the deepest official chain wins when one provider has several', () => {
  const state = {
    [projectionKey('magpie', ['normal', 2, ['SERVER'], 500, 10_000, 0.1])]: { retry: 2, retryId: 'a' },
    [projectionKey('magpie', ['normal', 5, ['RATE_LIMIT'], 500, 10_000, 0.1])]: { retry: 5, retryId: 'b' },
  };
  assert.equal(officialRetries(state, 'magpie'), 5);
});

test('an unreadable projection reads as "official never tried"', () => {
  for (const state of [null, undefined, 0, '', 'x', [], {}]) {
    assert.equal(officialRetries(state, 'magpie'), 0, JSON.stringify(state));
  }
  // A key that is not JSON, or not a pair, is skipped rather than thrown on.
  assert.equal(officialRetries({ 'not json': { retry: 9 }, '"scalar"': { retry: 9 } }, 'magpie'), 0);
  // A nonsensical retry value is ignored.
  assert.equal(officialRetries({ [projectionKey('magpie', ['normal'])]: { retry: -1 } }, 'magpie'), 0);
  assert.equal(officialRetries({ [projectionKey('magpie', ['normal'])]: { retry: 1.5 } }, 'magpie'), 0);
  assert.equal(officialRetries({ [projectionKey('magpie', ['normal'])]: null }, 'magpie'), 0);
});

// ---------------------------------------------------------------------------
// The whole decision
// ---------------------------------------------------------------------------

test('a listed failure official declined is retried from our own first delay', () => {
  assert.deepEqual(verdict(), {
    action: 'retry',
    why: 'retry',
    retry: 1,
    delayMs: 1000,
  });
});

test('an aborted turn is never resurrected', () => {
  assert.deepEqual(verdict({ signalAborted: true }), { action: 'skip', why: 'aborted' });
});

test('every skip reason is the most specific one that applied', () => {
  assert.deepEqual(verdict({ settings: settings({ enabled: false }) }), {
    action: 'skip',
    why: 'disabled',
  });
  assert.deepEqual(verdict({ failure: { code: 'AUTH' } }), { action: 'skip', why: 'hard-denied' });
  assert.deepEqual(verdict({ failure: { code: 'UNKNOWN' } }), {
    action: 'skip',
    why: 'code-not-listed',
  });
  assert.deepEqual(verdict({ failure: null }), { action: 'skip', why: 'malformed-failure' });
  // The abort check leads, so a cancelled turn reports the cancellation even
  // when the code itself would also have been skipped.
  assert.deepEqual(verdict({ failure: { code: 'AUTH' }, signalAborted: true }), {
    action: 'skip',
    why: 'aborted',
  });
});

test('the budget is spent before the next attempt, not after it', () => {
  assert.equal(verdict({ previousRetry: 0 }).action, 'retry');
  assert.equal(verdict({ previousRetry: 1 }).action, 'retry');
  assert.equal(verdict({ previousRetry: 2 }).action, 'retry');
  assert.deepEqual(verdict({ previousRetry: 3 }), { action: 'skip', why: 'cap-reached' });
  assert.deepEqual(verdict({ previousRetry: 99 }), { action: 'skip', why: 'cap-reached' });
});

test('a zero budget means "do not intervene"', () => {
  assert.deepEqual(verdict({ settings: settings({ extraRetries: 0 }) }), {
    action: 'skip',
    why: 'cap-reached',
  });
  // A malformed budget is treated as no budget rather than as unlimited.
  assert.deepEqual(verdict({ settings: settings({ extraRetries: -1 }) }), {
    action: 'skip',
    why: 'cap-reached',
  });
  assert.deepEqual(verdict({ settings: settings({ extraRetries: 2.5 }) }), {
    action: 'skip',
    why: 'cap-reached',
  });
});

test('a failure with no adapter policy is still eligible', () => {
  // The failure arrived before any adapter was resolved, so `retryPolicy` is
  // undefined. That absence is not a denial — it is the case worth retrying.
  const result = verdict({ officialPolicy: undefined, officialRetry: 0 });
  assert.equal(result.action, 'retry');
});

test('the decision carries the provider delay through', () => {
  const result = verdict({ failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 7500 } });
  assert.equal(result.delayMs, 7500);
});

test('the decision continues official progress', () => {
  const result = verdict({
    officialRetry: 5,
    officialPolicy: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
  });
  assert.equal(result.action, 'retry');
  assert.equal(result.delayMs, 10_000);
});

test('decide never throws on hostile input', () => {
  assert.equal(verdict({ failure: { code: 42 } }).action, 'skip');
  assert.equal(verdict({ settings: settings({ retryableCodes: 'RATE_LIMIT' }) }).action, 'skip');
  assert.equal(verdict({ previousRetry: Number.NaN }).action, 'retry');
  assert.equal(verdict({ previousRetry: -5 }).action, 'retry');
  // No `random` supplied falls back to Math.random rather than throwing.
  assert.equal(typeof decide({
    failure: { code: 'RATE_LIMIT' },
    settings: settings(),
    previousRetry: 0,
    officialRetry: 0,
    officialPolicy: undefined,
    signalAborted: false,
  }).delayMs, 'number');
});
