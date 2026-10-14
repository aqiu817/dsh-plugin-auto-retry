# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-15

首个公开版本。

### Added

- 宿主侧 `agent/request-error` **下游** listener：只接手官方
  `@deepseek-ai/dsh-llm-retry` 主动放弃的模型请求失败。官方决定重试时不会调用
  `next()`，因此**不存在双重试**
- 失败在**打开的 step 内部**重跑：同一份持久历史、不合成 `TOOL_OUTCOME_UNKNOWN`、
  不诱导重跑副作用工具、尊重同一个 `signal`、不注入伪造用户消息
- **接续官方退避曲线**：官方没试过时从 `initialDelayMs`（默认 1s）起步；官方试过时
  用官方自己的退避参数，把指数位置推到 `official + ourRetry`，在它最长的那次之后再推一格
- 计数复用官方 `llmRetry` session projection，policyKey 以 `["auto-retry"` 命名空间
  隔离，官方与我们的预算各自独立
- 持久事件复用官方词汇：等待前追加 `llm/retry`，返回前追加 `llm/retry-started`；
  追加失败即放弃重试，不留不可见的待处理重试
- 配置面六个字段全部 `.volatile()`：`enabled`、`extraRetries`（默认 3）、
  `initialDelayMs`、`maxDelayMs`、`jitterRatio`、`retryableCodes`
- **硬拒绝集合**（不可配置，优先于白名单）：`AUTH`、`MISSING_CREDENTIAL`、
  `INVALID_CREDENTIAL`、`NO_ADAPTER`、`INVALID_MODEL`、`INVALID_CONFIG`、
  `CONTEXT_WINDOW_EXCEEDED`、`IMAGE_OFFLOAD_REQUIRED`、`ABORTED`
- 默认白名单含两个适配器兜底 code（`PROVIDER_ERROR`、`PI_AI_ERROR`），它们此前
  **一次都不会被重试**
- `QUOTA` / `ACCOUNT_QUOTA` / `INVALID_REQUEST` / `UNKNOWN` 保持 opt-in
- 尊重 `failure.providerRetryAfterMs`，钳到 `maxDelayMs`
- `readSettings()` 对每个字段做类型检查与钳制，**负数回落到默认值而非 `0`**；
  白名单检查里 `Array.isArray` 是承重的，防止裸字符串走 `String.prototype.includes`
  造成子串匹配
- 客户端半部：`auto-retry` conversation definition 把 `llm/retry` 与终态
  `turn/end` 错误折叠成每轮一个 hidden node，并在 `conversation.chat.turnTail`
  渲染**默认折叠**的面板
- 面板展开后给出：来源（插件／官方）、`第 N/M 次`、错误码、HTTP、提供方、
  `第 N 轮 · 第 M 步`、等待毫秒、请求 id、**完整报错原文**
- 面板**绕过**原生 `failureMessage()` 的替换，`AUTH` / `QUOTA` 也显示原文
- 样式只用主题 token，随 fiber 卸载移除；文案走 `auto-retry` locale 命名空间
- 客户端半部注册 `plugins.bundle.config`（key = 包名 `dsh-plugin-auto-retry`），
  在 Plugins 页面这个组合包自己的页面上直接给出配置区（比行级少一次点击）：
  四个数字输入、一个总开关，加一组 code 开关，改动暂存到保存，只提交变动字段，全部挂在宿主
  读到的同一个 revision 栅栏下
- `retryableCodes` 改成**内置目录 + 开关**，不再要求手填：分「默认开启／按需开启／
  永不重试」三组渲染，第三组以**禁用**开关呈现（硬拒绝是策略常量，不是偏好）。
  开关初始状态取自**已接受的值**而非目录默认值；目录之外的 code 走「其他错误码」
  文本框兜底
- 开关不能把白名单清空：宿主 `codesWithin()` 把空列表当笔误并回落到默认白名单，
  所以页面在暂存阶段就提示、保存时直接拦下，避免「页面说一个都不重试、插件实际
  还在重试 7 个」。表达「不介入」请用 `enabled: false` 或 `extraRetries: 0`
- 配置页区分 `loading` / `unavailable` / 就绪三种状态：前两种只说明状态、不画表单，
  避免出现一个 Save 必然失败的输入框
- 配置页从 `configForms` 服务取命名空间 `auto-retry` 的表单（组合包级 slot 不会
  递给占位者表单对象），并且**单独开一个 fiber** 去要这个服务，而不是写进浏览器
  半部的 `inject`——否则一个没装设置包的部署会连重试面板一起不加载
- 五层测试：纯决策、宿主接线、客户端折叠与字段映射（含配置页的开关与暂存提交）、
  加载契约，以及对着应用里真实 `SlotCore` 注册一次的注册表契约（应用没装时自动跳过）

### Notes

- `turn/end` 的 error reason 字段名是 **`error`** 而不是 `failure`
  （`TurnEndReasonMap`：`error: { kind: 'error'; error: LlmFailure }`）。读错字段名会
  让每个终态错误渲染成空块，`client.test.mjs` 有一条专门的用例钉住它
- 官方投影 key 的形状是 `JSON.stringify([provider, policyKey])`，命名空间标记在
  **第二个元素**里。按外层 key 判断归属永远不会命中，因为外层 key 对官方和我们
  都以 provider 开头
- **宿主侧的 `Config` schema 不会自动在 Plugins 页面产生配置控件。** 配置区只在
  某个插件占住一个 slot 时出现：组合包级 `plugins.bundle.config`（key = 包名）渲染
  在组合包页面描述与行之间，行级 `plugins.row.config`（key = `<包名>#<行 id>`）才
  让那一行多出一个**配置**控件并打开自己的页面。`configLedgerSource` 从
  `keysOf('plugins.bundle.config')` 与 `keysOf('plugins.row.config')` 分别读两份账本。
  只有宿主半部的插件因此看不到配置入口
- **组合包级 slot 不传 `form`**：页面只在行级调用点构造 `{ state, mutate }`
  （`renderSlot('plugins.row.config', { view: 'page', form })`），组合包级只有
  `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`。
  所以占位者要自己从 `configForms` 服务取表单；该服务的 `get(id)` 返回一个带
  `getSnapshot`/`subscribe`/`mutate` 的控制器，视图用 `useSyncExternalStore` 跟随它
- **组合包页面在挂载时还没有配置值**（`persistence === 'host'` 时状态先是
  `loading`，等共享 describe 镜像回答）。所以草稿不能在建挂载时快照：`staged`
  保持 `null`，控件显示的就是已接受的值，读者第一次编辑才把当时的表单整体暂存下来。
  否则读者会看到一屏空输入框，而 Save 只会报「有字段无法解析」
- 声明 `exports` 的包必须额外暴露 `"./package.json"`，否则
  `require.resolve(name + '/package.json')` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，
  loader 读不到 `dsh.bundle.patch` 与 `dsh.client`。官方每个声明了 `exports` 的包
  都这么做
- `RetryConfigPanel` 的 hook 必须在提前 return **之前**调用：行级 seat 会对同一条目
  分别请求 `summary`（该行没有描述时的一行说明）与 `page` 两个视图，hook 放在分支
  之后会在视图切换时改变 hook 数量。本插件占的是组合包级 seat（只请求 `page`），
  但组件保留了两个视图的回答能力，所以这条约束照旧
- 适配器在源头就可能截断原文（`kilo-gateway` 做 `detail.slice(0, 300)`）。面板保证
  的是「宿主记录下来的部分完整呈现」，不是「提供方原始响应完整呈现」
- 工具／middleware／扩展失败不在范围内：它们根本不进 `agent/request-error`，且
  harness 刻意不自动重试结果不明的操作

[Unreleased]: https://github.com/aqiu817/dsh-plugin-auto-retry/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aqiu817/dsh-plugin-auto-retry/releases/tag/v0.1.0
