# system-prompt

> `@deepseek-ai/dsh-system-prompt` · bundle：`base` · 配置树 id：`system-prompt` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：system prompt 的装配注册表——插件往里塞有序 section、工具 schema 和具名变量，[agent-loop](./dsh-agent-loop.md) 每个 step 装配一次并渲染成完整 prompt；它自己拥有固定的 harness 身份句和全局部署 persona。

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:429`：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    persona: ''
```

base 层刻意把 persona 留空（"部署人格是部署方的选择"，注释在 `:427`–`:428`）。两个 mode bundle 都各自重述了完整值：

`packages/bundle/web-app/cordis.patch.yml:16` 与 `packages/bundle/headless/cordis.patch.yml:7` 用的是同一句：

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

`{{model}}` / `{{cwd}}` 这两个变量由 [agent-loop](./dsh-agent-loop.md) 注册（`packages/core/agent-loop/src/index.ts:351`–`:353`）——persona 是模板，未知或已注册但无值的引用会**严格抛错**而不是渲染成空（`README.md:36`）。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.systemPrompt`（`SystemPrompt`） | `src/index.ts:338`、`:354` |
| prompt 段 | `harness:identity`，order `-100` | 文本恒为 `You are an AI agent powered by DeepSeek Harness.`；`includeHarnessIdentity: false` 时不注册（`src/index.ts:357`–`:362`） |
| prompt 段 | `deployment:persona`，order `0` | 取 config 的 `persona`（`src/index.ts:364`–`:369`；名字/order 常量在 `:128`、`:131`）；空串在渲染时被丢弃（`README.md:13`） |
| runtime context 抑制 | `includeRuntimeContext: false` ⇒ `suppressRuntimeContext()` | `src/index.ts:370` |
| 事件声明 + 派发（**waterfall**） | `system-prompt/assemble` | 声明 `src/index.ts:31`、派发 `:532`–`:533`；scope 过滤 |
| 事件声明 + 派发（emit） | `system-prompt/change` | 注册表变动时发（`src/index.ts:37`、`:349`），不做 scope 过滤（`README.md:29`） |

`system-prompt/assemble` 是**改 prompt 的正门**：它能改 sections、tools、variables，运行在 complete-section 约束生效之前。已知监听方是本包自己、[agent](./dsh-agent.md)（`installModelSelection` 用它把选定的 provider/model 写进变量）和 `agent-presets`（`docs/event-producer-consumer.md:52`）。

### 服务面（`README.md:20`–`:25`）

| 方法 | 作用 |
|---|---|
| `section(section)` | 贡献有序段；层 = 调用方 scope，`agent.ctx` 只影响那一个 agent 并遮蔽同名全局段 |
| `context(context)` | 贡献动态 runtime context，每次装配求值一次 |
| `suppressRuntimeContext()` | 抑制该 scope 的全部动态 context，多次注册独立叠加 |
| `tools(provider)` | 贡献工具 schema；返回 `{ schemas, knownNames? }` |
| `variable(name, provider)` | 贡献 `{{name}}` 变量；scoped 变量遮蔽同名全局变量 |
| `assemble(context?)` | 装配一次，跑完 waterfall 后再落 complete-section 与 suppressor 约束 |

section 的 order 分带约定：`-100` 是 harness 身份，`0` 是部署 persona，工具指引占 `100–199`（`README.md:34`）。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `includeHarnessIdentity` | `boolean` | `true` | 是否加那句 order `-100` 的固定开场白 |
| `includeRuntimeContext` | `boolean` | `true` | 为 `false` 时 context provider 根本不求值，连 waterfall 监听者加的 context 也在事后丢弃；其它服务与其强制逻辑照常 |
| `persona` | `string` | `''`（base）/ 上面那句（web、headless） | 唯一由 config 编写的 prompt 片段，渲染成 order 0 的 `deployment:persona`；空 ⇒ 渲染时丢弃 |
| `toolOrder` | `string[]` | 省略（⇒ 按名字字典序） | 显式的模型可见工具顺序，必须恰好含一个 rest 条目 `<unlisted-tools>`（`TOOL_ORDER_REST`，`src/index.ts:140`） |

schema 默认值在 `src/index.ts:339`–`:345`；`toolOrder` 刻意保留"未设置"状态，源码注释的理由是空数组缺 rest 标记（`src/index.ts:343`）。

## 模型看得见什么

默认每次装配的开头是那句身份行，然后是 persona 和按 order 排列的插件段，全部经过严格变量插值。空段消失；scoped 段和变量可以为单个 agent 遮蔽全局值。有一个 section 声明 `complete: true` 时，它成为**整个** system prompt，而 waterfall 产出的 contexts、tools、variables 仍保留（`README.md:55`）。

固定开场白原文（`README.md:60`，实现 `src/index.ts:361`）：

```markdown
You are an AI agent powered by DeepSeek Harness.
```

`renderPrompt` 是严格的：未知引用、已注册但无值的引用、残缺的 `{{…}}` 组、以及 `{{{model}}}` 这种后面还跟着 `}}` 的畸形写法都会抛错——"fail loud beats shipping a malformed prompt"；而孤零零一个后面再无 `}}` 的 `{{` 原样透传，替换进来的值不会被二次扫描（`README.md:36`）。

token / KV cache：身份句是启用时的固定每请求开销；persona 与插件文本按渲染内容逐请求重复。只要身份、persona、变量、段文本与顺序渲染结果一致，前缀就稳定，任何改动都可能从第一个变化的 token 起让 KV cache 失效（`README.md:65`、`:69`）。

## 什么时候你会想换掉它 / 怎么换

它是被一大批插件硬 inject 的核心服务：tools（`packages/core/tools/src/index.ts:788`）、agent-loop（`packages/core/agent-loop/src/index.ts:297`）、tool-fs（`packages/fs/tool-fs/src/index.ts:22`）、tool-fs-search（`packages/fs/tool-fs-search/src/index.ts:70`）、tool-jobs（`packages/jobs/tool-jobs/src/index.ts:22`）等，不存在"换掉"的场景，只有改配置：

- **改部署人格**：patch 这一行的 `persona`。
- **按 agent 改人格**：不要动这一行，改用 `@deepseek-ai/dsh-persona`——它复用本包导出的 `PERSONA_SECTION` / `PERSONA_ORDER`（`packages/preset/persona/src/index.ts:23`），在挂载它的 scope 上注册同名段（`:61`–`:66`）；源码注释要求那必须是 agent scope，否则会和注册表自身的 persona 注册冲突（`:56`–`:57`）。web profile 的 preset 就是这么写的（`apps/cli/config/agent-presets/standard/agent.cordis.yml:24`）。
- **固定工具顺序**：加 `toolOrder`，别忘了那一条 `<unlisted-tools>`。
- **兼容型部署要自己写完整 prompt**：`includeHarnessIdentity: false` + 一个 `complete: true` 的 section（`dsh-persona` 也有 `complete` 开关，`packages/preset/persona/src/index.ts:41`–`:42`）。

## 坑与边界

来自 `README.md:87`–`:90`：

- **部署方写的 prompt 文本只能来自 config / 组合**——没有面向最终用户的 prompt 编辑 API。
- **没有字面 `{{…}}` 的转义语法**——每个完整组都会被插值，转义要等真有 prompt 需要时再做。
- **`toolOrder` 配错在装配时才炸（第一个 turn），不是启动时**——只有形状违规（缺/多 rest 条目、重复项）在加载时抛错（`src/index.ts:146`–`:155`）；名字对不上要到 `assemble()` 才 reject（`src/index.ts:170`–`:173`），在 shipped loop 下表现为该 turn 在发请求之前就失败。
- **同 order 的 section 靠注册顺序 tie-break**——那是插件加载顺序的产物，确定性依赖"用不同 order 带"的约定，不像工具顺序那样被规范化。
