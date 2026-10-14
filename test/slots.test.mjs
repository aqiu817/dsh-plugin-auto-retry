/**
 * Contract test against the real slot registry.
 *
 * `client.test.mjs` proves *what* this plugin registers; this proves the registry
 * *accepts* it. Those are different questions. A registration is validated before
 * it is seated — a keyed slot requires `key`, a second entry for the same key is
 * refused, and a child slot has to be declared by a parent entry's `children`
 * table — and the entry the registry builds is what the renderer later reads:
 * `component`, `options.key`, `locale`, and `inject`. A shape that passes a hand
 * written mock and fails here would show up to the reader as a bundle page with no
 * configuration area at all, which is a slow thing to debug in a browser.
 *
 * The registry ships inside the desktop application rather than as a dependency of
 * this package, so this file locates the installed archive and skips when it is
 * absent. Point `DSH_APP_ASAR` at a different archive to check another install.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the desktop application keeps its archive, if it is installed. */
function findArchive() {
  const candidates = [
    process.env.DSH_APP_ASAR,
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  ].filter((candidate) => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Read one file out of an asar archive.
 *
 * The format opens with a pickle pair: `uint32@0` is the pickle's own size (4),
 * `uint32@4` is the header string's length including its padding, and `uint32@12`
 * is the JSON's exact length. So the JSON runs from byte 16 up to `8 + uint32@4`,
 * and that same offset is where the file bodies begin.
 */
function readFromArchive(archive, path) {
  const bytes = readFileSync(archive);
  const dataOffset = 8 + bytes.readUInt32LE(4);
  const index = JSON.parse(bytes.subarray(16, dataOffset).toString('utf8'));
  let node = index;
  for (const part of path.split('/')) {
    node = node.files?.[part];
    if (node === undefined) throw new Error(`${path} is not in ${archive}`);
  }
  const start = dataOffset + Number(node.offset);
  return bytes.subarray(start, start + node.size).toString('utf8');
}

const archive = findArchive();
const SLOTS = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js';

/** The shipped registry, imported from a temporary copy of the archive's file. */
async function loadSlotCore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slots-'));
  const file = join(dir, 'index.mjs');
  writeFileSync(file, readFromArchive(archive, SLOTS));
  try {
    const mod = await import(pathToFileURL(file).href);
    return { SlotCore: mod.SlotCore, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test('the bundle config registration is accepted by the shipped slot registry', async (t) => {
  if (archive === undefined) {
    t.skip('no desktop app archive found; set DSH_APP_ASAR to check an install');
    return;
  }

  const { SlotCore, cleanup } = await loadSlotCore();
  try {
    const core = new SlotCore();
    // The Plugins page declares the seat as a child of its own entry. Nothing in
    // this plugin can declare it — and if nothing does, the registration below
    // fails loudly rather than silently rendering nowhere.
    core.register({
      name: 'root',
      children: { 'plugins.bundle.config': { kind: 'keyed', scope: 'root' } },
    }, function PluginManagerPage() { return null; });

    const form = { getSnapshot: () => ({ status: 'ready', value: {} }), subscribe: () => () => {} };
    const dispose = core.register({
      name: 'plugins.bundle.config',
      key: 'dsh-plugin-auto-retry',
      locale: 'auto-retry',
      inject: () => ({ form }),
    }, function RetryConfigPanel() { return null; });

    const entries = core.entriesOfSlot('plugins.bundle.config');
    assert.equal(entries.length, 1);
    // The renderer finds the entry by `options.key` matching the bundle name it
    // is drawing, so this is the field that decides whether the page appears.
    assert.equal(entries[0].options.key, 'dsh-plugin-auto-retry');
    // `locale` is what gives the component its translator; `inject` is what gives
    // it a form. Both are read off the entry, not off the options bag.
    assert.equal(entries[0].locale, 'auto-retry');
    assert.equal(typeof entries[0].inject, 'function');
    assert.equal(entries[0].inject().form, form);
    assert.equal(typeof entries[0].component, 'function');

    dispose();
    assert.equal(core.entriesOfSlot('plugins.bundle.config').length, 0, 'the registration must be disposable');
  } finally {
    cleanup();
  }
});

test('the shipped registry refuses a second entry under the same key', async (t) => {
  if (archive === undefined) {
    t.skip('no desktop app archive found; set DSH_APP_ASAR to check an install');
    return;
  }

  const { SlotCore, cleanup } = await loadSlotCore();
  try {
    const core = new SlotCore();
    core.register({
      name: 'root',
      children: { 'plugins.bundle.config': { kind: 'keyed', scope: 'root' } },
    }, function PluginManagerPage() { return null; });

    const register = () => core.register({
      name: 'plugins.bundle.config',
      key: 'dsh-plugin-auto-retry',
      locale: 'auto-retry',
      inject: () => ({}),
    }, function RetryConfigPanel() { return null; });

    // This is why the key has to be the package name and nothing else: two
    // installations of the same plugin under one page would collide here, at load.
    register();
    assert.throws(register, /already has an entry for key/);
  } finally {
    cleanup();
  }
});
