/**
 * Tests for the browser half.
 *
 * `client.js` is a browser-format artifact: it registers a lazy factory through
 * `window.__ModuleLoader__` rather than exporting anything. So the harness here
 * stubs that global, imports the module for its side effect, and then drives the
 * captured factory with a fake `require` and a mock client context.
 *
 * That is enough to exercise everything that decides what a reader sees — the
 * event fold, the node the fold publishes, the tail panel's summary and field
 * map, and the bundle configuration page's switches and staged writes — without a
 * browser, a slot renderer, or React. Rendering assertions read the element tree
 * the component returns, which is the same tree the real renderer receives, and a
 * minimal hooks runtime lets the config page be driven through several renders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Module capture
// ---------------------------------------------------------------------------

/**
 * A minimal hooks runtime.
 *
 * `RetryConfigPanel` is a real function component, so driving its Save button
 * means re-rendering after a setter runs. This tracks one cell per call site and
 * redraws on every write — enough for the state this component keeps, and no
 * more.
 */
function createHooks() {
  const cells = [];
  let cursor = 0;
  let redraw = null;
  return {
    onRedraw(fn) {
      redraw = fn;
    },
    begin() {
      cursor = 0;
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (cells.length <= index) {
        cells[index] = typeof initial === 'function' ? initial() : initial;
      }
      const set = (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next;
        if (redraw !== null) redraw();
      };
      return [cells[index], set];
    },
    useCallback(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previous = cells[index];
      const same = previous !== undefined
        && previous.deps.length === deps.length
        && previous.deps.every((dep, at) => Object.is(dep, deps[at]));
      if (same) return previous.fn;
      cells[index] = { fn, deps };
      return fn;
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor;
      cursor += 1;
      const previous = cells[index];
      // Subscribing during render stands in for the effect React would use: what
      // matters here is that a change in the source reaches the component.
      const listen = () => subscribe(() => { if (redraw !== null) redraw(); });
      if (previous === undefined) {
        const cell = { subscribe, unsubscribe: null };
        cell.unsubscribe = listen();
        cells[index] = cell;
      } else if (previous.subscribe !== subscribe) {
        previous.unsubscribe();
        previous.subscribe = subscribe;
        previous.unsubscribe = listen();
      }
      return getSnapshot();
    },
  };
}

/** The hooks runtime the current render belongs to, if any. */
let activeHooks = null;

/** Minimal `React.createElement` plus the hooks the panel actually calls. */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: flatten(children) } };
  },
  useState(initial) {
    if (activeHooks !== null) return activeHooks.useState(initial);
    // Outside a driven render the value is still needed, but a write has nowhere
    // to go; that keeps a bare call a read rather than a crash.
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  // Memoization is an optimization, not an observable: calling through is enough
  // to prove the component reads its source correctly.
  useCallback: (fn, deps) => (activeHooks !== null ? activeHooks.useCallback(fn, deps) : fn),
  useSyncExternalStore: (subscribe, getSnapshot) => (
    activeHooks !== null ? activeHooks.useSyncExternalStore(subscribe, getSnapshot) : getSnapshot()
  ),
};

/** Flatten the variadic children `createElement` receives, dropping absent ones. */
function flatten(children) {
  const out = [];
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child));
    else if (child === null || child === undefined || typeof child === 'boolean') continue;
    else out.push(child);
  }
  return out;
}

/** Render a component under the mini hooks runtime, redrawing on every write. */
function mount(component, props) {
  const hooks = createHooks();
  let tree = null;
  const draw = () => {
    const previous = activeHooks;
    activeHooks = hooks;
    try {
      hooks.begin();
      tree = component(props);
    } finally {
      activeHooks = previous;
    }
  };
  hooks.onRedraw(draw);
  draw();
  return { draw, get tree() { return tree; } };
}

let spec;
globalThis.window = { __ModuleLoader__: { load: (loaded) => { spec = loaded; } } };
await import('../client.js');

/** The module under test, built once from the captured factory. */
const mod = spec.factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`unexpected require("${id}")`);
});

// ---------------------------------------------------------------------------
// Element-tree helpers
// ---------------------------------------------------------------------------

/** All text inside one element tree, joined for substring assertions. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object' && 'type' in node) return textOf(node.props.children);
  return '';
}

/** Every element in the tree matching one predicate, in document order. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (!('type' in node)) return out;
  if (predicate(node)) out.push(node);
  findAll(node.props.children, predicate, out);
  return out;
}

/** The single control carrying one `data-field` name. */
function controlOf(tree, name, { expect = 1 } = {}) {
  const found = findAll(tree, (node) => node.props['data-field'] === name);
  assert.equal(found.length, expect, `expected ${expect} control(s) for ${name}`);
  return found[0];
}

/** The single code switch carrying one catalogued code. */
function codeOf(tree, code) {
  const found = findAll(tree, (node) => node.props['data-code'] === code);
  assert.equal(found.length, 1, `expected exactly one switch for ${code}`);
  return found[0];
}

/** Every catalogued code the page currently offers, in render order. */
function offeredCodes(tree) {
  return findAll(tree, (node) => typeof node.props['data-code'] === 'string')
    .map((node) => node.props['data-code']);
}

/** The `t` a component receives, backed by the plugin's own dictionary. */
function translator(dictionary) {
  return (key, params) => {
    const template = dictionary[key];
    if (typeof template !== 'string') return key;
    return template.replace(/\{(\w+)\}/g, (_match, name) => (
      params !== undefined && name in params ? String(params[name]) : `{${name}}`
    ));
  };
}

// ---------------------------------------------------------------------------
// Context capture
// ---------------------------------------------------------------------------

/** A mock client root context that captures every registration `apply` makes. */
function makeClientCtx({ sessionBinding, conversationBinding, configForms } = {}) {
  const captured = {
    effects: [],
    injected: [],
    softInjected: [],
    registrations: [],
    namespaces: [],
    localeNs: null,
    dictionaries: null,
    definition: null,
  };
  const ctx = {
    effect(fn) {
      captured.effects.push(fn());
    },
    inject(deps, callback) {
      captured.softInjected.push([...deps]);
      callback(ctx);
    },
    configForms: configForms ?? {
      get(namespace) {
        captured.namespaces.push(namespace);
        return undefined;
      },
    },
    locale: {
      register(ns, dictionaries) {
        captured.localeNs = ns;
        captured.dictionaries = dictionaries;
      },
      bind: () => () => '',
    },
    uiConversation: {
      events: {
        register(definition) {
          captured.definition = definition;
        },
      },
      binding: conversationBinding ?? (() => {
        throw new Error('no conversation binding configured');
      }),
    },
    sessions: {
      binding: sessionBinding ?? (() => undefined),
    },
    slots: {
      inject(name, contribute) {
        captured.injected.push(name);
        contribute();
      },
      register(options, component) {
        captured.registrations.push({ options, component });
      },
    },
  };
  return { ctx, captured };
}

/** Apply the client half once and hand back everything it registered. */
function load(options) {
  const { ctx, captured } = makeClientCtx(options);
  mod.apply(ctx);
  const registrationOf = (name) => captured.registrations.find((entry) => entry.options.name === name);
  return {
    ...captured,
    registrationOf,
    turnTail: registrationOf('conversation.chat.turnTail'),
    bundleConfig: registrationOf('plugins.bundle.config'),
    /** The `t` a component receives for one locale. */
    t: (locale = 'zh') => translator(captured.dictionaries[locale]),
  };
}

// ---------------------------------------------------------------------------
// Manifest and registration
// ---------------------------------------------------------------------------

test('the factory registers the module under the package id', () => {
  assert.equal(spec.id, 'dsh-plugin-auto-retry');
  assert.equal(typeof spec.factory, 'function');
});

test('the client half declares the services it reads', () => {
  assert.deepEqual(mod.inject, ['slots', 'sessions', 'locale', 'uiConversation']);
  // `configForms` is deliberately absent: it is reached through a nested fiber,
  // so a deployment without the settings package loses the configuration page
  // instead of the whole client half.
  assert.ok(!mod.inject.includes('configForms'));
});

test('apply registers styles, dictionaries, the definition, and both seats', () => {
  const captured = load();

  // Styles, dictionaries, definition, and the configuration page's own fiber.
  assert.equal(captured.effects.length, 4);
  assert.equal(typeof captured.effects[0], 'function', 'styles must return a cleanup');

  assert.equal(captured.localeNs, 'auto-retry');
  assert.equal(typeof captured.dictionaries.zh, 'object');
  assert.equal(typeof captured.dictionaries.en, 'object');
  // Both dictionaries must carry the same keys, or one locale silently falls back.
  assert.deepEqual(
    Object.keys(captured.dictionaries.zh).sort(),
    Object.keys(captured.dictionaries.en).sort(),
  );

  assert.equal(captured.definition.kind, 'auto-retry');
  assert.deepEqual(captured.injected.slice().sort(), ['conversation.chat.turnTail', 'plugins.bundle.config']);
  assert.deepEqual(captured.softInjected, [['configForms']]);
});

test('the turn tail seat is registered with the conversation id and locale', () => {
  const { turnTail } = load();
  assert.equal(turnTail.options.id, 'dsh-plugin-auto-retry');
  assert.equal(turnTail.options.locale, 'auto-retry');
  assert.equal(typeof turnTail.component, 'function');
});

test('the config seat claims the bundle key the Plugins page dispatches', () => {
  // A Host `Config` schema alone puts no control on the Plugins page: one appears
  // only while an occupant claims a configuration key, and this is the only
  // place that claim can be made. The bundle-level seat is keyed by the package
  // name and renders on the bundle's page, one click shallower than the row's.
  const { bundleConfig } = load();
  assert.equal(bundleConfig.options.key, 'dsh-plugin-auto-retry');
  assert.equal(bundleConfig.options.locale, 'auto-retry');
  assert.equal(typeof bundleConfig.component, 'function');
});

test('the config seat builds its own form from the namespace the patch declares', () => {
  // The bundle seat is rendered with `{ view: 'page' }` and nothing else — unlike
  // the row seat, which is handed a form — so the occupant has to source one.
  // The namespace is the patch row's id, and a mismatch would surface as an
  // always-empty page rather than as a load failure.
  const asked = [];
  const controller = { getSnapshot: () => ({ status: 'ready', value: {} }), subscribe: () => () => {} };
  const { bundleConfig } = load({ configForms: { get: (ns) => { asked.push(ns); return controller; } } });

  assert.equal(bundleConfig.options.inject().form, controller);
  assert.deepEqual(asked, ['auto-retry']);
});

test('the tail seat resolves the turn data source by turn number', () => {
  const seen = [];
  const chat = {
    getSnapshot: () => ({
      nodes: {
        turnDataSource(turn, kind) {
          seen.push([turn, kind]);
          return { turn, kind };
        },
      },
    }),
  };
  const captured = load({
    sessionBinding: () => 'binding-1',
    conversationBinding: () => ({ target: () => chat }),
  });

  const face = captured.turnTail.options.inject('session-1');

  assert.deepEqual(face.keyedHooks.retryErrors('7'), { turn: 7, kind: 'auto-retry' });
  assert.deepEqual(seen, [[7, 'auto-retry']]);
});

test('an unknown session or an unavailable chat target is a loud failure', () => {
  const unknown = load({ sessionBinding: () => undefined });
  assert.throws(() => unknown.turnTail.options.inject('ghost'), /unknown session "ghost"/);

  const noSnapshot = load({
    sessionBinding: () => 'binding-1',
    conversationBinding: () => ({ target: () => ({ getSnapshot: () => undefined }) }),
  });
  const face = noSnapshot.turnTail.options.inject('session-1');
  assert.throws(() => face.keyedHooks.retryErrors('7'), /Chat target is unavailable/);
});

// ---------------------------------------------------------------------------
// The event fold
// ---------------------------------------------------------------------------

/** One `llm/retry` event for a turn. */
function retryEvent(turn, seq, overrides = {}) {
  return {
    type: 'llm/retry',
    seq,
    time: seq * 1000,
    data: {
      retryId: `chain-${seq}`,
      turn,
      step: 2,
      provider: 'magpie',
      mode: 'normal',
      policyKey: '["auto-retry",3]',
      retry: 1,
      maxRetries: 3,
      delayMs: 1000,
      failure: { message: 'upstream said no', code: 'RATE_LIMIT' },
      ...overrides,
    },
  };
}

/** The seed event for a turn. */
function turnStart(turn, seq) {
  return { type: 'turn/start', seq, time: seq * 1000, data: { turn } };
}

/** A terminal `turn/end` error for a turn. */
function turnEndError(turn, seq, failure = { message: 'finally failed', code: 'SERVER' }) {
  return { type: 'turn/end', seq, time: seq * 1000, data: { turn, reason: { kind: 'error', error: failure } } };
}

test('the definition matches the events it folds and nothing else', () => {
  const { definition } = load();

  assert.deepEqual(definition.match(turnStart(7, 1)), { id: '7', role: 'start' });
  assert.deepEqual(definition.match(retryEvent(7, 2)), { id: '7', role: 'update' });
  assert.deepEqual(definition.match(turnEndError(7, 3)), { id: '7', role: 'update' });

  // A successful turn end is not ours to render.
  assert.equal(
    definition.match({ type: 'turn/end', seq: 4, data: { turn: 7, reason: { kind: 'completed' } } }),
    null,
  );
  assert.equal(
    definition.match({ type: 'turn/end', seq: 4, data: { turn: 7, reason: { kind: 'max-tokens' } } }),
    null,
  );
  assert.equal(definition.match({ type: 'step/start', seq: 4, data: { turn: 7, step: 1 } }), null);
  assert.equal(definition.match({ type: 'tool/call', seq: 5, data: { turn: 7 } }), null);
});

test('the definition folds a whole turn into one hidden node', () => {
  const { definition } = load();

  const seed = { event: turnStart(7, 1), location: { kind: 'turn', turn: 7 } };
  const context = {
    key: 'turn-7',
    id: '7',
    start: seed,
    matches: [seed],
    state: definition.start({}, seed),
  };

  context.state = definition.update(context, { event: retryEvent(7, 2) });
  context.state = definition.update(context, { event: retryEvent(7, 3, { retry: 2, policyKey: '["normal",5]' }) });
  context.state = definition.update(context, { event: turnEndError(7, 4) });

  assert.equal(context.state.turn, 7);
  assert.equal(context.state.retries.length, 2);
  assert.equal(context.state.retries[0].retry, 1);
  assert.equal(context.state.retries[1].policyKey, '["normal",5]');
  assert.equal(context.state.terminal.failure.code, 'SERVER');

  const node = definition.buildViewNode(context);
  assert.equal(node.kind, 'auto-retry');
  assert.equal(node.target, 'chat');
  assert.equal(node.id, '7');
  assert.equal(node.visibility, 'hidden', 'the node must not add a chat row of its own');
  assert.equal(node.anchorSeq, 1);
  assert.deepEqual(node.location, seed.location);
  assert.equal(node.data, context.state);
});

test('a turn that only retried keeps a null terminal, and vice versa', () => {
  const { definition } = load();
  const seed = { event: turnStart(7, 1), location: { kind: 'turn', turn: 7 } };
  const context = { key: 'k', id: '7', start: seed, matches: [seed], state: definition.start({}, seed) };

  const retried = definition.update(context, { event: retryEvent(7, 2) });
  assert.equal(retried.terminal, null);
  assert.equal(retried.retries.length, 1);

  const failed = definition.update(context, { event: turnEndError(7, 3) });
  assert.equal(failed.retries.length, 0);
  assert.equal(failed.terminal.failure.code, 'SERVER');
});

test('the terminal record reads reason.error, not reason.failure', () => {
  const { definition } = load();
  const seed = { event: turnStart(7, 1), location: { kind: 'turn', turn: 7 } };
  const context = { key: 'k', id: '7', start: seed, matches: [seed], state: definition.start({}, seed) };

  // The harness types this variant as `{ kind: 'error'; error: LlmFailure }`.
  const state = definition.update(context, {
    event: {
      type: 'turn/end',
      seq: 9,
      time: 9000,
      data: { turn: 7, reason: { kind: 'error', error: { message: 'boom', code: 'AUTH' } } },
    },
  });

  assert.equal(state.terminal.failure.message, 'boom');
  assert.equal(state.terminal.failure.code, 'AUTH');
});

test('a start match on the wrong event is a loud failure', () => {
  const { definition } = load();
  assert.throws(
    () => definition.start({}, { event: retryEvent(7, 2) }),
    /start requires turn\/start/,
  );
});

// ---------------------------------------------------------------------------
// The tail panel
// ---------------------------------------------------------------------------

/** Render the tail panel for one folded state and hand back the element tree. */
function render(state, { turn = { turn: 7 }, locale = 'zh' } = {}) {
  const captured = load();
  return captured.turnTail.component({
    turn,
    useRetryErrors: () => (state === undefined ? [] : [state]),
    t: captured.t(locale),
  });
}

/** One complete retry record, with every optional field populated. */
function record(overrides = {}) {
  return {
    seq: 10,
    time: 10_000,
    retryId: 'chain-1',
    provider: 'magpie',
    turn: 4,
    step: 2,
    mode: 'normal',
    policyKey: '["auto-retry",3]',
    retry: 2,
    maxRetries: 3,
    delayMs: 1200,
    failure: { message: 'upstream said no', code: 'RATE_LIMIT', status: 429, requestId: 'req-1' },
    ...overrides,
  };
}

/** The labels rendered in one tree. */
function labels(tree) {
  return findAll(tree, (node) => node.type === 'span' && node.props.className === 'dar_label').map(textOf);
}

test('the panel renders nothing for a turn that neither retried nor failed', () => {
  assert.equal(render({ turn: 7, retries: [], terminal: null }), null);
  assert.equal(render(undefined), null);
});

test('the panel is a collapsed disclosure, not an open one', () => {
  const tree = render({ turn: 7, retries: [record()], terminal: null });

  assert.equal(tree.type, 'details');
  // No `open` attribute: the reader expands it deliberately.
  assert.equal('open' in tree.props, false);
  assert.equal(tree.props['data-auto-retry'], true);
  assert.equal(tree.props.children[0].type, 'summary');
});

test('a recovered turn summarises the retry count', () => {
  const tree = render({ turn: 7, retries: [record(), record({ seq: 11 })], terminal: null });
  assert.match(textOf(tree.props.children[0]), /本轮重试 2 次/);
  assert.equal(/最终失败/.test(textOf(tree.props.children[0])), false);
});

test('a failed turn names the terminal code in the summary', () => {
  const tree = render({
    turn: 7,
    retries: [record()],
    terminal: { seq: 12, time: 12_000, turn: 7, failure: { message: 'boom', code: 'SERVER' } },
  });
  const summary = textOf(tree.props.children[0]);
  assert.match(summary, /本轮重试 1 次/);
  assert.match(summary, /SERVER/);
});

test('a turn that failed without retrying names the code instead of a count', () => {
  const tree = render({
    turn: 7,
    retries: [],
    terminal: { seq: 12, time: 12_000, turn: 7, failure: { message: 'boom', code: 'AUTH' } },
  });
  const summary = textOf(tree.props.children[0]);
  assert.match(summary, /本轮最终失败 AUTH/);
  // "retried 0 times" would be noise; the code is the fact worth stating.
  assert.equal(/重试 0 次/.test(summary), false);
});

test('every recorded field reaches the reader', () => {
  const tree = render({ turn: 7, retries: [record()], terminal: null });
  const text = textOf(tree);

  for (const label of ['错误码', 'HTTP', '提供方', '位置', '等待', '请求 id', '完整报错']) {
    assert.equal(labels(tree).includes(label), true, label);
  }
  assert.match(text, /RATE_LIMIT/);
  assert.match(text, /429/);
  assert.match(text, /magpie/);
  assert.match(text, /第 4 轮 · 第 2 步/);
  assert.match(text, /1200 ms/);
  assert.match(text, /req-1/);
  assert.match(text, /upstream said no/);
});

test('absent optional fields render no row at all', () => {
  const tree = render({
    turn: 7,
    retries: [record({ failure: { message: 'bare', code: 'SERVER' }, provider: undefined, delayMs: undefined })],
    terminal: null,
  });
  const present = labels(tree);

  assert.equal(present.includes('错误码'), true);
  assert.equal(present.includes('完整报错'), true);
  assert.equal(present.includes('HTTP'), false);
  assert.equal(present.includes('请求 id'), false);
  assert.equal(present.includes('提供方'), false);
  assert.equal(present.includes('等待'), false);
});

test('the raw message survives the codes the native row maps away', () => {
  // `failureMessage()` replaces AUTH and QUOTA text with a short phrase, which
  // is exactly the loss this panel exists to undo.
  for (const code of ['AUTH', 'QUOTA', 'ACCOUNT_QUOTA']) {
    const tree = render({
      turn: 7,
      retries: [record({ failure: { message: `provider detail for ${code}`, code } })],
      terminal: null,
    });
    assert.equal(textOf(tree).includes(`provider detail for ${code}`), true, code);
  }
});

test('the raw message is rendered as a block, never truncated by the panel', () => {
  const long = `${'x'.repeat(2000)} END`;
  const tree = render({ turn: 7, retries: [record({ failure: { message: long, code: 'SERVER' } })], terminal: null });
  const blocks = findAll(tree, (node) => node.type === 'pre' && node.props.className === 'dar_message');

  assert.equal(blocks.length, 1);
  assert.equal(textOf(blocks[0]), long);
});

test('each attempt is labelled by which producer scheduled it', () => {
  const tree = render({
    turn: 7,
    retries: [
      record({ seq: 10, policyKey: '["auto-retry",3,[]]' }),
      record({ seq: 11, policyKey: '["normal",5,[]]' }),
    ],
    terminal: null,
  });
  const text = textOf(tree);

  assert.match(text, /插件重试/);
  assert.match(text, /官方重试/);
});

test('an always-mode attempt shows an unbounded maximum', () => {
  const tree = render({
    turn: 7,
    retries: [record({ mode: 'always', maxRetries: undefined, retry: 4 })],
    terminal: null,
  });
  assert.match(textOf(tree), /第 4\/∞ 次/);
});

test('the terminal failure renders its own block without retry-only fields', () => {
  const tree = render({
    turn: 7,
    retries: [],
    terminal: { seq: 12, time: 12_000, turn: 7, failure: { message: 'the whole chain', code: 'SERVER', status: 503 } },
  });
  const text = textOf(tree);

  assert.match(text, /终态失败/);
  assert.match(text, /轮次结束/);
  assert.match(text, /the whole chain/);
  assert.match(text, /503/);
  // No retry index and no wait for a terminal failure.
  assert.equal(/第 \d+\/\d+ 次/.test(text), false);
  assert.equal(labels(tree).includes('等待'), false);
});

test('the panel reads an English dictionary just as well', () => {
  const tree = render({ turn: 7, retries: [record()], terminal: null }, { locale: 'en' });
  assert.match(textOf(tree), /Retried 1 time\(s\) this turn/);
  assert.equal(labels(tree).includes('Full error'), true);
});

test('the panel accepts a bare turn number as well as the Turn object', () => {
  const captured = load();
  const seen = [];
  const tree = captured.turnTail.component({
    turn: 7,
    useRetryErrors: (key) => {
      seen.push(key);
      return [{ turn: 7, retries: [], terminal: null }];
    },
    t: captured.t('zh'),
  });

  assert.deepEqual(seen, ['7']);
  assert.equal(tree, null, 'an empty state renders nothing');
});

test('a state whose retries field is malformed is treated as empty', () => {
  assert.equal(render({ turn: 7, retries: null, terminal: null }), null);
  assert.equal(render({ turn: 7, retries: undefined, terminal: null }), null);
});

// ---------------------------------------------------------------------------
// The bundle configuration page
// ---------------------------------------------------------------------------

/**
 * One `configForms` entry as the provider hands it over.
 *
 * The bundle seat builds its form from the service, so the object is the
 * controller itself: an observable with `getSnapshot`/`subscribe`, plus the write
 * queue. The page re-reads it on every render rather than being handed a
 * snapshot, which is what lets a slower answer reach the page without a remount.
 */
function configForm(value, { writable = true, revision = 3, mutate, status = 'ready' } = {}) {
  const listeners = new Set();
  let state = { status, value, base: {}, user: {}, revision, writable, mode: 'host' };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate: mutate ?? (() => Promise.resolve(true)),
    /** Test-only: what the shared mirror does when it folds a new answer in. */
    accept(next) {
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A controller in one of the two states that render no form at all. */
function configStatus(status) {
  return configForm(undefined, { status, writable: false, revision: undefined });
}

/** The accepted values an installation with the shipped patch would report. */
function accepted(overrides = {}) {
  return {
    enabled: true,
    extraRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
    retryableCodes: ['RATE_LIMIT', 'SERVER'],
    ...overrides,
  };
}

/** Mount the bundle config page with one locale. */
function mountConfig(props, locale = 'zh') {
  const captured = load();
  return mount(captured.bundleConfig.component, { t: captured.t(locale), ...props });
}

/** Let the promise chain inside `save()` settle. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Click the page's one button. */
function clickSave(mounted) {
  findAll(mounted.tree, (node) => node.type === 'button')[0].props.onClick();
}

test('the summary view is the row one-liner', () => {
  const tree = mountConfig({ view: 'summary' }).tree;
  assert.match(textOf(tree), /接手官方重试执行器放弃的模型请求失败/);
});

test('the page view renders every field, seeded from the accepted value', () => {
  const { tree } = mountConfig({ view: 'page', form: configForm(accepted()) });

  assert.equal(tree.props['data-auto-retry-config'], true);
  assert.equal(controlOf(tree, 'enabled').props.checked, true);
  assert.equal(controlOf(tree, 'extraRetries').props.value, '3');
  assert.equal(controlOf(tree, 'initialDelayMs').props.value, '1000');
  assert.equal(controlOf(tree, 'maxDelayMs').props.value, '60000');
  assert.equal(controlOf(tree, 'jitterRatio').props.value, '0.2');
  assert.equal(controlOf(tree, 'extra').props.value, '');

  // Every numeric control carries the bounds the Host enforces.
  assert.equal(controlOf(tree, 'extraRetries').props.min, 0);
  assert.equal(controlOf(tree, 'extraRetries').props.max, 10);
  assert.equal(controlOf(tree, 'jitterRatio').props.max, 1);
});

test('the code switches are seeded from the accepted list, not from the catalog default', () => {
  const { tree } = mountConfig({ view: 'page', form: configForm(accepted()) });

  assert.equal(codeOf(tree, 'RATE_LIMIT').props.checked, true);
  assert.equal(codeOf(tree, 'SERVER').props.checked, true);
  // In the catalog, absent from the accepted list: the page reports what is
  // configured rather than what would be configured by default.
  assert.equal(codeOf(tree, 'TIMEOUT').props.checked, false);
  assert.equal(codeOf(tree, 'QUOTA').props.checked, false);
});

test('the catalog is offered whole, so no code has to be typed from memory', () => {
  const { tree } = mountConfig({ view: 'page', form: configForm(accepted()) });
  const codes = offeredCodes(tree);

  // The five the harness retries by default, plus the two adapter catch-alls.
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROVIDER_ERROR', 'PI_AI_ERROR']) {
    assert.ok(codes.includes(code), `${code} should be offered`);
  }
  // The ones a deployment may opt into, and the hard floor it may not.
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'UNKNOWN']) {
    assert.ok(codes.includes(code), `${code} should be offered`);
  }
  for (const code of ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER', 'INVALID_MODEL', 'INVALID_CONFIG']) {
    assert.ok(codes.includes(code), `${code} should be offered, if only to be shown refused`);
  }
  assert.equal(new Set(codes).size, codes.length, 'no code is offered twice');
});

test('the hard floor is shown disabled, because no setting can enable it', () => {
  const { tree } = mountConfig({ view: 'page', form: configForm(accepted()) });

  for (const code of ['AUTH', 'INVALID_MODEL', 'NO_ADAPTER']) {
    assert.equal(codeOf(tree, code).props.disabled, true, `${code} must not be switchable`);
  }
  // Opt-in codes stay switchable: the reader decides those.
  assert.equal(codeOf(tree, 'QUOTA').props.disabled, false);
  assert.equal(codeOf(tree, 'TIMEOUT').props.disabled, false);
});

test('a code outside the catalog lives in the escape hatch, not in the switches', () => {
  const { tree } = mountConfig({
    view: 'page',
    form: configForm(accepted({ retryableCodes: ['RATE_LIMIT', 'KILO_WEIRD_CODE'] })),
  });

  assert.equal(codeOf(tree, 'RATE_LIMIT').props.checked, true);
  assert.equal(controlOf(tree, 'extra').props.value, 'KILO_WEIRD_CODE');
  assert.ok(!offeredCodes(tree).includes('KILO_WEIRD_CODE'), 'an invented code is not a switch');
});

test('a missing form says so instead of rendering an empty page', () => {
  const tree = mountConfig({ view: 'page', form: undefined }).tree;
  assert.match(textOf(tree), /该命名空间当前不可写/);
});

test('a namespace the deployment does not serve says so, and offers no form', () => {
  // The bundle seat is reachable whether or not the Host composed this bundle's
  // row, so this is a real state rather than a defensive branch: saying it beats
  // drawing inputs whose Save could only fail.
  const tree = mountConfig({ view: 'page', form: configStatus('unavailable') }).tree;
  assert.match(textOf(tree), /该命名空间不可写/);
  assert.equal(controlOf(tree, 'extraRetries', { expect: 0 }), undefined);
});

test('a namespace still being read says so rather than showing empty fields', () => {
  const tree = mountConfig({ view: 'page', form: configStatus('loading') }).tree;
  assert.match(textOf(tree), /正在读取配置/);
});

test('an answer that arrives after mount fills the page in rather than leaving it blank', () => {
  // The bundle page mounts while the shared describe mirror is still reading, so
  // there is nothing to seed a draft from at the first render. The page has to
  // follow the answer in — and the draft must not be a snapshot taken while the
  // form was empty, or the reader would be shown blank inputs and a Save that
  // could only fail.
  const controller = configForm(undefined, { status: 'loading' });
  const mounted = mountConfig({ view: 'page', form: controller });
  assert.match(textOf(mounted.tree), /正在读取配置/);

  controller.accept({ status: 'ready', value: accepted() });

  assert.equal(controlOf(mounted.tree, 'extraRetries').props.value, '3');
  assert.equal(controlOf(mounted.tree, 'maxDelayMs').props.value, '60000');
  assert.equal(codeOf(mounted.tree, 'RATE_LIMIT').props.checked, true);
  assert.equal(controlOf(mounted.tree, 'extra').props.value, '');
});

test('a non-writable namespace disables every control and the save button', () => {
  const { tree } = mountConfig({ view: 'page', form: configForm(accepted(), { writable: false }) });

  assert.equal(controlOf(tree, 'extraRetries').props.disabled, true);
  assert.equal(controlOf(tree, 'extra').props.disabled, true);
  assert.equal(codeOf(tree, 'RATE_LIMIT').props.disabled, true);
  assert.equal(findAll(tree, (node) => node.type === 'button')[0].props.disabled, true);
});

test('saving an untouched form writes nothing and reports success', async () => {
  let mutated = 0;
  const mounted = mountConfig({
    view: 'page',
    form: configForm(accepted(), { mutate: () => { mutated += 1; return Promise.resolve(true); } }),
  });

  clickSave(mounted);
  await settle();

  assert.equal(mutated, 0, 'no change means no write');
  assert.match(textOf(mounted.tree), /已保存/);
});

test('a changed number is submitted as a path-addressed set under the read revision', async () => {
  const calls = [];
  const mounted = mountConfig({
    view: 'page',
    form: configForm(accepted(), {
      revision: 11,
      mutate: (ops, rev) => { calls.push([ops, rev]); return Promise.resolve(true); },
    }),
  });

  controlOf(mounted.tree, 'extraRetries').props.onChange({ target: { value: '5' } });
  clickSave(mounted);
  await settle();

  assert.deepEqual(calls, [[[{ op: 'set', path: ['extraRetries'], value: 5 }], 11]]);
});

test('a toggled boolean and an edited code list submit together', async () => {
  const calls = [];
  const mounted = mountConfig({
    view: 'page',
    form: configForm(accepted(), { mutate: (ops) => { calls.push(ops); return Promise.resolve(true); } }),
  });

  controlOf(mounted.tree, 'enabled').props.onChange({ target: { checked: false } });
  // One switch on, one switch off, plus an invented code in the escape hatch:
  // the submitted list is the union, and it reads in catalog order regardless
  // of the order the reader touched things.
  codeOf(mounted.tree, 'TIMEOUT').props.onChange({ target: { checked: true } });
  codeOf(mounted.tree, 'SERVER').props.onChange({ target: { checked: false } });
  controlOf(mounted.tree, 'extra').props.onChange({ target: { value: 'KILO_WEIRD_CODE' } });
  clickSave(mounted);
  await settle();

  assert.deepEqual(calls, [[
    { op: 'set', path: ['retryableCodes'], value: ['RATE_LIMIT', 'TIMEOUT', 'KILO_WEIRD_CODE'] },
    { op: 'set', path: ['enabled'], value: false },
  ]]);
});

test('reordering the same codes is not a change, so reordering alone writes nothing', async () => {
  let mutated = 0;
  const mounted = mountConfig({
    view: 'page',
    form: configForm(
      accepted({ retryableCodes: ['SERVER', 'RATE_LIMIT'] }),
      { mutate: () => { mutated += 1; return Promise.resolve(true); } },
    ),
  });

  // The switches re-emit catalog order, which differs from the accepted order.
  assert.equal(codeOf(mounted.tree, 'RATE_LIMIT').props.checked, true);
  clickSave(mounted);
  await settle();

  assert.equal(mutated, 0, 'the same set of codes is not an edit');
  assert.match(textOf(mounted.tree), /已保存/);
});

test('a denied code already in the config is shown as-is, and never silently dropped', async () => {
  const calls = [];
  const mounted = mountConfig({
    view: 'page',
    form: configForm(
      accepted({ retryableCodes: ['RATE_LIMIT', 'AUTH'] }),
      { mutate: (ops) => { calls.push(ops); return Promise.resolve(true); } },
    ),
  });

  // AUTH is in the hard floor: it renders disabled. It is also already in the
  // config, and the page reports the config rather than quietly rewriting it —
  // an untouched list must not produce a write the reader never asked for.
  const auth = codeOf(mounted.tree, 'AUTH');
  assert.equal(auth.props.disabled, true);
  assert.equal(auth.props.checked, true);

  controlOf(mounted.tree, 'extraRetries').props.onChange({ target: { value: '4' } });
  clickSave(mounted);
  await settle();

  assert.deepEqual(calls, [[{ op: 'set', path: ['extraRetries'], value: 4 }]]);

  // And the switch cannot be operated even if something fires it anyway.
  auth.props.onChange({ target: { checked: false } });
  clickSave(mounted);
  await settle();
  assert.ok(
    calls.every((ops) => !ops.some((op) => op.path[0] === 'retryableCodes')),
    'the hard floor holds even against a synthetic event',
  );
});

test('turning every code off is refused, because the Host would read it as a typo', async () => {
  // The Host's `codesWithin()` reads an empty allowlist as a mistyped one and
  // falls back to its defaults. Saving one would leave the page saying "no codes"
  // while seven were still taken over — the page refuses to create that state,
  // and says so while the reader is still deciding, not only on Save.
  let mutated = 0;
  const mounted = mountConfig({
    view: 'page',
    form: configForm(accepted(), { mutate: () => { mutated += 1; return Promise.resolve(true); } }),
  });

  codeOf(mounted.tree, 'RATE_LIMIT').props.onChange({ target: { checked: false } });
  codeOf(mounted.tree, 'SERVER').props.onChange({ target: { checked: false } });

  assert.match(textOf(mounted.tree), /宿主会当成笔误/);

  clickSave(mounted);
  await settle();
  assert.equal(mutated, 0, 'an empty allowlist must never reach the Host');
  assert.match(textOf(mounted.tree), /retryableCodes/);
});

test('one code left is enough, and the warning goes away again', async () => {
  const calls = [];
  const mounted = mountConfig({
    view: 'page',
    form: configForm(accepted(), { mutate: (ops) => { calls.push(ops); return Promise.resolve(true); } }),
  });

  codeOf(mounted.tree, 'RATE_LIMIT').props.onChange({ target: { checked: false } });
  codeOf(mounted.tree, 'SERVER').props.onChange({ target: { checked: false } });
  assert.match(textOf(mounted.tree), /宿主会当成笔误/);

  // An invented code counts: the escape hatch is part of the same list.
  controlOf(mounted.tree, 'extra').props.onChange({ target: { value: 'KILO_WEIRD_CODE' } });
  assert.doesNotMatch(textOf(mounted.tree), /宿主会当成笔误/);

  clickSave(mounted);
  await settle();
  assert.deepEqual(calls, [[
    { op: 'set', path: ['retryableCodes'], value: ['KILO_WEIRD_CODE'] },
  ]]);
});

test('an unparseable number blocks the whole save', async () => {  let mutated = 0;
  const mounted = mountConfig({
    view: 'page',
    form: configForm(accepted(), { mutate: () => { mutated += 1; return Promise.resolve(true); } }),
  });

  controlOf(mounted.tree, 'maxDelayMs').props.onChange({ target: { value: 'soon' } });
  clickSave(mounted);
  await settle();

  assert.equal(mutated, 0, 'nothing may be submitted while a field is unusable');
  assert.match(textOf(mounted.tree), /有字段未通过校验/);
  assert.match(textOf(mounted.tree), /maxDelayMs/);
});

test('an out-of-range number is refused rather than clamped silently', async () => {
  let mutated = 0;
  const mounted = mountConfig({
    view: 'page',
    form: configForm(accepted(), { mutate: () => { mutated += 1; return Promise.resolve(true); } }),
  });

  controlOf(mounted.tree, 'extraRetries').props.onChange({ target: { value: '99' } });
  clickSave(mounted);
  await settle();

  assert.equal(mutated, 0);
  assert.match(textOf(mounted.tree), /extraRetries/);
});

test('a refused write and a failed transport both report failure', async () => {
  for (const mutate of [
    () => Promise.resolve(false),
    () => Promise.reject(new Error('offline')),
  ]) {
    const mounted = mountConfig({ view: 'page', form: configForm(accepted(), { mutate }) });
    controlOf(mounted.tree, 'extraRetries').props.onChange({ target: { value: '5' } });
    clickSave(mounted);
    await settle();
    assert.match(textOf(mounted.tree), /保存失败/);
  }
});

test('the page reads an English dictionary just as well', () => {
  const { tree } = mountConfig({ view: 'page', form: configForm(accepted()) }, 'en');
  assert.match(textOf(tree), /Extra retries/);
  assert.match(textOf(tree), /Retryable codes/);
});
