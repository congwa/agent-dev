# agent-loop

> `@deepseek-ai/dsh-agent-loop` · bundle：`base` · 配置树 id：`agent-loop` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：整个 harness 里**唯一**含具体循环逻辑的包——它实现 [agent](./dsh-agent.md) 定义的 `Agent` 接口，驱动 session/turn/step 生命周期，并把自己注册成 `ctx.agents` 的工厂。

README 原文（`packages/core/agent-loop/README.md:7`）：

```text
This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension points — new behavior goes into plugins, not here.
```

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:436`：

```yaml
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []
```

base 层刻意留空——启动时不创建任何 agent；raw overlay 可以在这里创建，Web 则按客户端请求创建 session。`web-app` 和 `headless` 都没有覆盖这一行。

`inject` 不写在 YAML 里，是包自己声明的硬依赖（`src/index.ts:297`）：

```ts
static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
```

五个全是接口服务，缺一个这一行就不激活（`docs/config-catalog.md` 的 `Requires:` 行同样列这五个）。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.agentLoop`（`AgentLoop`） | `src/index.ts:296`、`:320` |
| 工厂 | `ctx.agents.setFactory(this)` | `src/index.ts:350`；此后 `ctx.agents.create()` / `resume()` 才可用 |
| prompt 变量 | `provider`、`model`、`cwd` | `src/index.ts:351`–`:353`，值取自 `agent.options` 与 `agent.session.header.cwd` |
| settings 段 | `agent-loop`（只含 `maxParallelToolCalls`） | `src/index.ts:236`、`:250`、`:335`；Web 设置页标签是 "Parallel tool calls"（`packages/client/ui-settings-plugins/src/client/locales.ts:42`） |
| 事件派发（emit） | `agent/inbox/inserted`、`agent/inbox/discarded`、`agent/inbox/claimed`、`agent/status`、`agent/error` | `src/agent.ts:88`–`:90`、`:109`、`:206` |
| 事件派发（emit） | `agent/session-start` | `src/index.ts:567`，走 `emitAgentEvent()` |
| 事件派发（**waterfall**） | `agent/pre-step`、`agent/request`、`agent/request-error` | `src/agent.ts:234`、`:438`、`:355` |
| 事件派发（serial） | `agent/turn-stopping` | `src/agent.ts:296` |
| 事件声明（emit） | `agent-loop/config-start-failed` | 本包自己声明的一条，`src/index.ts:183` |

上面除最后一条外都由 [agent](./dsh-agent.md) 声明，这里只负责派发（`docs/event-producer-consumer.md:14`–`:23`）。

### 一个 step 的真实顺序（`src/agent.ts:225`–`:243`）

1. `inbox.claim(target, turn)` 先把批次从 inbox 里删走（`:229`）；
2. **然后**才调 `ctx.systemPrompt.assemble(assembleContextFor(this, signal))`（`:230`）；
3. 渲染 dynamic contexts，`RuntimeContextProjection.project()` 决定要不要产出一条快照消息（`:232`–`:233`）；
4. 最后跑 `agent/pre-step` waterfall（`:234`），**默认值**是 `claimed` 后面接那条 runtime-context 快照（`:236`–`:239`）。

这个顺序解释了 [agent-instructions](./dsh-agent-instructions.md) 为什么把自己的消息折在"claimed 批次之后、runtime context 之前"——它是在 waterfall 里改这个默认批次。runtime-context 快照的 source 署名写死成 `@deepseek-ai/dsh-system-prompt`（`src/runtime-context.ts:12`），清空时发一条固定文案 `Current runtime context: none. Earlier runtime-context snapshots no longer apply.`（`src/runtime-context.ts:13`）。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `maxParallelToolCalls` | `number`（整数 ≥ 1） | `10`（`src/constants.ts:6`，schema `src/index.ts:301`） | 每个 agent 每个 step 的 parallel-safe 调用滚动池上限；`1` 即串行 |
| `agents` | 数组 | `[]`（schema `src/index.ts:310`，bundle 也写了 `[]`） | 插件启动时创建/恢复的 agent |
| `agents[].id` | `string` | 必填（`z.string().required()`，`src/index.ts:303`） | 稳定标签，也是新 session id 的前缀 |
| `agents[].provider` / `.model` | `string` | 无 | 模型调用两者都必须有，否则 `agent/request` 得补上 |
| `agents[].maxTokens` | `number`（正整数） | 无 | 每次会话请求的输出 token 上限，记进 request header |
| `agents[].sessionId` | `SessionId` | 无 | 固定身份；首次创建，重挂时若已有持久化则恢复其历史（`src/index.ts:358`–`:359`） |
| `agents[].resumeSessionId` | `SessionId` | 无 | 恢复既有持久化 session，与 `sessionId` 互斥（`src/index.ts:283`） |
| `agents[].cwd` | `string` | 无 | 只对新建 session 生效 |

`maxParallelToolCalls` 是 `agent-loop` settings 段的**全部**内容：用户层改它能在不重启的情况下影响下一组工具调用，而非正整数的值在写入时就被拒（`README.md:52`，实现见 `src/index.ts:339`）。`agents` 故意不进 settings——它在服务启动时被消费一次，存进去只会看起来像生效了（`src/index.ts:240`–`:243`）。

## 模型看得见什么

`Model Experience` 说：每个 step 发出的是渲染后的 per-agent system prompt、可见工具 schema、以及该 session 的派生消息；循环只提供 `provider`/`model`/`cwd` 三个变量值，`but no additional fixed prose`（`README.md:91`）。

唯一由它产生的模型可见文本是取消后的补洞：被取消而没派发出去的工具调用，在重放时错误码是 `ABORTED_BEFORE_DISPATCH`，结果文本是 `Error: tool call aborted before dispatch`（`README.md:119`）。这类合成结果是 append-only，不破坏已有 KV cache 条目（`README.md:127`）。

## 什么时候你会想换掉它 / 怎么换

- **调并发**：patch `maxParallelToolCalls`，或直接在 harness home 下的 `settings.yaml`（`$DSH_HOME/settings.yaml`，默认路径见 `packages/settings/settings-file/README.md:11`）的 `agent-loop:` 段里改（热生效）。
- **启动即拉起 agent**：往 `agents` 里塞一行；headless/raw overlay 是典型场景。
- **整个换掉循环**：README 的立场是"新行为进插件，不进这里"。真要换，实现 `Agent` 接口后用 `ctx.agents.register()` 注册，并把这一行 `disabled: true`——但注意 `ctx.agents.create()`/`resume()` 会因为没有工厂而 reject，Web 那套按需建 session 的流程就断了。

## 坑与边界

来自 `README.md:131`–`:134`：

- **分类是一元的**——安全性取决于和兄弟调用/资源比较的工具必须保持 exclusive。
- **config 标签默认每次都是新的**——不写 `sessionId` 时每次启动都生成 `${id}-session-<uuid>`；要"有就恢复没有就新建"必须给显式稳定的 `sessionId`。
- **config 建的 agent 没有 per-agent persona 字段，也没有 setup 钩子**——只能用部署 persona；按 agent 的 persona/工具组合只有走 `ctx.agents.create()` / `resume()` 的编程接口。
- **没有内建 turn 预算**——工具调用或 steering 会一直延续当前 turn，想给失控 turn 兜底得从 `agent/turn-stopping` 之类的扩展点主动 cancel。

读源码补充：`provider`/`model` 缺失时抛的是明文错误 `agent "<id>" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`（`src/agent.ts:444`）；同一份 config 里两个 agent 用同一个精确 session 身份会在加载期直接抛错（`src/index.ts:289`）。
