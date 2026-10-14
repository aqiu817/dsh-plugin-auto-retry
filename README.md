# dsh-plugin-auto-retry

**官方重试放手的那些失败，我们接住。**

**简体中文** | [English](./README.en.md)

DeepSeek Harness 宿主侧插件。它挂在官方 `@deepseek-ai/dsh-llm-retry` **主动放弃**的那个位置，接住它让出去的模型请求失败，按「接续它的退避曲线」再试几次；同时在轮次尾部给一个默认折叠的面板，把原生转录里被丢掉或替换掉的**完整报错**还给读者。

没有客户端注入的伪造消息，不替换也不改动任何官方插件。

[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
![node](https://img.shields.io/badge/node-%3E%3D22-informational)

---

## 目录

- [它解决什么](#它解决什么)
- [与官方重试的关系](#与官方重试的关系)
- [官方不会自动重试的部分](#官方不会自动重试的部分)
- [安装](#安装)
- [配置](#配置)
- [工作原理](#工作原理)
- [不冲突保证](#不冲突保证)
- [客户端半部](#客户端半部)
- [安全设计](#安全设计)
- [测试](#测试)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [开发](#开发)
- [License](#license)

## 它解决什么

dsh 自带重试：`@deepseek-ai/dsh-base` 里挂了

```yaml
- id: llm-retry
  name: '@deepseek-ai/dsh-llm-retry'
```

它在 `agent/request-error` 这个 waterfall 上工作，按 provider 路由的 `retryPolicy` 重跑失败的模型请求。**但它只在一个很窄的口子上工作**：

- 只认固定的几个失败 code
- 预算有界（normal 模式默认 5 次）
- 适配器没声明策略时用一套默认值

于是有大量失败**一次都不重试**。这个插件补的就是这一段。

它不替代官方执行器，而是挂在它**主动放弃**的那个位置——官方在决定「不重试」时**一定会调用 `next()`**，而 waterfall 按注册顺序外层优先、`dsh-base` 又先于任何 profile bundle 加载，所以官方永远是外层，我们永远是下游。**官方让出去的每一次失败，都会精确流到我们手上。**

## 与官方重试的关系

```
模型请求失败
   │
   ├─ dsh-llm-retry（外层，dsh-base 挂载）
   │     ├─ 可重试且预算未耗尽 → backoff() → { kind: 'retry' }   ← 我们不参与
   │     └─ 否则 → next()  ──────────────────────────────┐
   │                                                      │
   └─ auto-retry（下游，本插件） ←─────────────────────────┘
         ├─ 命中硬拒绝集合 → 交回终态
         ├─ 不在白名单     → 交回终态
         ├─ 超出额外预算   → 交回终态
         └─ 否则：先持久 → 可取消等待 → 追加 started → { kind: 'retry' }
```

官方默认 normal 策略（`dsh-llm/lib/types/retry-policy.js`）：

```
retryableCodes: EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT
maxRetries:     5
backoff:        500ms → 10000ms，抖动 0.1
```

## 官方不会自动重试的部分

| # | 缺口 | 官方为何跳过 | 本插件 |
|---|---|---|---|
| G1 | `code` 不在 `retryableCodes` | 显式集合判断 | ✅ 接手 |
| G2 | 预算耗尽 | 有界预算 | ✅ 接手 |
| G3 | `retryPolicy === undefined`（最终适配器选定前的失败） | 无策略 | ✅ 接手（限白名单） |
| G4 | `UNKNOWN`——非 `HarnessError` 穿过适配器边界 | 不在集合内 | ⚠️ 需手动开启 |
| G5 | 工具／middleware／扩展失败 | 根本不进 `agent/request-error` | ❌ 不做 |
| G6 | 直接 `ctx.llm.stream()` 消费方 | 无 agent 轮次 | ❌ 不做 |
| G7 | `aborted` | 用户主动取消 | ❌ **永不重试** |
| G8 | `CONTEXT_WINDOW_EXCEEDED` / `IMAGE_OFFLOAD_REQUIRED` | 压缩／图片卸载拥有 | ❌ **永不重试** |

落到常见路由上的具体缺口：

| 适配器 | 产生但不被重试的 code |
|---|---|
| `@deepseek-ai/dsh-llm-pi-ai` | `PI_AI_ERROR`（它的兜底）、`QUOTA`、`INVALID_REQUEST`、`AUTH`、`UNKNOWN` |
| `@deepseek-ai/dsh-plugin-kilo-gateway` | `PROVIDER_ERROR`、`INVALID_MODEL`、`INVALID_REQUEST`、`QUOTA`、`AUTH` |

两处代码里已经写下的证词：

- `dsh-plugin-kilo-gateway/lib/index.js:229`：「把一切都归成一个 code……会**静默地完全禁用重试**，因为默认可重试集合不包含那个 code。」
- `dsh-llm-agentrouter/lib/index.js:144`：「`INVALID_REQUEST` 不在 harness 默认可重试集合里，所以一个 400 就结束整个 turn。」

## 安装

标准 dsh bundle。推荐走 `plugin_manager` 的 `install_bundle`，由它代写 profile 的依赖与 patch：

```
plugin_manager(action: "install_bundle", target: "dsh-plugin-auto-retry")
```

手工安装则是在 profile 的 `package.json`（`~/.dsh/profiles/<name>/package.json`）里加依赖并加进 `bundles`：

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

本地改代码时把版本号换成目录链接，省掉每次 `npm install`：

```jsonc
"dsh-plugin-auto-retry": "link:/absolute/path/to/dsh-plugin-auto-retry"
```

`cordis.patch.yml` 会通过 `dsh.bundle.patch` 自动挂进 patch 列表，不需要手写那条 `- insert:`。

装好之后**先跑一次 `npm test`**：`contract.test.mjs` 会逐个检查 `package.json` 里 `files` 指向的每个文件、依赖目录及其 `package.json` 是否真实可读，并重复 import 25 次确认稳定。

### 卸载

删掉依赖和 `bundles` 里那一行，再装一次依赖。没有残留状态。

> 本插件**不是** `required` bundle：组合失败不会写启动日志。装完请确认 Plugins 页面能看到 `auto-retry` 这一项。

## 配置

六个字段全部是 `.volatile()`：在 Plugins 页面改了**不重载 fiber**，`enabled: false` 中途就能掐断一条正在跑的重试链。

**在哪里改**：侧栏 → **插件** → 找到 `dsh-plugin-auto-retry` 这个组合包 → 打开它，配置表单就在这一页上。表单由本插件的浏览器半部通过 `plugins.bundle.config` slot 提供，key 是包名本身。

> 这一点容易踩空：**宿主侧的 `Config` schema 本身不会在 Plugins 页面产生任何配置控件**。配置区只在某个插件注册了 slot 时出现——组合包级的 `plugins.bundle.config`（key = 包名），或行级的 `plugins.row.config`（key = `<包名>#<行 id>`，需要再点进那一行才会有「配置」入口）。这里选组合包级：本插件只声明一行，两者内容完全一样，但组合包级少一次点击。所以一个只有宿主半部的插件（例如 `dsh-plugin-continue-on-limit`）在 Plugins 页面上看不到配置——它的 `Config` 依然生效，只是没有编辑入口。
>
> 组合包级的 slot **不会**把表单对象递给你（行级才会），所以浏览器半部自己从 `configForms` 服务取命名空间 `auto-retry` 的表单。这个服务属于设置包，因此它不写在浏览器半部的 `inject` 里、而是单独开一个 fiber 去要：这样在一个没装设置包的部署里，丢掉的只有配置页，重试面板照常工作。
>
> 命名空间 `auto-retry` 必须与 `cordis.patch.yml` 里的行 id 一致，否则配置页会一直是空的（契约测试交叉检查这两处）。

表单行为：改动**暂存**到按下保存；保存只提交真正变动的字段，全部挂在**同一个 revision 栅栏**下，所以并发写入会被拒绝而不是被静默覆盖。离开该页面会丢弃暂存改动。数字字段超出边界或无法解析时，保存会被拦下并指出是哪个字段——不会把宿主会拒绝的值发出去。

| 字段 | 类型 | 默认 | 边界 | 说明 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | — | 总开关 |
| `extraRetries` | integer | `3` | 0–10 | **官方预算之外**额外允许的尝试次数；`0` = 不介入 |
| `initialDelayMs` | integer | `1000` | 0–600000 | 官方**没试过**时的起步延迟 |
| `maxDelayMs` | integer | `60000` | 0–600000 | 外层上限，也用于钳制 provider 延迟 |
| `jitterRatio` | number | `0.2` | 0–1 | 对称抖动比例 |
| `retryableCodes` | string[] | 见下 | 至少 1 个 | 我们愿意接手的 code |

`retryableCodes` 在页面上是**开关**，不是文本框——没有哪个接口能列出「适配器可能返回的全部 code」，所以内置了一份目录，分三组渲染：

| 分组 | 呈现 | code |
|---|---|---|
| **默认开启** | 开关 | `EMPTY_RESPONSE` `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` `PROVIDER_ERROR` `PI_AI_ERROR` |
| **按需开启** | 开关 | `QUOTA` `ACCOUNT_QUOTA` `INVALID_REQUEST` `UNKNOWN` |
| **永不重试** | 开关但**禁用** | `AUTH` `MISSING_CREDENTIAL` `INVALID_CREDENTIAL` `NO_ADAPTER` `INVALID_MODEL` `INVALID_CONFIG` `CONTEXT_WINDOW_EXCEEDED` `IMAGE_OFFLOAD_REQUIRED` `ABORTED` |

第三组照样列出来、但开关是禁用的：这样页面既说清了有哪些 code 存在，也说了它们勾不动——硬拒绝是策略常量，不是偏好。开关的初始状态来自**已接受的值**，不是目录默认值；目录外的 code（某个适配器自己发明的）落在「其他错误码」文本里，每行一个。

**一个 code 都不留是不允许的**，页面会在暂存阶段就说明，并在保存时拦下。原因在宿主侧：`codesWithin()` 把空列表当成**笔误**，回落到默认白名单（否则一个输错的配置会悄悄把插件关掉，而设置页还显示它开着）。所以存一个空列表会让页面显示「一个都不重试」、而插件实际还在重试 7 个 code。要么勾一个，要么用 `enabled: false` / `extraRetries: 0` 表达「不介入」——那两个是明确的，不会和页面打架。

> 手改 `cordis.patch.yml` 写 `retryableCodes: []` 同样会回落到默认白名单。手上的配置能被页面表达，就不该在页面之外生效。

默认白名单：

```
EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT,   ← 官方那 5 个（接手 = 延长预算）
PROVIDER_ERROR, PI_AI_ERROR                                ← 两个适配器的兜底 code
```

**硬拒绝集合**（代码常量，不可配置，优先于白名单）：

```
AUTH, MISSING_CREDENTIAL, INVALID_CREDENTIAL, NO_ADAPTER,
INVALID_MODEL, INVALID_CONFIG,
CONTEXT_WINDOW_EXCEEDED, IMAGE_OFFLOAD_REQUIRED, ABORTED
```

硬拒绝**优先于**白名单。这是安全底线：一个误输的白名单不该有权力去重试认证失败或上下文溢出。

`QUOTA` / `ACCOUNT_QUOTA` / `INVALID_REQUEST` / `UNKNOWN` **不在**默认白名单，也不在硬拒绝集合——它们既可能是瞬时的，也可能是真正终态的，所以由部署自己决定：加进 `retryableCodes` 就生效。这样守住了「route on code, never parse message」这条平台原则，又给中继的额度池与 400 方言拒绝留了口子。

`cordis.patch.yml` 里的默认值：

```yaml
- insert:
    - id: auto-retry
      name: 'dsh-plugin-auto-retry'
      config:
        enabled: true
        extraRetries: 3
        initialDelayMs: 1000
        maxDelayMs: 60000
        jitterRatio: 0.2
        retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, PROVIDER_ERROR, PI_AI_ERROR]
```

## 工作原理

### 1. 挂载点：只接官方让出去的失败

```js
ctx.on('agent/request-error', async (payload, next) => {
  const terminal = await next();                    // 先让下游/终态说话
  if (terminal !== void 0) return terminal;
  if (lifetime.signal.aborted || payload.signal.aborted) return terminal;
  // …资格判定 → 计数 → 持久 → 可取消等待 → { kind: 'retry' }
});
```

官方在决定重试时**不会**调用 `next()`，所以我们物理上收不到那次失败——**不存在双重试的可能**。

失败发生在**打开的 step 内部**、任何工具结果被合成之前，因此：

- 同一份持久历史，请求仍可从会话日志重建
- 不产生合成的 `TOOL_OUTCOME_UNKNOWN` 结果，**不会诱导模型重跑副作用工具**
- 尊重同一个 `signal`，取消语义天然正确
- 不注入伪造的用户消息，转录干净
- 不走 `session/event` 回调，没有 `append` 重入问题

harness 文档对此边界的原话：

> 最终适配器选择、分发与迭代失败以终止结束的形式到达并进入 `agent/request-error`；处理该失败的监听器返回 `{ kind: 'retry' }` 且不调用 `next()`，未被处理的失败则是终态。Middleware、结果处理、工具及其他扩展失败仍会抛出并直接关闭轮次——**插件失败结束的是轮次，不是循环**。

### 2. 退避：接续官方曲线，不另起一段

先读官方在当前 step 内已排的重试次数（按 provider 过滤、排除我们自己的 key）：

```js
const state = ctx.sessionProjections.stateOf(agent.session, 'llmRetry');
const official = officialRetries(state, provider);
```

然后：

```js
if (official <= 0) return localDelay(ourRetry, settings, random);   // 官方没试过 → 1s 起步
const curve = {                                                     // 官方试过 → 接续它的曲线
  initialDelayMs: officialPolicy.initialDelayMs,
  maxDelayMs: Math.min(officialPolicy.maxDelayMs, settings.maxDelayMs),
  jitterRatio: officialPolicy.jitterRatio,
};
return localDelay(official + ourRetry, curve, random);              // 在它最长的那次之后再推一格
```

`localDelay` 与官方逐字同构：

```js
const exponential = Math.min(initialDelayMs * 2 ** (retry - 1), maxDelayMs);
const jitter = 1 - jitterRatio + 2 * jitterRatio * random();
return Math.min(exponential * jitter, maxDelayMs);
```

效果对照：

| 场景 | 官方已试 | 我们的第 1/2/3 次延迟 |
|---|---|---|
| `PI_AI_ERROR`（官方完全不管） | 0 | 1s / 2s / 4s |
| `RATE_LIMIT` 预算耗尽 | 5（base 500, cap 10000） | 10s / 10s / 10s（封顶） |

**为什么接续而不是重来**：官方放弃时，它的曲线已经推到很深了。从 1 秒重新开始等于对着刚刚让我们慢一点的 provider 猛敲。

`providerRetryAfterMs` 有效时优先用它，钳到 `maxDelayMs`。

> **与官方的一处有意差异**：官方 normal 模式在 `providerRetryAfterMs > maxDelayMs` 时直接放弃重试；我们改为钳制后仍然重试。理由：provider 是在告诉我们「什么时候再来」，直接放弃等于白丢一次机会。

### 3. 计数：复用官方投影，不自己造

```js
const key = policyKey(settings);                                    // '["auto-retry",…]'
const entry = state?.[JSON.stringify([provider, key])];
const ourRetry = (entry?.retry ?? 0) + 1;
const retryId = entry?.retryId ?? randomUUID();
```

官方投影的 `apply` 在 `step/start` 与 `turn/end` 时清空——正是我们要的「每 step 一套预算」，且随日志折叠，重启后依然正确。

### 4. 先持久，后等待

等待前追加 `llm/retry`，返回前追加 `llm/retry-started`，复用官方的事件词汇，所以官方的 `llmRetry` 投影与（若挂载）invariant 伴生插件都认得。**追加失败即放弃重试**（写日志、返回终态）——宁可少重试一次，也不留一个不可见的待处理重试。

## 不冲突保证

| # | 保证 | 依据 |
|---|---|---|
| 1 | **粒度不同**：官方重跑打开的 step 内的请求；我们只在它 `next()` 后介入 | 官方决定重试时不调用 `next()`，我们收不到 |
| 2 | **policyKey 命名空间隔离**：我们是 `JSON.stringify(['auto-retry', …])`，官方是 `JSON.stringify([mode, …])` | 首元素不同，永不相等；官方投影把两条链分开计数 |
| 3 | **只扩展不替换**：不禁用、不覆盖、不注销官方插件，不写它的 config | 只多注册一个 listener |
| 4 | **预算独立**：`extraRetries` 按我们自己的 policyKey 计数 | 同 #2 |
| 5 | **取消语义一致**：`AbortSignal.any([payload.signal, lifetime.signal])` | 与官方 `recover()` 同构 |
| 6 | **先持久后等待** | 复用已知事件类型 |
| 7 | **满足 invariant 全部规则** | `retry` 为正且 `≤ maxRetries`、在打开的 turn/step 内、provider 匹配、`retryId` 同链保持 |
| 8 | **`always` 模式不打架**：官方 `settleDownstream(next)` 先问下游 | 我们返回 `{ kind: 'retry' }` 它照办，不返回它自己重试 |
| 9 | **不动转录**：不调用 `followup()` | 与 `dsh-plugin-continue-on-limit` 零交集（触发 reason 不同） |
| 10 | **永不重试取消**：硬拒绝含 `ABORTED`，信号中断即放弃 | — |

## 客户端半部

原生**已经**把 `llm/retry` 渲染成默认折叠的 `<details>`（`ModelRetryItem`），所以我们的重试会**自动**出现在转录里，无需额外工作。

原生丢掉的是**内容**：

| 位置 | 现状 |
|---|---|
| `failureMessage()`（`dsh-client-ui-chat`） | 对 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` / 账户类 code，**把原文整段替换成一句本地化短语**——真实报错被丢弃 |
| `TurnErrorItem` | 终态报错行内联渲染，**不可折叠**，长 `errorChain` 会占满屏幕 |
| 两者 | 都不暴露 `status` / `requestId` / provider 路由 / turn·step / 等待时长 |

本插件在**轮次尾部**（`conversation.chat.turnTail`）加一个默认折叠的面板，只在「本轮有重试或有终态错误」时出现：

- 摘要一行：`本轮重试 3 次 · 最终失败 RATE_LIMIT`
- 展开后逐条列出，每条给全：来源（插件／官方）、`第 N/M 次`、错误码、HTTP、提供方、`第 N 轮 · 第 M 步`、等待毫秒、请求 id、**完整报错原文**

数据流：

```
llm/retry 事件 ─┐
                ├─→ auto-retry definition（target: chat）
turn/end(error) ┘        └─→ 每轮一个 hidden view node
                              └─→ turnDataSource(turn, 'auto-retry')
                                    └─→ 轮次尾部面板
```

折叠面板只用主题 token（`--dsw-alias-*` / `--dsw-static-*` / `--dsw-radius-*`），不 import `@deepseek-ai/dsh-client-ui-primitives`，样式随 fiber 卸载一起移除。

### 配置页

同一个浏览器半部还注册 `plugins.bundle.config`（key `dsh-plugin-auto-retry`），也就是组合包页面上的配置区。六个字段各一个控件：四个数字输入、一个总开关，加一组 code 开关。

它不做自己的校验逻辑——边界只是让输入框提示正确范围，真正的把关仍在 `readSettings()` 与 schema 那一层。保存时只提交变动过的字段：

```
{ op: 'set', path: ['retryableCodes'], value: ['RATE_LIMIT', 'TIMEOUT'] }
{ op: 'set', path: ['extraRetries'], value: 5 }
```

全部操作共用宿主读到的 `revision`，所以编辑期间发生的并发写入会让这次保存被拒绝，而不是被静默覆盖。

code 开关的列表顺序与「同一组 code」判断都不敏感：开关永远按目录顺序提交，所以仅仅重排不会产生一次写入。目录里被硬拒绝的 code 即使已经在配置里、也只会以「已勾选但禁用」的样子出现——页面如实报告配置，不会顺手把它删掉，因为读者没碰过的东西不该产生写操作。

组合包级的 slot 是**常驻**的：只要组合包在，配置区就在，无论宿主是否真的提供了 `auto-retry` 这个命名空间。所以页面区分三种状态——正在读取（`loading`）、不可写（`unavailable`，部署没提供这个命名空间，或本页只读）、就绪——前两种只说状态，不画表单：一个 Save 注定失败的输入框比一句说明更糟。

## 安全设计

### 三道闸

1. **`extraRetries`**（默认 `3`）——主闸。这是官方预算**之外**的额度，不是总数。
2. **接续退避**——重试间隔逐次拉长，给上游恢复时间。
3. **`enabled`**——随时可以掐断正在跑的重试链。

### 隐式保护

- 只重试白名单里的 code，且硬拒绝优先
- 尊重 `failure.providerRetryAfterMs`
- 同一个失败不会被我们调度两次（waterfall 是逐个 await 的）
- 非 error 的 turn end 一律不动
- 追加失败即放弃，不写日志以外的东西
- 等待可取消，fiber 卸载会中断并 drain

### 配置值不会被敲错一个数就失控

`.volatile()` 字段是从 Plugins 页面**直接写进 reference cell** 的，不走加载器的 `Config` 校验。所以 `readSettings()` 对每个字段做类型检查 + 钳制，**负数回落到默认值而不是 `0`**——`0` 是「关掉这道闸」，一个误输的负数不该有这个权力。

| 输入 | 结果 |
|---|---|
| `extraRetries: -1` / `99` / `2.5` / `'lots'` | 回落到默认 `3` |
| `extraRetries: 0` | 保留 `0`（显式不介入） |
| `initialDelayMs: -100` | 回落到默认 `1000` |
| `jitterRatio: -0.5` / `7` | 回落到默认 `0.2` |
| `retryableCodes: []` / `'RATE_LIMIT'` / `[1,2]` | 回落到默认列表 |
| `enabled: 'nope'` | 回落到默认 `true` |

`retryableCodes` 的类型检查里 `Array.isArray` 是**承重的**：一个裸字符串会走到 `String.prototype.includes`，任何子串都会匹配，一个白名单笔误就能悄悄授权没人列过的 code。

## 测试

```bash
npm test
```

五层：

| 文件 | 覆盖 |
|---|---|
| `test/policy.test.mjs` | 纯决策逻辑，直接喂普通对象，**不 import 任何 Cordis**。资格矩阵、硬拒绝优先、接续退避、provider 延迟钳制、policyKey 命名空间、官方进度读取 |
| `test/index.test.mjs` | 用 mock ctx 驱动真实的 `apply()`，断言 waterfall 契约（下游优先、终态让路）、持久事件顺序与字段、预算与接续、retryId 连续性、跳过分支、异常边界、生命周期 drain |
| `test/client.test.mjs` | stub `__ModuleLoader__` 捕获 factory，断言事件折叠、hidden 节点、摘要文案、字段映射、来源标注、**AUTH/QUOTA 原文不被替换**、配置页的开关与暂存提交 |
| `test/contract.test.mjs` | **加载契约**，不测行为，只测「装上会不会炸」。复刻加载器 `jc()` 的逐字逻辑，检查 `dsh.client` / `./client` / `files` 全指向真实文件，并交叉核对配置命名空间与 patch 行 id |
| `test/slots.test.mjs` | 对着应用里**真实的** `SlotCore` 注册一次，断言它接受这份 options、生成出的 entry 形状（`options.key` / `locale` / `inject`）与渲染器读到的字段一致。应用没装时自动跳过 |

> `test/slots.test.mjs` 直接读安装目录里的 `app.asar`，所以它在别的机器上会跳过（`DSH_APP_ASAR` 可以指向别的安装）。这么做是因为「mock 接受」和「真实注册表接受」是两个问题：一个只有 mock 通过、注册表拒绝的形状，在浏览器里表现为配置区根本不出现。

> `npm test` 就是 `node --test "test/**/*.test.mjs"`，和 CI、`prepublishOnly` 用的是同一条命令。`--test-isolation=none`（`npm run test:in-process`）是给**禁止子进程的沙箱**准备的逃生口——`node --test` 默认要给每个测试文件起子进程，而 DSH 自己的文件沙箱不允许；这个 flag 需要 Node 24+，所以它不在默认命令里，否则声明 `engines: >=22` 的包会在 Node 22 上直接报 `bad option`。

## 已知限制

- **适配器已经砍掉的原文无法还原。** `kilo-gateway` 做 `detail.slice(0, 300)`，pi-ai 也各有截断。面板保证的是「宿主记录下来的部分完整呈现」，不是「提供方原始响应完整呈现」。
- **工具／middleware／扩展失败不在范围内。** 它们根本不进 `agent/request-error`。harness **刻意**不自动重试结果不明的操作，且在关闭失败步骤前会合成 `TOOL_OUTCOME_UNKNOWN` 结果，从轮次层补重试会有副作用重复的风险。
- **直接 `ctx.llm.stream()` 的消费方不在范围内。** 会话标题生成、压缩摘要器没有 agent 轮次，没有可挂的边界。
- **计数器随日志折叠，但进程重启会重开一个 step。** 一个 turn 不会跨重启继续，所以这不是问题。
- **不感知子代理。** agent 作用域 dispatch 覆盖所有 agent，子代理的失败也会被接手——与官方 `dsh-llm-retry` 一致。
- **`QUOTA` / `INVALID_REQUEST` / `UNKNOWN` 默认不重试。** 它们既可能瞬时也可能终态，需要你按部署显式开启。

## 故障排查

**装完没反应。** 本插件不是 `required` bundle，组合失败不会写启动日志。先在 Plugins 页面确认 `auto-retry` 出现，再看 `ctx.logger` 有没有 `auto-retry:` 开头的行。

**失败了但没有重试。** 依次检查：`enabled` 是否为 `true`；`extraRetries` 是否已到顶（到顶会写一条 warn）；失败 code 是否在白名单里（`UNKNOWN` / `QUOTA` / `INVALID_REQUEST` 默认不在）；是否是 `AUTH` / `CONTEXT_WINDOW_EXCEEDED` / `ABORTED`（硬拒绝，永远不重试）。

**官方明明会重试，插件却没动静。** 这是对的。官方决定重试时不会调用 `next()`，我们收不到那次失败——**这正是「不冲突」的实现方式**。

**面板没出现。** 面板只在「本轮有重试或有终态错误」时渲染。如果那一轮既没重试也成功了，尾部就是空的。另外确认客户端半部已注册：`package.json` 的 `dsh.client.platform` 为 `web`，且 profile 里装了 `@deepseek-ai/dsh-client-ui-conversation`。

**装完 dsh 启动就崩，`import` 阶段报错。** 有一个真实踩过的坑：**npm 的 `node_modules` 内容和 npm 缓存之间存在引用关系，删掉缓存会把装好的包打成坏的重解析点**——目录还在，`stat` 报 `size=0`，`readdir` 直接 `ENOENT`。所以装好之后**不要删 npm 缓存**；要清理就删掉 `node_modules` 重新装。

## 开发

```bash
npm install --ignore-scripts
npm test
```

代码结构：

```text
lib/policy.js    纯决策逻辑，零框架依赖 —— 什么时候该重试、等多久
lib/index.js     宿主半部 —— 读 waterfall、找官方进度、持久事件、等待
client.js        客户端半部 —— 事件折叠、轮次尾部折叠面板、样式、字典
cordis.patch.yml 组合声明
```

把决策逻辑剥到无框架依赖的 `policy.js` 里，是为了让「什么时候该发」这条主链路能被裸 node 直接验证，不需要启动 harness。这是整个包最容易出错、也最难在集成环境里观察的一层。

`client.js` 是浏览器格式的产物：它通过 `window.__ModuleLoader__.load` 注册一个惰性工厂，而不是 export。`test/client.test.mjs` stub 掉那个全局来驱动它。

## License

[MIT](./LICENSE) © 2026 Rina
