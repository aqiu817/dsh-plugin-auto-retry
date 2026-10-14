/**
 * Wiring tests for the host half.
 *
 * These drive the registered `agent/request-error` listener with a mock context
 * and a controllable jitter source, then assert on what reaches
 * `agent.session.append()` and on what the waterfall gets back. The decision
 * logic itself is covered in `policy.test.mjs`; here the question is only "does
 * the listener read the real payload, read official's progress correctly,
 * record the retry durably before waiting, and answer the waterfall exactly
 * once?".
 *
 * Three harness details matter more than the rest:
 *
 * 1. The listener is invoked the way a Cordis waterfall invokes it — as
 *    `(payload, next)`, where `next` is the terminal default when the official
 *    executor already declined. Nothing here reaches the listener while official
 *    is retrying, because official does not call `next()` when it retries; the
 *    delegation test pins the other half of that contract.
 * 2. `ctx.effect()` is captured so teardown can be awaited, which is what the
 *    disposal tests need.
 * 3. The harness defaults the first delay to `0`, so the suite does not spend
 *    real seconds sleeping. Tests that assert on a delay pass their own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Config,
  DEFAULTS,
  LIMITS,
  apply,
  inject,
  name,
  readSettings,
} from '../lib/index.js';
import { policyKey } from '../lib/policy.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Jitter-neutral random source: `1 - r + 2r * 0.5 === 1` for every `r`. */
const NEUTRAL = () => 0.5;

/** Drain the microtask queue, so a deferred step has landed. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A mock plugin context: captures event subscriptions and effects, serves
 * projection state by session id, and records log lines.
 */
function makeCtx(projections = new Map()) {
  const handlers = new Map();
  const logs = [];
  const effects = [];
  const ctx = {
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    sessionProjections: {
      stateOf: (session, key) => projections.get(session.id)?.[key],
    },
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      error: (...args) => logs.push(['error', args]),
    },
    effect(fn) {
      effects.push(fn());
    },
  };
  return {
    ctx,
    handlers,
    logs,
    /** Run every captured teardown, as fiber disposal would. */
    async dispose() {
      for (const cleanup of effects) await cleanup();
    },
  };
}

/** One agent whose only observable behaviour is what it appends. */
function makeAgent(id) {
  const appended = [];
  const session = {
    id,
    append(type, data) {
      appended.push({ type, data });
    },
  };
  return { id, session, appended };
}

/** The waterfall payload `agent/request-error` carries, plus the injected agent. */
function payload(agent, overrides = {}) {
  return {
    agent,
    turn: 4,
    step: 2,
    provider: 'magpie',
    failure: { message: 'upstream said no', code: 'RATE_LIMIT' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Apply once, then fire the listener the way the waterfall does.
 *
 * `next` defaults to the terminal default (`() => Promise.resolve(undefined)`),
 * which is what a downstream listener sees when official declined.
 */
function harness({ config = {}, projections, random = NEUTRAL } = {}) {
  // A zero first delay keeps the suite fast; tests that assert on a delay
  // override it. Merging rather than replacing keeps `extraRetries`-only
  // configs from accidentally reinstating the one-second default.
  const merged = { initialDelayMs: 0, ...config };
  const { ctx, handlers, logs, dispose } = makeCtx(projections);
  apply(ctx, merged, { random });

  // Captured once, so a test can still reach the listener after disposal and
  // observe the lifetime guard instead of a missing registration.
  const handler = handlers.get('agent/request-error');
  assert.equal(typeof handler, 'function', 'apply must register the listener');

  return {
    logs,
    handlers,
    dispose,
    settings: readSettings(merged),
    /** Fire one failure and return the waterfall's answer. */
    fire(input, next = () => Promise.resolve(void 0)) {
      return handler(input, next);
    },
  };
}

/** Projection state naming our own chain for one provider. */
function ourState(provider, retry, settings, retryId = 'chain-1') {
  return { [JSON.stringify([provider, policyKey(settings)])]: { retry, retryId } };
}

/** Projection state naming an official chain for one provider. */
function officialState(provider, retry, policy = ['normal', 5, ['RATE_LIMIT'], 500, 10_000, 0.1]) {
  return { [JSON.stringify([provider, JSON.stringify(policy)])]: { retry, retryId: 'official-1' } };
}

/** Projection state as the registry stores it, keyed by session id. */
function projectionMap(sessionId, state) {
  return new Map([[sessionId, { llmRetry: state }]]);
}

// ---------------------------------------------------------------------------
// Manifest and settings
// ---------------------------------------------------------------------------

test('the manifest declares the two services the listener needs', () => {
  assert.equal(name, 'auto-retry');
  assert.deepEqual(inject, ['agents', 'sessionProjections']);
});

test('the settings surface is fully volatile, so the Plugins page edits it live', () => {
  const fields = ['enabled', 'extraRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio', 'retryableCodes'];
  assert.deepEqual(Object.keys(Config.dict).sort(), [...fields].sort());
  for (const field of fields) {
    assert.equal(
      Config.dict[field].meta.volatile,
      true,
      `${field} must be .volatile() or the settings page silently omits it`,
    );
  }
});

test('an entry row with no config at all still resolves', () => {
  for (const input of [undefined, {}]) {
    const result = Config['~standard'].validate(input);
    assert.equal(
      result.issues,
      void 0,
      `validate(${input === void 0 ? 'undefined' : '{}'}) must not report issues`,
    );
  }
  assert.deepEqual(readSettings(Config['~standard'].validate(undefined).value), DEFAULTS);
  assert.deepEqual(readSettings(Config['~standard'].validate({}).value), DEFAULTS);
});

test('LIMITS and the schema bounds are one and the same', () => {
  assert.equal(LIMITS.extraRetries.min, 0);
  assert.equal(LIMITS.extraRetries.max, 10);
  assert.equal(LIMITS.initialDelayMs.max, 600_000);
  assert.equal(LIMITS.maxDelayMs.max, 600_000);
  assert.equal(LIMITS.jitterRatio.max, 1);
  assert.equal(Object.isFrozen(LIMITS), true);
  assert.equal(Object.isFrozen(LIMITS.extraRetries), true);
});

test('the config schema rejects a bad budget instead of silently obeying it', () => {
  for (const bad of [-1, 11, 2.5]) {
    assert.notEqual(
      Config['~standard'].validate({ extraRetries: bad }).issues,
      void 0,
      `extraRetries: ${bad} must be rejected`,
    );
  }
  assert.equal(Config['~standard'].validate({ extraRetries: 0 }).issues, void 0, '0 is a legal opt-out');
  assert.notEqual(Config['~standard'].validate({ jitterRatio: 1.5 }).issues, void 0);
});

test('readSettings falls back to defaults field by field', () => {
  assert.deepEqual(readSettings(undefined), DEFAULTS);
  assert.deepEqual(readSettings({}), DEFAULTS);
  assert.deepEqual(readSettings({ extraRetries: 2 }), { ...DEFAULTS, extraRetries: 2 });
});

test('readSettings unwraps a volatile reference cell', () => {
  let stored = 5;
  const cell = Object.freeze({ get: () => stored });
  assert.equal(readSettings({ extraRetries: cell }).extraRetries, 5);
  stored = 1;
  assert.equal(readSettings({ extraRetries: cell }).extraRetries, 1);
});

test('readSettings refuses to hand a safety gate a nonsense value', () => {
  // A negative budget must come back as the default, never as a negative and
  // never as 0 — 0 is the power to switch the plugin off.
  assert.equal(readSettings({ extraRetries: -1 }).extraRetries, DEFAULTS.extraRetries);
  assert.equal(readSettings({ initialDelayMs: -100 }).initialDelayMs, DEFAULTS.initialDelayMs);
  assert.equal(readSettings({ maxDelayMs: -1 }).maxDelayMs, DEFAULTS.maxDelayMs);
  assert.equal(readSettings({ jitterRatio: -0.5 }).jitterRatio, DEFAULTS.jitterRatio);

  // Out of range high, fractional where an integer is required, wrong type.
  assert.equal(readSettings({ extraRetries: 99 }).extraRetries, DEFAULTS.extraRetries);
  assert.equal(readSettings({ extraRetries: 2.5 }).extraRetries, DEFAULTS.extraRetries);
  assert.equal(readSettings({ extraRetries: 'lots' }).extraRetries, DEFAULTS.extraRetries);
  assert.equal(readSettings({ jitterRatio: 7 }).jitterRatio, DEFAULTS.jitterRatio);
  assert.equal(readSettings({ enabled: 'nope' }).enabled, DEFAULTS.enabled);

  // Zero stays zero: it is a deliberate opt-out a person can choose.
  assert.equal(readSettings({ extraRetries: 0 }).extraRetries, 0);
  assert.equal(readSettings({ initialDelayMs: 0 }).initialDelayMs, 0);
});

test('readSettings sanitizes the allowlist rather than trusting it', () => {
  assert.deepEqual(readSettings({ retryableCodes: ['SERVER'] }).retryableCodes, ['SERVER']);
  // Duplicates collapse; non-strings and blanks drop out.
  assert.deepEqual(
    readSettings({ retryableCodes: ['SERVER', 'SERVER', 42, '', null, 'TIMEOUT'] }).retryableCodes,
    ['SERVER', 'TIMEOUT'],
  );
  // A wrong type, or a list that empties out, falls back to the defaults — an
  // empty allowlist is how a typo looks, not a deliberate opt-out.
  for (const value of ['RATE_LIMIT', 42, null, [], [''], [1, 2], {}]) {
    assert.deepEqual(
      readSettings({ retryableCodes: value }).retryableCodes,
      DEFAULTS.retryableCodes,
      JSON.stringify(value),
    );
  }
});

test('readSettings survives a config that is not an object at all', () => {
  for (const config of [null, 0, '', 'string', true, []]) {
    assert.deepEqual(readSettings(config), DEFAULTS);
  }
});

// ---------------------------------------------------------------------------
// Waterfall contract
// ---------------------------------------------------------------------------

test('a decision from downstream is honoured, and nothing is appended', async () => {
  const agent = makeAgent('s1');
  const h = harness();
  const downstream = { kind: 'retry' };

  const answer = await h.fire(payload(agent), () => Promise.resolve(downstream));

  assert.equal(answer, downstream);
  assert.deepEqual(agent.appended, []);
});

test('a failure we will not take is left terminal, with nothing appended', async () => {
  const agent = makeAgent('s1');
  const h = harness();

  const answer = await h.fire(payload(agent, { failure: { message: 'nope', code: 'AUTH' } }));

  assert.equal(answer, void 0);
  assert.deepEqual(agent.appended, []);
});

test('an eligible failure is answered with exactly one retry', async () => {
  const agent = makeAgent('s1');
  const h = harness();

  const answer = await h.fire(payload(agent));

  assert.deepEqual(answer, { kind: 'retry' });
  assert.deepEqual(
    agent.appended.map((entry) => entry.type),
    ['llm/retry', 'llm/retry-started'],
  );
});

test('the durable record is written before the wait, and started after it', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { initialDelayMs: 40 } });

  const pending = h.fire(payload(agent));
  await flush();

  // The wait is still running — its timer has not fired — yet the scheduled
  // record is already durable. That is the "durable before wait" rule.
  assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry']);

  await pending;
  assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry', 'llm/retry-started']);
});

test('the scheduled record carries every field the invariant companion checks', async () => {
  const agent = makeAgent('s1');
  const h = harness();

  await h.fire(payload(agent));

  const [scheduled, started] = agent.appended;
  const data = scheduled.data;

  assert.equal(scheduled.type, 'llm/retry');
  assert.equal(typeof data.retryId, 'string');
  assert.equal(data.retryId.length, 36);
  assert.equal(data.turn, 4);
  assert.equal(data.step, 2);
  assert.equal(data.provider, 'magpie');
  assert.equal(data.mode, 'normal');
  assert.equal(data.retry, 1);
  assert.equal(data.maxRetries, DEFAULTS.extraRetries);
  assert.equal(Number.isSafeInteger(data.maxRetries), true);
  assert.equal(data.retry <= data.maxRetries, true, 'retry must not exceed maxRetries');
  assert.equal(Number.isFinite(data.delayMs), true);
  assert.deepEqual(data.failure, { message: 'upstream said no', code: 'RATE_LIMIT' });

  // Our key is namespaced, so it can never collide with official's.
  assert.equal(typeof data.policyKey, 'string');
  assert.equal(data.policyKey.startsWith('["auto-retry"'), true);

  assert.equal(started.type, 'llm/retry-started');
  assert.deepEqual(started.data, { retryId: data.retryId, turn: 4, step: 2, retry: 1 });
});

test('a scheduled record is JSON-serializable, so the snapshot gate accepts it', async () => {
  const agent = makeAgent('s1');
  const h = harness();
  await h.fire(payload(agent));
  const [scheduled] = agent.appended;
  assert.doesNotThrow(() => JSON.stringify(scheduled.data));
  assert.equal(JSON.parse(JSON.stringify(scheduled.data)).delayMs, scheduled.data.delayMs);
});

// ---------------------------------------------------------------------------
// Budget and continuation
// ---------------------------------------------------------------------------

test('our budget is spent before the next attempt, not after it', async () => {
  const h0 = harness({ config: { extraRetries: 2 } });
  const agent = makeAgent('s1');
  const h = harness({
    config: { extraRetries: 2 },
    projections: projectionMap('s1', ourState('magpie', 1, h0.settings)),
  });

  await h.fire(payload(agent));

  assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry', 'llm/retry-started']);
  assert.equal(agent.appended[0].data.retry, 2);
});

test('an exhausted budget stops the chain and says so once', async () => {
  const h0 = harness({ config: { extraRetries: 2 } });
  const agent = makeAgent('s1');
  const h = harness({
    config: { extraRetries: 2 },
    projections: projectionMap('s1', ourState('magpie', 2, h0.settings)),
  });

  const answer = await h.fire(payload(agent));

  assert.equal(answer, void 0);
  assert.deepEqual(agent.appended, []);
  const warnings = h.logs.filter((entry) => entry[0] === 'warn');
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][1][0]), /exhausted/);
});

test('a failure official never tried starts from our own first delay', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { initialDelayMs: 25 } });

  await h.fire(payload(agent));

  assert.equal(agent.appended[0].data.delayMs, 25);
});

test('a failure official did try continues its curve one step past its longest', async () => {
  const agent = makeAgent('s1');
  const h = harness({
    config: { initialDelayMs: 25, maxDelayMs: 600_000 },
    projections: projectionMap('s1', officialState('magpie', 2)),
  });

  await h.fire(payload(agent, {
    // Official's curve: base 20, cap 640. At index 3 it reads 80 — one step
    // past the two retries official already spent.
    retryPolicy: { initialDelayMs: 20, maxDelayMs: 640, jitterRatio: 0.1 },
  }));

  assert.equal(agent.appended[0].data.delayMs, 80);
});

test('official progress for another provider does not move our curve', async () => {
  const agent = makeAgent('s1');
  const h = harness({
    config: { initialDelayMs: 25 },
    projections: projectionMap('s1', officialState('rina', 5)),
  });

  await h.fire(payload(agent));

  assert.equal(agent.appended[0].data.delayMs, 25);
});

test('our own entries never count as official progress', async () => {
  const h0 = harness({ config: { initialDelayMs: 25 } });
  const agent = makeAgent('s1');
  // Our own chain sits at 2, and there is no official chain at all.
  const h = harness({
    config: { initialDelayMs: 25 },
    projections: projectionMap('s1', ourState('magpie', 2, h0.settings)),
  });

  await h.fire(payload(agent));

  // Index 3 of our own curve is 25 * 2^2 = 100. Reading our own entry as
  // official progress would instead continue a curve from index 3 + 3, which
  // is a visibly larger number — so this pins the exclusion.
  assert.equal(agent.appended[0].data.delayMs, 100);
  assert.equal(agent.appended[0].data.retry, 3);
});

test('a provider-requested delay wins and is clamped by our ceiling', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { initialDelayMs: 5, maxDelayMs: 30 } });

  await h.fire(payload(agent, {
    failure: { message: 'slow down', code: 'RATE_LIMIT', providerRetryAfterMs: 120_000 },
  }));

  assert.equal(agent.appended[0].data.delayMs, 30);
});

// ---------------------------------------------------------------------------
// Retry identity
// ---------------------------------------------------------------------------

test('one retry chain keeps its id, a fresh chain mints one', async () => {
  const h0 = harness();
  const existing = makeAgent('s1');
  await harness({ projections: projectionMap('s1', ourState('magpie', 1, h0.settings, 'chain-abc')) })
    .fire(payload(existing));
  assert.equal(existing.appended[0].data.retryId, 'chain-abc');

  const fresh = makeAgent('s1');
  await harness().fire(payload(fresh));
  assert.notEqual(fresh.appended[0].data.retryId, 'chain-abc');
  assert.equal(fresh.appended[0].data.retryId.length, 36);
});

test('a missing or unreadable projection reads as no history', async () => {
  for (const projections of [undefined, new Map(), new Map([['s1', {}]]), new Map([['s1', { llmRetry: null }]])]) {
    const agent = makeAgent('s1');
    const h = harness({ projections });
    await h.fire(payload(agent));
    assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry', 'llm/retry-started']);
    assert.equal(agent.appended[0].data.retry, 1);
  }
});

// ---------------------------------------------------------------------------
// Skips
// ---------------------------------------------------------------------------

test('a hard-denied code is never retried, even if it is allowlisted', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { retryableCodes: ['AUTH'] } });

  const answer = await h.fire(payload(agent, { failure: { message: 'bad key', code: 'AUTH' } }));

  assert.equal(answer, void 0);
  assert.deepEqual(agent.appended, []);
});

test('codes outside the allowlist stay terminal', async () => {
  for (const code of ['UNKNOWN', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED']) {
    const agent = makeAgent('s1');
    const h = harness();
    await h.fire(payload(agent, { failure: { message: 'x', code } }));
    assert.deepEqual(agent.appended, [], code);
  }
});

test('an opt-in code is retried once the deployment allowlists it', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { retryableCodes: ['QUOTA'] } });

  const answer = await h.fire(payload(agent, { failure: { message: 'out of budget', code: 'QUOTA' } }));

  assert.deepEqual(answer, { kind: 'retry' });
  assert.equal(agent.appended[0].data.retry, 1);
});

test('a disabled plugin sends nothing and appends nothing', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { enabled: false } });

  await h.fire(payload(agent));

  assert.deepEqual(agent.appended, []);
});

test('a zero budget means the plugin is installed but inert', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { extraRetries: 0 } });

  await h.fire(payload(agent));

  assert.deepEqual(agent.appended, []);
});

test('an already-aborted turn is never resurrected', async () => {
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  const agent = makeAgent('s1');
  const h = harness();

  const answer = await h.fire(payload(agent, { signal: controller.signal }));

  assert.equal(answer, void 0);
  assert.deepEqual(agent.appended, []);
});

test('a turn cancelled during the wait abandons the retry', async () => {
  const controller = new AbortController();
  const agent = makeAgent('s1');
  const h = harness({ config: { initialDelayMs: 60_000 } });

  const pending = h.fire(payload(agent, { signal: controller.signal }));
  await flush();
  // The scheduled record is durable; the started record must never appear.
  assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry']);

  controller.abort(new Error('user cancelled'));
  const answer = await pending;

  assert.equal(answer, void 0);
  assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry']);
});

test('a malformed failure is skipped rather than thrown on', async () => {
  for (const failure of [null, undefined, {}, { code: 42 }]) {
    const agent = makeAgent('s1');
    const h = harness();
    const answer = await h.fire(payload(agent, { failure }));
    assert.equal(answer, void 0, JSON.stringify(failure));
    assert.deepEqual(agent.appended, []);
  }
});

test('a volatile cell is re-read on every failure, not captured at startup', async () => {
  let enabled = true;
  const cell = Object.freeze({ get: () => enabled });
  const first = makeAgent('s1');
  const h = harness({ config: { enabled: cell } });

  await h.fire(payload(first));
  assert.deepEqual(first.appended.map((e) => e.type), ['llm/retry', 'llm/retry-started']);

  enabled = false;
  const second = makeAgent('s2');
  await h.fire(payload(second));
  assert.deepEqual(second.appended, []);
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

test('a rejected scheduled record abandons the retry instead of retrying unrecorded', async () => {
  const agent = makeAgent('s1');
  agent.session.append = () => {
    throw new Error('session closed');
  };
  const h = harness();

  const answer = await h.fire(payload(agent));

  assert.equal(answer, void 0);
  const errors = h.logs.filter((entry) => entry[0] === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0][1][0].message, /session closed/);
});

test('a rejected started record abandons the retry rather than answering retry', async () => {
  const agent = makeAgent('s1');
  const real = agent.session.append.bind(agent.session);
  agent.session.append = (type, data) => {
    if (type === 'llm/retry-started') throw new Error('session closed');
    real(type, data);
  };
  const h = harness();

  const answer = await h.fire(payload(agent));

  assert.equal(answer, void 0);
  assert.equal(h.logs.filter((entry) => entry[0] === 'error').length, 1);
});

test('a rejected downstream listener propagates rather than being swallowed', async () => {
  const agent = makeAgent('s1');
  const h = harness();
  await assert.rejects(
    h.fire(payload(agent), () => Promise.reject(new Error('downstream exploded'))),
    /downstream exploded/,
  );
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('apply registers the listener and its teardown', () => {
  const { ctx, handlers } = makeCtx();
  const cleanups = [];
  ctx.effect = (fn) => cleanups.push(fn());
  apply(ctx, undefined);
  assert.deepEqual([...handlers.keys()], ['agent/request-error']);
  assert.equal(cleanups.length, 1);
});

test('disposal cancels an in-flight wait and drains it', async () => {
  const agent = makeAgent('s1');
  const h = harness({ config: { initialDelayMs: 60_000 } });

  const pending = h.fire(payload(agent));
  await flush();
  assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry']);

  await h.dispose();
  const answer = await pending;

  assert.equal(answer, void 0);
  // No started record, and the promise settled rather than hanging.
  assert.deepEqual(agent.appended.map((e) => e.type), ['llm/retry']);
});

test('a failure arriving after disposal is declined immediately', async () => {
  const agent = makeAgent('s1');
  const h = harness();
  await h.dispose();

  // The listener is gone from the bus *and* the in-flight guard answers no, so
  // a callback already handed to the dispatcher cannot schedule anything.
  assert.equal(h.handlers.has('agent/request-error'), false);
  const answer = await h.fire(payload(agent));

  assert.equal(answer, void 0);
  assert.deepEqual(agent.appended, []);
});

test('apply returns without throwing on a minimal context', () => {
  const ctx = {
    on: () => () => {},
    effect: () => {},
    sessionProjections: { stateOf: () => undefined },
    logger: { info() {}, warn() {}, error() {} },
  };
  assert.doesNotThrow(() => apply(ctx, undefined));
});
