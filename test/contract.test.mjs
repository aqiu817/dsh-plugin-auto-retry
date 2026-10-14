/**
 * Load-contract test.
 *
 * The other three suites prove the plugin *behaves*. This one proves it
 * *loads*: that the module graph resolves from this package's own real path,
 * that every export the Cordis loader expects is present and correctly typed,
 * that the loader's exact config-validation step does not throw, and that the
 * bundle manifest points at files that exist.
 *
 * The last point is the one that matters for "did this break the whole of dsh":
 * the loader runs
 *
 *     function jc(e, n) {
 *       if (!e.Config) return n;
 *       const o = e.Config["~standard"].validate(n);
 *       if ("then" in o) throw new TypeError("Async config validation is not supported");
 *       if (o.issues) throw new kc(o.issues);
 *       return o.value;
 *     }
 *
 * and an `issues` on a composed entry propagates up as a load failure. So the
 * contract here is: `issues` is falsy, and the result is not a promise, for
 * every entry config shape this plugin is realistically installed with.
 *
 * The browser half is checked by reading it, not importing it: it is a plain
 * script that registers itself on `window`, so parsing it is the load check and
 * `client.test.mjs` is what actually runs it.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

/**
 * The loader's `jc()` reproduced verbatim, minus the framework error type.
 * Returns the composed value, or throws exactly as the loader would.
 */
function loaderCompose(manifest, entryConfig) {
  if (!manifest.Config) return entryConfig;
  const o = manifest.Config['~standard'].validate(entryConfig);
  if ('then' in o) {
    throw new TypeError('Async config validation is not supported');
  }
  if (o.issues) {
    throw new TypeError(`config issues: ${JSON.stringify(o.issues)}`);
  }
  return o.value;
}

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const mod = await import('../lib/index.js');
const clientSource = readFileSync(resolve(pkgRoot, 'client.js'), 'utf8');
const patchSource = readFileSync(resolve(pkgRoot, 'cordis.patch.yml'), 'utf8');

// ---------------------------------------------------------------------------
// Host module
// ---------------------------------------------------------------------------

test('the module graph loads from this package at all', () => {
  assert.equal(typeof mod, 'object');
  assert.notEqual(mod, null);
});

test('the loader finds every export it reads', () => {
  assert.equal(typeof mod.name, 'string');
  assert.equal(mod.name, 'auto-retry');
  assert.deepEqual(mod.inject, ['agents', 'sessionProjections']);
  // A schemastery schema is callable, and the loader reads the standard-schema
  // adapter off it as a property.
  assert.equal(typeof mod.Config, 'function');
  assert.equal(typeof mod.Config['~standard'], 'object');
  assert.equal(typeof mod.apply, 'function');
});

test('the host module exports no client half of its own', () => {
  // The browser artifact is declared in `package.json` and resolved through the
  // `./client` export; the host module stays a plain host plugin.
  assert.equal(mod.dsh, void 0);
  assert.equal(mod.client, void 0);
});

test('Config is a standard-schema, and validation is synchronous', () => {
  const schema = mod.Config['~standard'];
  assert.equal(typeof schema, 'object');
  assert.equal(typeof schema.validate, 'function');
  const result = schema.validate(undefined);
  assert.equal('then' in result, false, 'the loader rejects a promise here');
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
});

test('the loader composes an entry that omits config entirely', () => {
  const value = loaderCompose(mod, undefined);
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
});

test('the loader composes an entry with an empty config', () => {
  assert.equal(typeof loaderCompose(mod, {}), 'object');
});

test('the loader composes the config this patch row actually ships', () => {
  // Mirrors cordis.patch.yml, key for key.
  const value = loaderCompose(mod, {
    enabled: true,
    extraRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
    retryableCodes: [
      'EMPTY_RESPONSE',
      'RATE_LIMIT',
      'SERVER',
      'TIMEOUT',
      'TRANSPORT',
      'PROVIDER_ERROR',
      'PI_AI_ERROR',
    ],
  });
  assert.equal(typeof value, 'object');
});

test('LIMITS and the schema bounds are one and the same', () => {
  const limits = mod.LIMITS;
  assert.equal(limits.extraRetries.min, 0);
  assert.equal(limits.extraRetries.max, 10);
  assert.equal(limits.initialDelayMs.min, 0);
  assert.equal(limits.initialDelayMs.max, 600_000);
  assert.equal(limits.maxDelayMs.max, 600_000);
  assert.equal(limits.jitterRatio.min, 0);
  assert.equal(limits.jitterRatio.max, 1);
  // Frozen, so a caller cannot widen a range out from under the clampers.
  assert.equal(Object.isFrozen(limits), true);
  assert.equal(Object.isFrozen(limits.extraRetries), true);
});

test('readSettings refuses to hand a safety gate a nonsense value', () => {
  // A negative budget is the dangerous one: it must come back as the default,
  // never as a negative, and never as 0 — 0 is the power to switch the plugin
  // off, which a mistyped negative must not have.
  assert.equal(
    mod.readSettings({ extraRetries: -1 }).extraRetries,
    mod.DEFAULTS.extraRetries,
  );
  assert.equal(
    mod.readSettings({ initialDelayMs: -50 }).initialDelayMs,
    mod.DEFAULTS.initialDelayMs,
  );

  // Out of range on the high side, and a non-integer, both fall back.
  assert.equal(mod.readSettings({ extraRetries: 99 }).extraRetries, mod.DEFAULTS.extraRetries);
  assert.equal(mod.readSettings({ extraRetries: 2.5 }).extraRetries, mod.DEFAULTS.extraRetries);
  assert.equal(mod.readSettings({ jitterRatio: 7 }).jitterRatio, mod.DEFAULTS.jitterRatio);

  // The wrong type entirely.
  assert.equal(mod.readSettings({ extraRetries: 'lots' }).extraRetries, mod.DEFAULTS.extraRetries);
  assert.equal(mod.readSettings({ enabled: 'nope' }).enabled, mod.DEFAULTS.enabled);
  assert.deepEqual(mod.readSettings({ retryableCodes: [] }).retryableCodes, mod.DEFAULTS.retryableCodes);

  // Zero is a deliberate opt-out, not a mistake: it stays zero.
  assert.equal(mod.readSettings({ extraRetries: 0 }).extraRetries, 0);
  assert.equal(mod.readSettings({ initialDelayMs: 0 }).initialDelayMs, 0);
});

test('the default allowlist is the one the policy exports', () => {
  assert.deepEqual(mod.DEFAULTS.retryableCodes, mod.DEFAULT_RETRYABLE_CODES);
  assert.equal(mod.NEVER_RETRY_CODES.has('AUTH'), true);
  assert.equal(mod.NEVER_RETRY_CODES.has('CONTEXT_WINDOW_EXCEEDED'), true);
  assert.equal(mod.NEVER_RETRY_CODES.has('ABORTED'), true);
  // Opt-in only, never hard-denied.
  assert.equal(mod.NEVER_RETRY_CODES.has('QUOTA'), false);
  assert.equal(mod.DEFAULT_RETRYABLE_CODES.includes('QUOTA'), false);
});

test('the browser half refuses the empty allowlist the Host reads as a typo', () => {
  // Two halves of one rule, so they cannot drift apart. `codesWithin()` turns an
  // empty list back into the defaults — otherwise a mistyped configuration would
  // switch the plugin off while the settings page still showed it on. If the page
  // ever started saving one, the page would say "no codes" while seven were still
  // taken over.
  assert.deepEqual(mod.readSettings({ retryableCodes: [] }).retryableCodes, mod.DEFAULT_RETRYABLE_CODES);
  assert.match(clientSource, /invalid\.push\('retryableCodes'\)/u);
});

// ---------------------------------------------------------------------------
// Browser half
// ---------------------------------------------------------------------------

test('the client artifact parses as a plain script', () => {
  // It registers itself on `window` rather than exporting, so parsing is the
  // load check; `client.test.mjs` is what actually runs it.
  assert.doesNotThrow(() => new Function(clientSource));
});

test('the client artifact registers under the package id', () => {
  assert.match(clientSource, /__ModuleLoader__\.load\(/);
  assert.match(clientSource, /id:\s*'dsh-plugin-auto-retry'/);
});

test('the browser half declares the Conversation slot it renders into', () => {
  assert.match(clientSource, /'conversation\.chat\.turnTail'/);
});

test('the browser half claims the bundle config seat the Plugins page dispatches', () => {
  // Without this the Plugins page shows the bundle with no configure control at
  // all: a Host `Config` schema is not enough on its own. The bundle-level seat
  // is keyed by the package name and lives on the bundle's own page, one click
  // closer than the row-level seat, which would need the row opened first.
  assert.match(clientSource, /'plugins\.bundle\.config'/);
  assert.doesNotMatch(clientSource, /'plugins\.row\.config'/);
  // The key is the bundle's package name: the page looks the seat up by
  // `pkg.name`, so anything else renders the section nowhere.
  assert.match(clientSource, /const BUNDLE_CONFIG_KEY = PKG/u);
  assert.match(clientSource, /const PKG = 'dsh-plugin-auto-retry'/u);
});

test('the browser half builds its form from the namespace the patch declares', () => {
  // The bundle seat is rendered with `{ view: 'page' }` and nothing else: unlike
  // the row seat it is never handed a form, so the browser half sources one from
  // `configForms` under the namespace the Host serves — the patch row's id. A
  // drift between the two shows up as a permanently empty page and nothing else,
  // which is exactly the kind of mismatch only a cross-file check catches.
  const declared = /const CONFIG_NAMESPACE = '([^']+)'/u.exec(clientSource);
  assert.notEqual(declared, null, 'client.js must name the namespace it reads');
  const rowId = /-\s*id:\s*([A-Za-z0-9_-]+)/u.exec(patchSource);
  assert.notEqual(rowId, null, 'cordis.patch.yml must declare a row id');
  assert.equal(declared[1], rowId[1]);
  assert.match(clientSource, /configForms/);
});

test('the settings service is reached without becoming a load-blocking dependency', () => {
  // `configForms` belongs to the settings package, which is not what makes the
  // retry panel work. Declaring it in the module's own `inject` would stall the
  // whole browser half in a deployment that left settings out, so the
  // configuration page asks for it through its own fiber instead.
  assert.doesNotMatch(clientSource, /inject:\s*\[[^\]]*'configForms'/u);
  assert.match(clientSource, /ctx\.inject\(\['configForms'\]/u);
});

test('the browser half is registered as a web client of the conversation UI', () => {
  assert.equal(typeof pkg.dsh.client, 'object');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.equal(Array.isArray(pkg.dsh.client.inject), true);
  assert.equal(typeof pkg.exports['./client'], 'string');
  assert.equal(existsSync(resolve(pkgRoot, pkg.exports['./client'])), true);
});

test('the manifest exposes ./package.json, which the loader reads', () => {
  // A package that declares `exports` without this subpath is unreadable as a
  // manifest: `require.resolve(name + '/package.json')` throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED, and the loader never learns about
  // `dsh.bundle.patch` or `dsh.client`. Every shipped package that declares
  // `exports` also declares this one.
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(existsSync(resolve(pkgRoot, 'package.json')), true);
});

test('the client manifest names the package behind every service the browser half reads', () => {
  // `dsh.client.inject` is load/prefetch metadata, not apply sequencing: the
  // shipped packages say these edges are "informational ... never apply
  // sequencing". What it does is tell the loader which packages this one belongs
  // with, so every service read in the client body should have its owner named
  // here — a missing owner means the package can load before its dependency is
  // even fetched.
  const declared = new Set(pkg.dsh.client.inject);
  for (const owner of [
    '@deepseek-ai/dsh-api-session-controller', // provides the client `sessions` service
    '@deepseek-ai/dsh-client-locale', // provides `locale`
    '@deepseek-ai/dsh-client-ui-conversation', // provides `uiConversation`
    '@deepseek-ai/dsh-client-ui-plugin-manager', // declares the `plugins.bundle.config` seat
    '@deepseek-ai/dsh-client-ui-renderer', // provides `slots`
    '@deepseek-ai/dsh-client-ui-settings', // provides `configForms`, the bundle form source
  ]) {
    assert.equal(declared.has(owner), true, `${owner} missing from dsh.client.inject`);
  }

  // And the services the client body actually asks for must be covered above.
  assert.match(clientSource, /inject:\s*\[[^\]]*'slots'[^\]]*\]/);
  assert.match(clientSource, /inject:\s*\[[^\]]*'sessions'[^\]]*\]/);
  assert.match(clientSource, /inject:\s*\[[^\]]*'locale'[^\]]*\]/);
  assert.match(clientSource, /inject:\s*\[[^\]]*'uiConversation'[^\]]*\]/);
});

// ---------------------------------------------------------------------------
// Package manifest
// ---------------------------------------------------------------------------

test('the package manifest points at files that exist', () => {
  assert.equal(typeof pkg.main, 'string');
  assert.equal(existsSync(resolve(pkgRoot, pkg.main)), true);
  assert.equal(pkg.main, 'lib/index.js');

  assert.equal(typeof pkg.dsh, 'object');
  assert.equal(typeof pkg.dsh.bundle.patch, 'string');
  assert.equal(existsSync(resolve(pkgRoot, pkg.dsh.bundle.patch)), true);

  for (const file of pkg.files ?? []) {
    assert.equal(existsSync(resolve(pkgRoot, file)), true, `package.json lists a missing ${file}`);
  }
});

test('the test commands stay inside the Node version the manifest requires', () => {
  // `npm test` is what CI runs and what `prepublishOnly` gates a release on, so it
  // may not use a flag newer than `engines.node`. `--test-isolation` arrived in
  // Node 24 while this package declares >=22, and shipping it in the default
  // command is how a green local run turns into a red CI run on the floor it
  // claims to support.
  assert.equal(pkg.scripts.test, 'node --test "test/**/*.test.mjs"');
  assert.equal(pkg.scripts.test.includes('--test-isolation'), false);
  assert.equal(pkg.scripts.prepublishOnly, 'npm test');

  // The in-process variant is the escape hatch for a sandbox that forbids the
  // child processes the default isolation needs; it is allowed to be newer.
  assert.equal(pkg.scripts['test:in-process'], 'node --test --test-isolation=none "test/**/*.test.mjs"');
});

test('the bundle patch inserts the row the manifest names', () => {
  assert.match(patchSource, /id:\s*auto-retry/);
  assert.match(patchSource, /name:\s*'dsh-plugin-auto-retry'/);
  // The row must carry the codes the policy defaults to, or an install would
  // silently run with a different allowlist than the tests describe.
  for (const code of mod.DEFAULT_RETRYABLE_CODES) {
    assert.equal(patchSource.includes(code), true, `${code} missing from cordis.patch.yml`);
  }
});

test('every dependency named in package.json resolves and actually reads', () => {
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const target = resolve(pkgRoot, 'node_modules', ...dep.split('/'));
    // statSync alone is not enough: a broken reparse point stats fine with
    // size 0 while readdir and readFileSync both fail with ENOENT. Reading the
    // file is what the loader actually does, so that is what gets checked.
    const raw = readFileSync(resolve(target, 'package.json'), 'utf8');
    assert.equal(raw.length > 0, true, `${dep}/package.json is empty`);
    const depPkg = JSON.parse(raw);
    assert.equal(typeof depPkg.name, 'string', `${dep} has no name`);
    assert.equal(depPkg.name, dep, `${dep} resolves to ${depPkg.name}`);
  }
});

test('the import and validate cycle is stable across repeated runs', async () => {
  // Guards against a transient filesystem read returning nothing. The whole
  // package graph is re-read on each iteration, which is what actually happens
  // when the host imports this plugin at startup.
  for (let i = 0; i < 25; i += 1) {
    const fresh = await import(`../lib/index.js?load=${i}`);
    const value = loaderCompose(fresh, undefined);
    assert.equal(typeof value, 'object', `iteration ${i}`);
  }
});

test('apply() returns without throwing on a minimal context', () => {
  const ctx = {
    on: () => () => {},
    effect: () => {},
    sessionProjections: { stateOf: () => undefined },
    logger: { info() {}, warn() {}, error() {} },
  };
  assert.doesNotThrow(() => mod.apply(ctx, undefined));
});
