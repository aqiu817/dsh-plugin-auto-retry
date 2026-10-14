/**
 * Browser half: the full failure detail the native transcript discards.
 *
 * The host half schedules retries that the built-in executor declined. Those
 * retries reuse the `llm/retry` session event, so the shipped `model-retry`
 * definition already renders each one as a collapsed `<details>` row — nothing
 * here needs to duplicate that.
 *
 * What the native surfaces lose is the *content*:
 *
 * - `failureMessage()` in `dsh-client-ui-chat` replaces the raw text of `AUTH`,
 *   `QUOTA`, `ACCOUNT_QUOTA`, and the account codes with a short localized
 *   phrase, so the provider's own words never reach the reader.
 * - The terminal `turn-error` row renders inline and cannot be collapsed, so a
 *   long `errorChain` takes over the transcript.
 * - Neither surface exposes `status`, `requestId`, the provider route, the
 *   turn/step, or how long the wait was.
 *
 * This half folds `llm/retry` and terminal `turn/end` errors into one hidden
 * node per Turn and renders them in the Turn tail as a single collapsed
 * disclosure: a one-line summary, and on expansion every field, with the raw
 * message shown verbatim.
 *
 * Note on completeness: an adapter may have truncated the message at the source
 * — `dsh-plugin-kilo-gateway` does `detail.slice(0, 300)` — and no client can
 * recover text it never received. What this panel guarantees is that everything
 * the host did record is shown, uncut and unmapped.
 *
 * @module dsh-plugin-auto-retry/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-auto-retry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'auto-retry';
    /** Package identity, used as the slot entry id and the style tag owner. */
    const PKG = 'dsh-plugin-auto-retry';
    /** The hidden Conversation node kind this half folds events into. */
    const NODE_KIND = 'auto-retry';
    /** Style tag identity, so a re-mount does not append a second copy. */
    const CSS_TAG = `${PKG}/AutoRetryPanel.module.css`;
    /**
     * Prefix of our own policy keys. Official derives its key as
     * `JSON.stringify([mode, ...])`, so this is what tells our attempts apart
     * from the harness's inside one shared `llm/retry` stream.
     */
    const OUR_POLICY_PREFIX = '["auto-retry"';

    /**
     * The `plugins.bundle.config` cell key: the bundle's package name.
     *
     * A Host `Config` schema alone puts no control on the Plugins page: the page
     * renders a configuration entry only while an occupant claims the key, and
     * this is the only place that claim can be made. The bundle-level seat is the
     * right one here because this bundle declares exactly one row — its
     * configuration *is* the bundle's — and the seat renders directly on the
     * bundle's page rather than behind a second click into the row.
     */
    const BUNDLE_CONFIG_KEY = PKG;

    /**
     * The settings namespace this bundle's Host half owns.
     *
     * The row-level seat is handed a ready form: the row page builds one from the
     * `configForms` service and passes it down. The bundle-level seat is not — it
     * is rendered with `{ view: 'page' }` and nothing else — so this half builds
     * the same shape itself, which is why the namespace has to be spelled out
     * here as well as in `cordis.patch.yml`. The namespace is the patch row's id.
     */
    const CONFIG_NAMESPACE = 'auto-retry';

    /**
     * The scalar fields, in display order. `retryableCodes` is not here: it is
     * edited as switches, not typed.
     *
     * Bounds are spelled out rather than imported from `lib/index.js`: a client
     * bundle must not depend on a Host package, so the shared numbers are
     * restated here the way the shipped settings pages restate their namespaces.
     * `lib/index.js` stays the authority — the Host re-validates every write, and
     * these bounds only keep the inputs honest while editing.
     */
    const FIELDS = [
      { name: 'enabled', kind: 'boolean' },
      { name: 'extraRetries', kind: 'integer', min: 0, max: 10 },
      { name: 'initialDelayMs', kind: 'integer', min: 0, max: 600_000 },
      { name: 'maxDelayMs', kind: 'integer', min: 0, max: 600_000 },
      { name: 'jitterRatio', kind: 'number', min: 0, max: 1, step: 0.05 },
    ];

    /**
     * Every failure code the panel offers, grouped by what the policy does with
     * it.
     *
     * The list is built in rather than fetched because nothing exposes the
     * universe of codes an adapter may classify to: the codes come from
     * `@deepseek-ai/dsh-llm`'s error taxonomy, from the shipped default
     * retryable set, and from the two adapters in this profile
     * (`dsh-llm-pi-ai`'s `PI_AI_ERROR` and `dsh-plugin-kilo-gateway`'s
     * `PROVIDER_ERROR`). Anything an adapter invents beyond this list stays
     * reachable through the free-text escape hatch.
     *
     * `denied` mirrors the policy's hard floor: those switches render disabled,
     * because no configuration can enable them.
     */
    const CODE_GROUPS = [
      {
        id: 'default',
        codes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROVIDER_ERROR', 'PI_AI_ERROR'],
      },
      {
        id: 'optIn',
        codes: ['QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'UNKNOWN'],
      },
      {
        id: 'denied',
        codes: [
          'AUTH',
          'MISSING_CREDENTIAL',
          'INVALID_CREDENTIAL',
          'NO_ADAPTER',
          'INVALID_MODEL',
          'INVALID_CONFIG',
          'CONTEXT_WINDOW_EXCEEDED',
          'IMAGE_OFFLOAD_REQUIRED',
          'ABORTED',
        ],
      },
    ];

    /** Every catalogued code, in display order. */
    const CATALOG = CODE_GROUPS.flatMap((group) => group.codes);

    /** The codes a switch may actually change: everything but the hard floor. */
    const TOGGLEABLE = CODE_GROUPS
      .filter((group) => group.id !== 'denied')
      .flatMap((group) => group.codes);

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'summary.failed': '本轮重试 {count} 次 · 最终失败 {code}',
      'summary.recovered': '本轮重试 {count} 次',
      'summary.terminal': '本轮最终失败 {code}',
      'origin.plugin': '插件重试',
      'origin.harness': '官方重试',
      'origin.terminal': '终态失败',
      'record.retry': '第 {retry}/{maximum} 次',
      'record.terminal': '轮次结束',
      'field.code': '错误码',
      'field.status': 'HTTP',
      'field.provider': '提供方',
      'field.position': '位置',
      'field.delay': '等待',
      'field.requestId': '请求 id',
      'field.message': '完整报错',
      'value.turn': '第 {turn} 轮',
      'value.step': '第 {step} 步',
      'value.unknown': '未知',
      'value.unlimited': '∞',
      'config.summary': '接手官方重试执行器放弃的模型请求失败，并在轮次尾部展示完整报错',
      'config.enabled': '启用',
      'config.enabled.hint': '关掉后插件仍安装，但不再接手任何失败',
      'config.extraRetries': '额外重试次数',
      'config.extraRetries.hint': '官方预算之外的次数；0 表示不介入',
      'config.initialDelayMs': '首次延迟（毫秒）',
      'config.initialDelayMs.hint': '官方没试过时从这里起步；官方试过则接续它的曲线',
      'config.maxDelayMs': '延迟上限（毫秒）',
      'config.maxDelayMs.hint': '任何一次等待都不会超过它，包括提供方要求的延迟',
      'config.jitterRatio': '抖动比例',
      'config.jitterRatio.hint': '在本地计算的延迟上做对称随机扩散，0 到 1',
      'config.codes': '重试的错误码',
      'config.codes.default': '默认开启',
      'config.codes.default.hint': '官方那 5 个，加上两个适配器的兜底 code；开着的就是会被接手的',
      'config.codes.optIn': '按需开启',
      'config.codes.optIn.hint': '既可能瞬时也可能终态，由你的部署决定',
      'config.codes.denied': '永不重试',
      'config.codes.denied.hint': '策略里的硬拒绝，勾上也无效',
      'config.codes.extra': '其他错误码',
      'config.codes.extra.hint': '目录之外的自定义 code，每行一个',
      'config.codes.empty': '一个 code 都不留的话，宿主会当成笔误并回落到默认列表；这里不会把它存下去',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.saved': '已保存',
      'config.failed': '保存失败',
      'config.invalid': '有字段未通过校验，未提交任何修改：{fields}',
      'config.unavailable': '该命名空间当前不可写',
      'config.loading': '正在读取配置…',
      'config.unconfigured': '该命名空间不可写：部署未提供它，或本页只能读',
    };

    /** English dictionary. */
    const en = {
      'summary.failed': 'Retried {count} time(s) this turn · finally failed with {code}',
      'summary.recovered': 'Retried {count} time(s) this turn',
      'summary.terminal': 'This turn finally failed with {code}',
      'origin.plugin': 'Plugin retry',
      'origin.harness': 'Harness retry',
      'origin.terminal': 'Terminal failure',
      'record.retry': 'attempt {retry}/{maximum}',
      'record.terminal': 'turn ended',
      'field.code': 'Code',
      'field.status': 'HTTP',
      'field.provider': 'Provider',
      'field.position': 'Position',
      'field.delay': 'Waited',
      'field.requestId': 'Request id',
      'field.message': 'Full error',
      'value.turn': 'turn {turn}',
      'value.step': 'step {step}',
      'value.unknown': 'unknown',
      'value.unlimited': '∞',
      'config.summary': 'Takes over model-request failures the harness retry executor declined, and shows the full error at the turn tail',
      'config.enabled': 'Enabled',
      'config.enabled.hint': 'Off keeps the plugin installed but taking over nothing',
      'config.extraRetries': 'Extra retries',
      'config.extraRetries.hint': 'Attempts beyond the harness budget; 0 means never intervene',
      'config.initialDelayMs': 'First delay (ms)',
      'config.initialDelayMs.hint': 'Where our curve starts when the harness never tried; otherwise its curve is continued',
      'config.maxDelayMs': 'Maximum delay (ms)',
      'config.maxDelayMs.hint': 'No wait exceeds this, including a provider-requested one',
      'config.jitterRatio': 'Jitter ratio',
      'config.jitterRatio.hint': 'Symmetric random spread around each local delay, 0 to 1',
      'config.codes': 'Retryable codes',
      'config.codes.default': 'On by default',
      'config.codes.default.hint': "The harness's own five plus the two adapter catch-alls; these are what gets taken over",
      'config.codes.optIn': 'Opt in',
      'config.codes.optIn.hint': 'As likely to be permanent as transient — your deployment decides',
      'config.codes.denied': 'Never retried',
      'config.codes.denied.hint': 'The policy hard floor; ticking them changes nothing',
      'config.codes.extra': 'Other codes',
      'config.codes.extra.hint': 'Codes outside the catalog, one per line',
      'config.codes.empty': 'With no code left, the Host reads the list as a typo and falls back to its defaults; this page will not save that',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.saved': 'Saved',
      'config.failed': 'Save failed',
      'config.invalid': 'Some fields did not validate, so nothing was submitted: {fields}',
      'config.unavailable': 'This namespace is not writable right now',
      'config.loading': 'Reading the configuration…',
      'config.unconfigured': 'This namespace is not writable: the deployment does not serve it, or this page is read-only',
    };

    /**
     * Panel styles.
     *
     * Every colour, radius, and font comes from a theme token, so the panel
     * follows light and dark mode without its own palette. The tokens are the
     * ones `dsh-client-ui-plan` and `dsh-client-ui-chat` already use for the
     * same surfaces.
     */
    const CSS = [
      '.dar_root{margin:4px 0;font-size:var(--dsh-content-font-size-secondary,13px);',
      'line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}',
      '.dar_summary{cursor:pointer;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dar_summary:hover{color:var(--dsw-alias-label-primary)}',
      '.dar_summary:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dar_body{margin-top:6px;padding-left:14px;display:flex;flex-direction:column;gap:8px}',
      '.dar_record{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);',
      'padding:8px 10px;display:flex;flex-direction:column;gap:3px}',
      '.dar_recordHead{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.dar_badge{color:var(--dsw-alias-label-tertiary);font-size:11px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:0 5px}',
      '.dar_recordTitle{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dar_row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;overflow-wrap:anywhere}',
      '.dar_label{color:var(--dsw-alias-label-secondary)}',
      '.dar_value{min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.dar_message{--dar-message-fill:var(--dsw-static-neutral-50);margin:2px 0 0;padding:6px 8px;',
      'border-radius:var(--dsw-radius-sm);background:var(--dar-message-fill);',
      'color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);',
      'white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto}',
      'body[data-ds-dark-theme] .dar_message{--dar-message-fill:var(--dsw-static-neutral-850)}',
      '.dar_cfg{display:flex;flex-direction:column;gap:14px;max-width:640px}',
      '.dar_cfgField{display:flex;flex-direction:column;gap:4px}',
      '.dar_cfgLabel{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dar_cfgHint{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dar_cfgInput{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-specific-input-major,transparent);color:var(--dsw-alias-label-primary);',
      'font:inherit;padding:5px 8px;min-width:0}',
      'textarea.dar_cfgInput{min-height:88px;resize:vertical;font-family:inherit}',
      '.dar_cfgCheck{display:flex;align-items:center;gap:8px}',
      '.dar_cfgFooter{display:flex;align-items:center;gap:10px}',
      '.dar_cfgButton{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-label-primary);',
      'font:inherit;padding:5px 12px;cursor:pointer}',
      '.dar_cfgButton:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dar_cfgError{color:var(--dsw-alias-state-error-primary)}',
      '.dar_cfgSaved{color:var(--dsw-alias-label-secondary)}',
      '.dar_codes{display:flex;flex-direction:column;gap:10px}',
      '.dar_codeGroup{display:flex;flex-direction:column;gap:5px}',
      '.dar_codeGroupTitle{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dar_codeList{display:flex;flex-wrap:wrap;gap:6px 16px}',
      '.dar_codeItem{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);',
      'font:var(--dsw-font-markdown-code-block-small);cursor:pointer}',
      '.dar_codeItem[data-disabled]{color:var(--dsw-alias-label-tertiary);cursor:default}',
    ].join('');

    /**
     * Whether one retry record came from this plugin rather than the harness.
     *
     * The `llm/retry` event carries whichever `policyKey` scheduled it, and the
     * two producers namespace theirs differently, so the origin is readable
     * without a second event type.
     *
     * @param {unknown} policyKey - the record's policy key.
     * @returns {boolean}
     */
    function isOurs(policyKey) {
      return typeof policyKey === 'string' && policyKey.startsWith(OUR_POLICY_PREFIX);
    }

    /**
     * Project one `llm/retry` event into the record the panel renders.
     *
     * @param {object} event - the session event.
     * @returns {object}
     */
    function retryRecord(event) {
      const data = event.data ?? {};
      return {
        seq: event.seq,
        time: event.time,
        retryId: data.retryId,
        provider: data.provider,
        turn: data.turn,
        step: data.step,
        mode: data.mode,
        policyKey: data.policyKey,
        retry: data.retry,
        maxRetries: data.maxRetries,
        delayMs: data.delayMs,
        failure: data.failure ?? null,
      };
    }

    /**
     * Project one terminal `turn/end` error into the record the panel renders.
     *
     * The field is `error`, not `failure`: `TurnEndReasonMap` types the `error`
     * variant as `{ kind: 'error'; error: LlmFailure }`. Reading `failure` here
     * would silently render an empty block for every terminal error.
     *
     * @param {object} event - the `turn/end` session event.
     * @returns {object}
     */
    function terminalRecord(event) {
      const reason = event.data?.reason ?? {};
      return {
        seq: event.seq,
        time: event.time,
        turn: event.data?.turn,
        failure: reason.error ?? null,
      };
    }

    /**
     * Fold `llm/retry` events and a terminal turn error into one hidden node per
     * Turn.
     *
     * `turn/start` seeds the fold, exactly as the shipped `schedule-created`
     * definition does: a Definition whose every match were an update would have
     * no state to update. The node stays `hidden` so it contributes no row of
     * its own — the native `model-retry` rows already cover the retries — and
     * exists only to carry the folded state to the Turn tail seat.
     */
    const retryErrorDefinition = {
      kind: NODE_KIND,
      target: 'chat',
      match: (event) => {
        if (event.type === 'turn/start') {
          return { id: String(event.data.turn), role: 'start' };
        }
        if (event.type === 'llm/retry') {
          return { id: String(event.data.turn), role: 'update' };
        }
        if (event.type === 'turn/end' && event.data.reason?.kind === 'error') {
          return { id: String(event.data.turn), role: 'update' };
        }
        return null;
      },
      start: (_context, match) => {
        if (match.event.type !== 'turn/start') {
          throw new Error('auto-retry start requires turn/start');
        }
        return { turn: match.event.data.turn, retries: [], terminal: null };
      },
      update: (context, match) => {
        if (match.event.type === 'llm/retry') {
          return {
            ...context.state,
            retries: [...context.state.retries, retryRecord(match.event)],
          };
        }
        return { ...context.state, terminal: terminalRecord(match.event) };
      },
      buildViewNode: (context) => {
        const start = context.start ?? context.matches[0];
        if (start === void 0) return null;
        return {
          key: context.key,
          kind: NODE_KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: start.event.seq,
          location: start.location,
          visibility: 'hidden',
          data: context.state,
        };
      },
    };

    /**
     * Read the Turn number off the tail seat's owner.
     *
     * The seat hands over the Conversation's Turn object, whose own `turn` field
     * is the number — `dsh-client-ui-plan` reads it the same way. A bare number
     * is accepted too so the panel does not depend on which shape arrives.
     *
     * @param {unknown} owner - the seat's `turn` prop.
     * @returns {string} the key the turn-data source is addressed by.
     */
    function turnKey(owner) {
      const value = typeof owner === 'number' ? owner : owner?.turn;
      return String(value);
    }

    /** One label/value line, or nothing when the value is absent. */
    function field(label, value, options = {}) {
      if (value === undefined || value === null || value === '') return null;
      const text = String(value);
      return h(
        'div',
        { className: 'dar_row', key: label },
        h('span', { className: 'dar_label' }, label),
        options.block
          ? h('pre', { className: 'dar_message' }, text)
          : h('span', { className: 'dar_value' }, text),
      );
    }

    /** One attempt: its origin, its position in the chain, and every fact. */
    function retryBlock(record, index, t) {
      const failure = record.failure ?? {};
      const maximum =
        record.mode === 'always' || record.maxRetries === undefined
          ? t('value.unlimited')
          : String(record.maxRetries);
      const position = [
        t('value.turn', { turn: record.turn ?? t('value.unknown') }),
        t('value.step', { step: record.step ?? t('value.unknown') }),
      ].join(' · ');
      return h(
        'div',
        { className: 'dar_record', key: `retry-${record.seq}-${index}` },
        h(
          'div',
          { className: 'dar_recordHead' },
          h('span', { className: 'dar_badge' }, isOurs(record.policyKey) ? t('origin.plugin') : t('origin.harness')),
          h(
            'span',
            { className: 'dar_recordTitle' },
            t('record.retry', { retry: record.retry ?? index + 1, maximum }),
          ),
        ),
        field(t('field.code'), failure.code),
        field(t('field.status'), failure.status),
        field(t('field.provider'), record.provider),
        field(t('field.position'), position),
        field(t('field.delay'), Number.isFinite(record.delayMs) ? `${Math.round(record.delayMs)} ms` : undefined),
        field(t('field.requestId'), failure.requestId),
        field(t('field.message'), failure.message, { block: true }),
      );
    }

    /** The terminal failure, which carries no retry index and no wait. */
    function terminalBlock(record, t) {
      const failure = record.failure ?? {};
      return h(
        'div',
        { className: 'dar_record', key: `terminal-${record.seq}` },
        h(
          'div',
          { className: 'dar_recordHead' },
          h('span', { className: 'dar_badge' }, t('origin.terminal')),
          h('span', { className: 'dar_recordTitle' }, t('record.terminal')),
        ),
        field(t('field.code'), failure.code),
        field(t('field.status'), failure.status),
        field(t('field.position'), t('value.turn', { turn: record.turn ?? t('value.unknown') })),
        field(t('field.requestId'), failure.requestId),
        field(t('field.message'), failure.message, { block: true }),
      );
    }

    /**
     * The Turn-tail disclosure.
     *
     * Renders nothing for a Turn that neither retried nor failed, so the seat
     * stays empty on the overwhelming majority of turns. The summary names what
     * happened; the body is where the raw text lives, uncut and unmapped.
     *
     * @param {object} props - seat props plus the injected retry-data hook.
     * @returns {object|null} the disclosure, or null when the Turn has nothing.
     */
    function RetryErrorPanel({ turn, useRetryErrors, t }) {
      const nodes = useRetryErrors(turnKey(turn));
      const state = Array.isArray(nodes) ? nodes[0] : undefined;
      if (state === void 0) return null;

      const retries = Array.isArray(state.retries) ? state.retries : [];
      const terminal = state.terminal ?? null;
      if (retries.length === 0 && terminal === null) return null;

      const summary = terminal === null
        ? t('summary.recovered', { count: retries.length })
        : retries.length === 0
          ? t('summary.terminal', { code: terminal.failure?.code ?? t('value.unknown') })
          : t('summary.failed', { count: retries.length, code: terminal.failure?.code ?? t('value.unknown') });

      return h(
        'details',
        { className: 'dar_root', 'data-auto-retry': true },
        h('summary', { className: 'dar_summary' }, summary),
        h(
          'div',
          { className: 'dar_body' },
          ...retries.map((record, index) => retryBlock(record, index, t)),
          terminal === null ? null : terminalBlock(terminal, t),
        ),
      );
    }

    // -----------------------------------------------------------------------
    // Row configuration page
    // -----------------------------------------------------------------------

    /**
     * Parse the escape hatch's text into a code list.
     *
     * Accepts newlines or commas so a pasted comma-separated list works, trims
     * each entry, drops blanks, and de-duplicates — the same normalization
     * `readSettings()` applies on the Host, so what the reader sees after saving
     * matches what they typed.
     *
     * @param {unknown} text - the extra-codes field's text.
     * @returns {string[]}
     */
    function codesFromText(text) {
      if (typeof text !== 'string') return [];
      return [...new Set(text.split(/[\s,]+/).map((code) => code.trim()).filter((code) => code !== ''))];
    }

    /**
     * Seed the editable draft from the accepted Host value.
     *
     * The catalog splits the accepted list in two: codes the switches own, and
     * anything else — a code an adapter invented, or a hard-floor code someone
     * set by hand — which the escape hatch preserves verbatim so a save can
     * never silently drop it.
     *
     * Numbers become strings because that is what a text input holds; the draft
     * is deliberately seeded once, since the Plugins page discards staged edits
     * when the reader leaves the entry.
     *
     * @param {Record<string, unknown> | undefined} value - the resolved section.
     * @returns {Record<string, string|boolean|string[]>}
     */
    function draftFrom(value) {
      const source = value ?? {};
      const accepted = Array.isArray(source.retryableCodes) ? source.retryableCodes : [];
      const draft = {
        codes: CATALOG.filter((code) => accepted.includes(code)),
        extra: accepted.filter((code) => !CATALOG.includes(code)).join('\n'),
      };
      for (const field of FIELDS) {
        draft[field.name] = field.kind === 'boolean'
          ? source[field.name] === true
          : source[field.name] === undefined || source[field.name] === null
            ? ''
            : String(source[field.name]);
      }
      return draft;
    }

    /**
     * Add or remove one code from the staged switches.
     *
     * Returns the list unchanged when the code sits on the policy's hard floor:
     * those switches render disabled, and this is the same refusal stated where
     * it is enforced, so a synthetic event cannot edit a list no setting can
     * affect.
     *
     * The result stays in catalog order, so toggling cannot produce a spurious
     * write from reordering alone.
     *
     * @param {string[]} codes - the staged checked codes.
     * @param {string} code - the code to toggle.
     * @param {boolean} on - whether the switch is now on.
     * @returns {string[]}
     */
    function toggled(codes, code, on) {
      if (!TOGGLEABLE.includes(code)) return codes;
      const next = new Set(codes);
      if (on) next.add(code);
      else next.delete(code);
      return CATALOG.filter((candidate) => next.has(candidate));
    }

    /**
     * Parse one numeric input onto its field's range.
     *
     * @param {unknown} text - the input's text.
     * @param {{kind: string, min: number, max: number}} field
     * @returns {number|undefined} the value, or `undefined` when unusable.
     */
    function numberFrom(text, field) {
      if (typeof text === 'number') {
        return Number.isFinite(text) && text >= field.min && text <= field.max ? text : undefined;
      }
      if (typeof text !== 'string' || text.trim() === '') return undefined;
      const value = Number(text);
      if (!Number.isFinite(value)) return undefined;
      if (field.kind === 'integer' && !Number.isInteger(value)) return undefined;
      if (value < field.min || value > field.max) return undefined;
      return value;
    }

    /**
     * Whether two code lists hold the same codes.
     *
     * Order-insensitive on purpose: the switches always emit catalog order, so
     * an accepted list that merely lists the same codes differently must not
     * count as a change.
     */
    function sameCodes(left, right) {
      if (!Array.isArray(left) || !Array.isArray(right)) return false;
      const a = new Set(left);
      const b = new Set(right);
      if (a.size !== b.size) return false;
      for (const code of a) if (!b.has(code)) return false;
      return true;
    }

    /** The code list a staged draft currently stands for. */
    function codesOf(draft) {
      return [...(Array.isArray(draft.codes) ? draft.codes : []), ...codesFromText(draft.extra)];
    }

    /**
     * Turn a staged draft into the ordered writes one save submits.
     *
     * Only changed fields produce an operation, so a save that touched nothing
     * writes nothing. A field the reader left unusable is reported instead of
     * being written: submitting a value the Host would refuse turns a visible
     * typo into an opaque failed save.
     *
     * An allowlist with nothing in it is unusable in the same way, but for a
     * different reason: the Host reads an empty list as a typo and falls back to
     * its defaults, so writing it would leave the page saying "no codes" while the
     * plugin still took over seven. The page refuses to produce that state rather
     * than letting the two disagree.
     *
     * @param {Record<string, string|boolean|string[]>} draft - the staged edits.
     * @param {Record<string, unknown> | undefined} original - the accepted values.
     * @returns {{ops: object[], invalid: string[]}}
     */
    function opsFrom(draft, original) {
      const source = original ?? {};
      const ops = [];
      const invalid = [];

      const codes = codesOf(draft);
      if (codes.length === 0) {
        invalid.push('retryableCodes');
      } else if (!sameCodes(codes, Array.isArray(source.retryableCodes) ? source.retryableCodes : [])) {
        ops.push({ op: 'set', path: ['retryableCodes'], value: codes });
      }

      for (const field of FIELDS) {
        const name = field.name;
        if (field.kind === 'boolean') {
          const value = draft[name] === true;
          if (value !== (source[name] === true)) ops.push({ op: 'set', path: [name], value });
          continue;
        }
        const value = numberFrom(draft[name], field);
        if (value === undefined) {
          invalid.push(name);
          continue;
        }
        if (value !== source[name]) ops.push({ op: 'set', path: [name], value });
      }
      return { ops, invalid };
    }

    /** One labelled control, with its hint underneath. */
    function configField(field, draft, update, t, writable) {
      const label = t(`config.${field.name}`);
      const hint = t(`config.${field.name}.hint`);
      const value = draft[field.name];

      if (field.kind === 'boolean') {
        return h(
          'div',
          { className: 'dar_cfgField', key: field.name },
          h(
            'label',
            { className: 'dar_cfgCheck' },
            h('input', {
              type: 'checkbox',
              'data-field': field.name,
              checked: value === true,
              disabled: !writable,
              onChange: (event) => update(field.name, event.target.checked),
            }),
            h('span', { className: 'dar_cfgLabel' }, label),
          ),
          h('span', { className: 'dar_cfgHint' }, hint),
        );
      }

      const control = h('input', {
        className: 'dar_cfgInput',
        'data-field': field.name,
        type: 'number',
        value,
        min: field.min,
        max: field.max,
        step: field.step ?? 1,
        disabled: !writable,
        onChange: (event) => update(field.name, event.target.value),
      });

      return h(
        'div',
        { className: 'dar_cfgField', key: field.name },
        h('label', { className: 'dar_cfgLabel' }, label),
        control,
        h('span', { className: 'dar_cfgHint' }, hint),
      );
    }

    /** One group of code switches, with its heading and hint. */
    function codeGroup(group, draft, toggle, t, writable) {
      const denied = group.id === 'denied';
      const checked = new Set(Array.isArray(draft.codes) ? draft.codes : []);
      return h(
        'div',
        { className: 'dar_codeGroup', key: group.id },
        h('span', { className: 'dar_codeGroupTitle' }, t(`config.codes.${group.id}`)),
        h('span', { className: 'dar_cfgHint' }, t(`config.codes.${group.id}.hint`)),
        h(
          'div',
          { className: 'dar_codeList' },
          ...group.codes.map((code) => h(
            'label',
            {
              className: 'dar_codeItem',
              key: code,
              'data-disabled': denied ? true : undefined,
            },
            h('input', {
              type: 'checkbox',
              'data-code': code,
              checked: checked.has(code),
              // The hard floor is a policy constant, not a preference: showing
              // the switches disabled is how the page says so without hiding
              // which codes exist.
              disabled: denied || !writable,
              onChange: (event) => toggle(code, event.target.checked),
            }),
            h('span', null, code),
          )),
        ),
      );
    }

    /**
     * Follow the configuration form this seat was given.
     *
     * The bundle page hands over the `configForms` entry itself — an observable
     * with `getSnapshot`/`subscribe` — rather than a snapshot, and the snapshot
     * only becomes meaningful once the shared describe mirror answers. Subscribing
     * is what lets that answer reach a page that mounted before it.
     *
     * @param {object|undefined} form - the injected configuration entry.
     * @returns {object|undefined} the current `ConfigFormSnapshot`.
     */
    function useFormState(form) {
      const subscribe = React.useCallback(
        (listener) => (form === void 0 ? () => {} : form.subscribe(listener)),
        [form],
      );
      const read = React.useCallback(() => form?.getSnapshot(), [form]);
      return React.useSyncExternalStore(subscribe, read, read);
    }

    /**
     * The bundle's configuration page.
     *
     * The Plugins page asks one entry for two views: `page` is the form with its
     * own save control, `summary` is the one-liner the row-level seat renders
     * where a row has no description. This component answers both so it stays
     * usable from either seat. Edits stay staged until Save, which submits every
     * changed field under one revision fence, so a concurrent write is refused
     * rather than silently overwritten.
     *
     * @param {object} props - owner props plus the injected translator and form.
     * @returns {object|null}
     */
    function RetryConfigPanel({ view, form, t }) {
      // Hooks run before any early return: a branch above the hooks would change
      // the hook count between renders if React ever reuses the instance.
      const state = useFormState(form);
      const accepted = state?.value ?? {};
      // `null` until the reader stages something. What the controls show is then
      // the accepted value itself, so an answer that arrives after mount fills
      // the form in with no re-seeding rule, and the reader's first edit
      // snapshots exactly what was on screen. Seeding a draft up front would
      // freeze whatever the form looked like at mount — nothing, on the bundle
      // page, whose first render happens while the mirror is still reading.
      const [staged, setStaged] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);
      const [invalid, setInvalid] = React.useState([]);

      if (view === 'summary') {
        return h('span', { className: 'dar_cfgHint' }, t('config.summary'));
      }

      if (state === void 0) {
        return h('span', { className: 'dar_cfgHint' }, t('config.unavailable'));
      }
      // Neither of these is an error: one is the mirror still answering, the
      // other a deployment whose Host half is not composed. Both are states the
      // page can recover from on its own, so it says so instead of drawing a form
      // whose Save could only fail.
      if (state.status === 'loading') {
        return h('span', { className: 'dar_cfgHint' }, t('config.loading'));
      }
      if (state.status === 'unavailable') {
        return h('span', { className: 'dar_cfgHint' }, t('config.unconfigured'));
      }

      const writable = state.writable === true;
      const draft = staged ?? draftFrom(accepted);

      // Functional updates: two edits landing before a redraw must both survive,
      // and the first one stages the whole form as it stood when it was touched.
      const edit = (change) => setStaged((current) => change(current ?? draftFrom(accepted)));
      const update = (name, next) => edit((base) => ({ ...base, [name]: next }));
      const toggle = (code, on) => edit((base) => ({
        ...base,
        codes: toggled(Array.isArray(base.codes) ? base.codes : [], code, on),
      }));

      const save = () => {
        const { ops, invalid: rejected } = opsFrom(draft, accepted);
        if (rejected.length > 0) {
          setInvalid(rejected);
          setOutcome(null);
          return;
        }
        setInvalid([]);
        if (ops.length === 0) {
          setOutcome('saved');
          return;
        }
        setOutcome('saving');
        Promise.resolve(form.mutate(ops, state.revision)).then(
          (acceptedWrite) => setOutcome(acceptedWrite === false ? 'failed' : 'saved'),
          () => setOutcome('failed'),
        );
      };

      return h(
        'div',
        { className: 'dar_cfg', 'data-auto-retry-config': true },
        ...FIELDS.map((field) => configField(field, draft, update, t, writable)),
        h(
          'div',
          { className: 'dar_cfgField' },
          h('span', { className: 'dar_cfgLabel' }, t('config.codes')),
          h(
            'div',
            { className: 'dar_codes' },
            // Said while it is being staged, not only when Save is refused: the
            // reader should learn why before they have finished deciding.
            codesOf(draft).length === 0
              ? h('span', { className: 'dar_cfgError', role: 'status' }, t('config.codes.empty'))
              : null,
            ...CODE_GROUPS.map((group) => codeGroup(group, draft, toggle, t, writable)),
            h(
              'div',
              { className: 'dar_codeGroup' },
              h('span', { className: 'dar_codeGroupTitle' }, t('config.codes.extra')),
              h('span', { className: 'dar_cfgHint' }, t('config.codes.extra.hint')),
              h('textarea', {
                className: 'dar_cfgInput',
                'data-field': 'extra',
                value: draft.extra,
                rows: 3,
                spellCheck: false,
                disabled: !writable,
                onChange: (event) => update('extra', event.target.value),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dar_cfgFooter' },
          h(
            'button',
            {
              type: 'button',
              className: 'dar_cfgButton',
              disabled: !writable || outcome === 'saving',
              onClick: save,
            },
            outcome === 'saving' ? t('config.saving') : t('config.save'),
          ),
          outcome === 'saved' ? h('span', { className: 'dar_cfgSaved', role: 'status' }, t('config.saved')) : null,
          outcome === 'failed' ? h('span', { className: 'dar_cfgError', role: 'status' }, t('config.failed')) : null,
          invalid.length > 0
            ? h('span', { className: 'dar_cfgError', role: 'status' }, t('config.invalid', { fields: invalid.join(', ') }))
            : null,
          writable ? null : h('span', { className: 'dar_cfgHint' }, t('config.unavailable')),
        ),
      );
    }

    return {
      inject: ['slots', 'sessions', 'locale', 'uiConversation'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) !== null) {
            return () => {};
          }
          const tag = document.createElement('style');
          tag.dataset.plugin = PKG;
          tag.dataset.pluginCss = CSS_TAG;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'auto-retry: styles');

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-retry: dictionaries');

        ctx.effect(
          () => ctx.uiConversation.events.register(retryErrorDefinition),
          'auto-retry: conversation definition',
        );

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: PKG,
          locale: NS,
          inject: (sessionId) => {
            const binding = ctx.sessions.binding(sessionId);
            if (binding === void 0) throw new Error(`auto-retry: unknown session "${sessionId}"`);
            const chat = ctx.uiConversation.binding(binding).target('chat');
            return {
              keyedHooks: {
                retryErrors: (turn) => {
                  const snapshot = chat.getSnapshot();
                  if (snapshot === void 0) throw new Error('auto-retry: Chat target is unavailable');
                  return snapshot.nodes.turnDataSource(Number(turn), NODE_KIND);
                },
              },
            };
          },
        }, RetryErrorPanel));

        // The bundle's configuration page. A Host `Config` schema alone puts no
        // control on the Plugins page: one appears only while an occupant claims
        // a configuration key, which is this registration.
        //
        // The bundle-level seat rather than the row-level one: this bundle
        // declares exactly one row, so the two would carry identical content,
        // and the bundle seat renders directly on the bundle's page instead of
        // behind a second click into the row.
        //
        // `configForms` is asked for through its own fiber rather than declared
        // in this module's `inject`, because a deployment that left the settings
        // package out should lose the configuration page and nothing else — a
        // hard dependency here would keep the retry panel from loading too.
        ctx.inject(['configForms'], (scope) => {
          scope.effect(() => scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE_CONFIG_KEY,
            locale: NS,
            inject: () => ({ form: scope.configForms.get(CONFIG_NAMESPACE) }),
          }, RetryConfigPanel)), 'auto-retry: bundle configuration page');
        });
      },
    };
  },
});
