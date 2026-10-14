# dsh-plugin-auto-retry

**The failures the harness's own retry executor hands back, we pick up.**

[简体中文](./README.md) | **English**

A host-side DeepSeek Harness plugin. It attaches downstream of the shipped
`@deepseek-ai/dsh-llm-retry` and takes over exactly the model-request failures
that executor *declines*, continuing its backoff curve for a few more attempts.
It also adds a collapsed panel at the Turn tail that gives back the full failure
detail the native transcript discards or replaces.

No injected fake user message, and no official plugin is replaced or modified.

---

## Contents

- [What it solves](#what-it-solves)
- [How it relates to the shipped executor](#how-it-relates-to-the-shipped-executor)
- [What is never retried today](#what-is-never-retried-today)
- [Install](#install)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Why it cannot conflict](#why-it-cannot-conflict)
- [The browser half](#the-browser-half)
- [Safety](#safety)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## What it solves

dsh ships a retry executor. `@deepseek-ai/dsh-base` mounts it:

```yaml
- id: llm-retry
  name: '@deepseek-ai/dsh-llm-retry'
```

It works the `agent/request-error` waterfall, rerunning a failed model request
according to the provider route's `retryPolicy`. **But it only works through a
narrow gate:**

- only a fixed set of failure codes,
- a bounded budget (five attempts in the default `normal` mode),
- a set of defaults when an adapter declares no policy.

So a large class of failures is never retried at all. This plugin covers that
class.

It does not replace the executor. It attaches downstream of it — official calls
`next()` **whenever it declines**, and a waterfall runs outermost-first in
registration order while `dsh-base` loads before any profile bundle. Official is
therefore always outermost and this plugin always downstream, so **every failure
official hands back arrives here, and nothing it already handled ever does.**

## How it relates to the shipped executor

```
model request fails
   │
   ├─ dsh-llm-retry (outermost, mounted by dsh-base)
   │     ├─ retryable and budget left → backoff() → { kind: 'retry' }   ← we never see it
   │     └─ otherwise → next()  ─────────────────────────────────┐
   │                                                              │
   └─ auto-retry (downstream, this plugin) ←──────────────────────┘
         ├─ hard-denied code   → leave it terminal
         ├─ not allowlisted    → leave it terminal
         ├─ budget exhausted   → leave it terminal
         └─ otherwise: record durably → cancellable wait → mark started → { kind: 'retry' }
```

The shipped default `normal` policy (`dsh-llm/lib/types/retry-policy.js`):

```
retryableCodes: EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT
maxRetries:     5
backoff:        500ms → 10000ms, jitter 0.1
```

## What is never retried today

| # | Gap | Why official skips it | This plugin |
|---|---|---|---|
| G1 | code not in `retryableCodes` | explicit set membership | ✅ takes over |
| G2 | budget exhausted | bounded budget | ✅ takes over |
| G3 | `retryPolicy === undefined` (failure before adapter resolution) | no policy | ✅ (allowlist only) |
| G4 | `UNKNOWN` — non-`HarnessError` through the adapter boundary | not in the set | ⚠️ opt-in |
| G5 | tool / middleware / extension failures | never reaches `agent/request-error` | ❌ out of scope |
| G6 | direct `ctx.llm.stream()` consumers | no agent turn | ❌ out of scope |
| G7 | `aborted` | user cancellation | ❌ **never** |
| G8 | `CONTEXT_WINDOW_EXCEEDED` / `IMAGE_OFFLOAD_REQUIRED` | owned by compaction / image offload | ❌ **never** |

Concretely, on the adapters in this profile:

| Adapter | Codes it produces that are never retried |
|---|---|
| `@deepseek-ai/dsh-llm-pi-ai` | `PI_AI_ERROR` (its catch-all), `QUOTA`, `INVALID_REQUEST`, `AUTH`, `UNKNOWN` |
| `@deepseek-ai/dsh-plugin-kilo-gateway` | `PROVIDER_ERROR`, `INVALID_MODEL`, `INVALID_REQUEST`, `QUOTA`, `AUTH` |

Two comments already in the tree say the same thing:

- `dsh-plugin-kilo-gateway/lib/index.js:229`: "Classifying everything as one
  code (as this adapter used to) **silently disabled retrying entirely**, because
  the default retryable set does not contain that code."
- `dsh-llm-agentrouter/lib/index.js:144`: "`INVALID_REQUEST` is absent from the
  harness's default retryable set, so without this a 400 ends the turn."

## Install

A standard dsh bundle. The sanctioned path is `plugin_manager` with
`install_bundle`, which writes the profile dependency and patch for you:

```
plugin_manager(action: "install_bundle", target: "dsh-plugin-auto-retry")
```

Manually, add the dependency and the `bundles` row to the profile's
`package.json` (`~/.dsh/profiles/<name>/package.json`):

```jsonc
{
  "dependencies": {
    "dsh-plugin-auto-retry": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-auto-retry"
      ]
    }
  }
}
```

While working on the sources, point the version at the checkout instead, so no
`npm install` is needed after each edit:

```jsonc
"dsh-plugin-auto-retry": "link:/absolute/path/to/dsh-plugin-auto-retry"
```

`cordis.patch.yml` is attached through `dsh.bundle.patch` automatically; the
`- insert:` row does not need to be written by hand.

Run `npm test` once after installing: `contract.test.mjs` checks that every file
`package.json` lists, and every dependency directory, is really readable, and
re-imports the graph 25 times.

> This is **not** a `required` bundle, so a composition failure writes nothing to
> the startup log. Confirm `auto-retry` appears on the Plugins page.

## Configuration

All six fields are `.volatile()`, so editing them on the Plugins page does not
reload the fiber — and `enabled: false` stops a running chain mid-flight.

**Where to edit:** Sidebar → **Plugins** → the `dsh-plugin-auto-retry` bundle →
open it, and the form is on that page. It is contributed by this plugin's browser
half through the `plugins.bundle.config` seat, keyed by the package name.

> This is easy to miss: **a Host `Config` schema alone puts no control on the
> Plugins page.** A configuration area appears only while a plugin claims a seat —
> bundle-level `plugins.bundle.config` (key = package name) or row-level
> `plugins.row.config` (key = `<package name>#<row id>`, which needs another click
> into that row). This plugin claims the bundle-level seat: it declares exactly one
> row, so the two would carry identical content, and the bundle seat is one click
> shallower. A host-only plugin (for example `dsh-plugin-continue-on-limit`)
> therefore shows no configuration there — its `Config` still applies, it simply
> has no editor.
>
> The bundle-level seat does **not** hand over a form object (the row-level one
> does), so the browser half sources one from the `configForms` service for
> namespace `auto-retry`. That service belongs to the settings package, so it is
> not declared in the browser half's `inject`; this half asks for it through its
> own fiber instead, so a deployment that left settings out loses the
> configuration page and nothing else — the retry panel keeps working.
>
> The namespace `auto-retry` has to match the row id in `cordis.patch.yml`; a
> drift leaves the page permanently empty (a contract test cross-checks the two).

Edits stay staged until Save, which submits only the fields that changed, all
under one revision fence, so a concurrent write is refused rather than silently
overwritten. Leaving the page discards staged edits. A numeric field that is out
of bounds or unparseable blocks the save and names the field rather than writing
a value the Host would reject.

| Field | Type | Default | Bounds | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | `true` | — | master switch |
| `extraRetries` | integer | `3` | 0–10 | attempts **on top of** official's budget; `0` keeps it inert |
| `initialDelayMs` | integer | `1000` | 0–600000 | first delay when official never tried |
| `maxDelayMs` | integer | `60000` | 0–600000 | outer ceiling, also clamps a provider delay |
| `jitterRatio` | number | `0.2` | 0–1 | symmetric jitter |
| `retryableCodes` | string[] | see below | at least 1 | codes we are willing to take over |

`retryableCodes` is edited as **switches**, not typed: nothing exposes the
universe of codes an adapter may return, so the page ships a catalog in three
groups.

| Group | Rendered as | Codes |
|---|---|---|
| **On by default** | switches | `EMPTY_RESPONSE` `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` `PROVIDER_ERROR` `PI_AI_ERROR` |
| **Opt in** | switches | `QUOTA` `ACCOUNT_QUOTA` `INVALID_REQUEST` `UNKNOWN` |
| **Never retried** | switches, **disabled** | `AUTH` `MISSING_CREDENTIAL` `INVALID_CREDENTIAL` `NO_ADAPTER` `INVALID_MODEL` `INVALID_CONFIG` `CONTEXT_WINDOW_EXCEEDED` `IMAGE_OFFLOAD_REQUIRED` `ABORTED` |

The third group is still listed, with its switches disabled: that is how the page
says both which codes exist and that these cannot be turned on — the hard floor is
a policy constant, not a preference. Switch state is seeded from the **accepted**
value rather than from the catalog default, and a code outside the catalog (one an
adapter invented) lives in the "other codes" textarea, one per line.

**Leaving no code at all is not allowed.** The page says so while the change is
being staged and refuses the save, because of what the Host does: `codesWithin()`
reads an empty list as a **typo** and falls back to the default allowlist —
otherwise a mistyped configuration would quietly switch the plugin off while the
settings page still showed it on. Saving one would leave the page saying "no codes"
while seven were still taken over. Pick a code, or use `enabled: false` /
`extraRetries: 0` to mean "take over nothing" — those two are unambiguous and
cannot disagree with the page.

> Hand-editing `cordis.patch.yml` to `retryableCodes: []` falls back the same way.
> A configuration the page can express should not take effect outside it.

Default allowlist:

```
EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT,   ← official's own five (taking over = extending)
PROVIDER_ERROR, PI_AI_ERROR                                ← the two adapter catch-alls
```

**Hard floor** (code constants, not configurable, evaluated before the allowlist):

```
AUTH, MISSING_CREDENTIAL, INVALID_CREDENTIAL, NO_ADAPTER,
INVALID_MODEL, INVALID_CONFIG,
CONTEXT_WINDOW_EXCEEDED, IMAGE_OFFLOAD_REQUIRED, ABORTED
```

The hard floor wins over the allowlist: a typo must not be able to authorize a
retry of an authentication failure or a context overflow.

`QUOTA`, `ACCOUNT_QUOTA`, `INVALID_REQUEST`, and `UNKNOWN` are neither defaulted
nor denied — each is as likely to be permanent as transient, so the deployment
decides by adding it to `retryableCodes`. That keeps the harness's own rule
(rout on code, never parse message) while leaving room for the relay quota pools
and channel-dialect 400s that are real in practice.

## How it works

### 1. The attachment point

```js
ctx.on('agent/request-error', async (payload, next) => {
  const terminal = await next();                    // downstream/terminal speaks first
  if (terminal !== void 0) return terminal;
  if (lifetime.signal.aborted || payload.signal.aborted) return terminal;
  // …eligibility → counting → durable record → cancellable wait → { kind: 'retry' }
});
```

Official does **not** call `next()` when it retries, so a failure it handled is
physically unreachable here — **double-retrying is impossible by construction**.

The failure happens *inside the still-open step*, before any tool result is
synthesized. That keeps the request reconstructible from the session log, avoids
re-running side-effectful tools whose outcome the loop deliberately left unknown,
honours the same `signal`, injects no fake user message, and never appends from
inside a `session/event` callback.

### 2. Backoff continues the official curve

Read official's progress for this step and provider from the shared projection,
then:

```js
if (official <= 0) return localDelay(ourRetry, settings, random);   // official never tried → 1s
const curve = {                                                     // official tried → continue
  initialDelayMs: officialPolicy.initialDelayMs,
  maxDelayMs: Math.min(officialPolicy.maxDelayMs, settings.maxDelayMs),
  jitterRatio: officialPolicy.jitterRatio,
};
return localDelay(official + ourRetry, curve, random);              // one step past its longest
```

| Case | Official attempts | Our 1st / 2nd / 3rd delay |
|---|---|---|
| `PI_AI_ERROR` (official never touches it) | 0 | 1s / 2s / 4s |
| `RATE_LIMIT`, budget exhausted | 5 (base 500, cap 10000) | 10s / 10s / 10s (saturated) |

Restarting at one second would hammer a provider that had just asked us to slow
down, which is why the curve is continued rather than restarted.

A valid `providerRetryAfterMs` wins, clamped to `maxDelayMs`.

> **One deliberate divergence:** official's `normal` mode gives up entirely when
> `providerRetryAfterMs > maxDelayMs`. This plugin clamps instead and keeps the
> attempt — the provider was telling us when to come back, not to stop.

### 3. Counting reuses the official projection

```js
const key = policyKey(settings);                                    // '["auto-retry",…]'
const entry = state?.[JSON.stringify([provider, key])];
const ourRetry = (entry?.retry ?? 0) + 1;
const retryId = entry?.retryId ?? randomUUID();
```

Official's projection resets on `step/start` and `turn/end` — exactly the
per-step scope this needs — and folds from the log, so it survives a restart.

### 4. Durable before the wait

`llm/retry` is appended before sleeping and `llm/retry-started` before answering,
reusing the official vocabulary so the shipped projection (and the invariant
companion, when mounted) understands them. A rejected append abandons the retry
rather than proceeding without a record.

## Why it cannot conflict

| # | Guarantee | Basis |
|---|---|---|
| 1 | **Different granularity** | official never calls `next()` when it retries |
| 2 | **Namespaced policy key** — ours is `JSON.stringify(['auto-retry', …])`, official's is `JSON.stringify([mode, …])` | first element differs, so the shared projection keeps two separate chains |
| 3 | **Extend, never replace** | one extra listener; no official config is read or written |
| 4 | **Separate budget** | counted under our own key |
| 5 | **Same cancellation semantics** | `AbortSignal.any([payload.signal, lifetime.signal])` |
| 6 | **Durable before wait** | known event types |
| 7 | **Satisfies every invariant rule** | `retry` positive and `≤ maxRetries`, inside an open turn and step, provider match, `retryId` continuity |
| 8 | **`always` mode is unaffected** | official asks downstream first via `settleDownstream` |
| 9 | **Transcript untouched** | no `followup()`; zero overlap with `dsh-plugin-continue-on-limit` |
| 10 | **Cancellation is never retried** | `ABORTED` is in the hard floor |

## The browser half

The native transcript **already** renders `llm/retry` as a collapsed `<details>`
(`ModelRetryItem`), so our retries appear automatically.

What the native surfaces lose is the content:

| Surface | Today |
|---|---|
| `failureMessage()` in `dsh-client-ui-chat` | for `AUTH`, `QUOTA`, `ACCOUNT_QUOTA`, and the account codes it **replaces the raw text with a short localized phrase** |
| `TurnErrorItem` | renders inline and **cannot be collapsed**, so a long `errorChain` takes over |
| both | expose no `status`, `requestId`, provider route, turn/step, or wait time |

This plugin adds a collapsed panel at the Turn tail
(`conversation.chat.turnTail`), rendered only for a Turn that retried or failed:

- one-line summary: `Retried 3 time(s) this turn · finally failed with RATE_LIMIT`
- on expansion, every attempt with its origin (plugin / harness), `attempt N/M`,
  code, HTTP status, provider, turn·step, wait, request id, and the **raw message
  verbatim**

Styles use theme tokens only and are removed with the fiber.

### The configuration page

The same browser half claims `plugins.bundle.config` (key
`dsh-plugin-auto-retry`), the configuration area on the bundle's page: four numeric
inputs, one master switch, and one group of code switches. It carries no validation logic of its own —
the bounds only keep the inputs honest; `readSettings()` and the schema remain the
authority. Save submits only the fields that changed, all under the revision the
Host reported, so a concurrent write is refused rather than silently overwritten.

The switches are order-insensitive: they always submit in catalog order, so
reordering alone is not an edit. A hard-floor code that is already in the
configuration renders checked and disabled — the page reports the configuration
rather than quietly rewriting it, since a list the reader never touched must not
produce a write.

The bundle-level seat is resident: while the bundle is present the area is there,
whether or not the Host actually serves the `auto-retry` namespace. So the page
distinguishes three states — reading (`loading`), unwritable (`unavailable`: the
deployment does not serve the namespace, or this page is read-only), and ready —
and the first two only state the fact rather than drawing a form, because an input
whose Save could only fail is worse than a sentence.

## Safety

Three gates: `extraRetries` (the budget on top of official's), the continuing
backoff, and `enabled` (which stops a running chain immediately).

Every setting is type-checked and clamped on read, because a `.volatile()` field
is written straight into its reference cell and never re-validated. Negative
numbers fall back to the default rather than to `0` — `0` is the power to switch
a gate off, and a mistyped negative must not have it.

`Array.isArray` in the allowlist check is load-bearing, not noise: a bare string
reaches `String.prototype.includes`, where any substring matches and an allowlist
typo would silently authorize codes nobody listed.

## Tests

```bash
npm test
```

Five layers: pure policy, host wiring, browser fold and field map, the load
contract (the loader's own `jc()` reproduced, plus every manifest path checked),
and one registration against the **real** `SlotCore` shipped in the application —
which asserts the registry accepts this plugin's options and builds the entry
shape the renderer reads. That last file reads `app.asar` from the install
directory, so it skips elsewhere (`DSH_APP_ASAR` points it at another install).

> "A mock accepts it" and "the registry accepts it" are different questions: a
> shape that only the mock accepts surfaces in a browser as a configuration area
> that never appears at all.

> `npm test` is `node --test "test/**/*.test.mjs"` — the same command CI and
> `prepublishOnly` run. `--test-isolation=none` (`npm run test:in-process`) is an
> escape hatch for a **sandbox that forbids child processes**: `node --test` spawns
> one per test file by default, which the DSH file sandbox does not allow. That
> flag needs Node 24+, so it is not the default — a package declaring
> `engines: >=22` would otherwise die with `bad option` on the version it claims
> to support.

## Known limitations

- **Text an adapter already truncated cannot be recovered.** `kilo-gateway` does
  `detail.slice(0, 300)`. The panel guarantees everything the *host* recorded is
  shown in full — not that the provider's original response is.
- **Tool, middleware, and extension failures are out of scope.** They never reach
  `agent/request-error`, and the harness deliberately does not auto-retry
  operations whose outcome is unknown; by then `TOOL_OUTCOME_UNKNOWN` results
  exist, so a turn-level retry risks repeating side effects.
- **Direct `ctx.llm.stream()` consumers are out of scope** — no agent turn means
  no boundary to attach to.
- **Subagents are not distinguished.** Agent-scoped dispatch covers every agent,
  matching official behaviour.
- **`QUOTA`, `INVALID_REQUEST`, and `UNKNOWN` are off by default.** They need a
  deployment's explicit opt-in.

## Troubleshooting

**Nothing happens after installing.** Not a `required` bundle, so nothing is
logged on a composition failure. Check the Plugins page for `auto-retry`, then
look for `auto-retry:` lines in `ctx.logger`.

**It failed but was not retried.** Check `enabled`; whether `extraRetries` is
spent (a warn is logged); whether the code is allowlisted (`UNKNOWN`, `QUOTA`,
and `INVALID_REQUEST` are not by default); and whether it is `AUTH`,
`CONTEXT_WINDOW_EXCEEDED`, or `ABORTED`, which are never retried.

**Official retried, but the plugin did nothing.** That is correct — official does
not call `next()` when it retries, which is exactly how the two avoid conflict.

**The panel does not appear.** It renders only for a Turn that retried or failed.
Also confirm the browser half is registered: `dsh.client.platform` is `web` and
`@deepseek-ai/dsh-client-ui-conversation` is installed.

## Development

```bash
npm install --ignore-scripts
npm test
```

```text
lib/policy.js    pure decisions, zero framework imports
lib/index.js     host half: waterfall listener, durable events, wait
client.js        browser half: event fold, tail panel, styles, dictionaries
cordis.patch.yml composition
```

`client.js` is a browser-format artifact: it registers a lazy factory through
`window.__ModuleLoader__.load` instead of exporting. `test/client.test.mjs` stubs
that global to drive it.

## License

[MIT](./LICENSE) © 2026 Rina
