# session-checkpoint-policy

> `@deepseek-ai/dsh-session-checkpoint-policy` · bundle：`base` · 配置树 id：`session-checkpoint-policy` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对。出处收在文末脚注。

**一句话**：纯拦截型的"语义耐久策略"——在三个位置各插一次 `ctx.sessions.flush()`，把"什么时候必须落盘"这个决定从持久化后端里拆出来单独持有。

三个位置是：模型 adapter 收到请求之前、顶层工具体可能产生外部副作用之前、每个 `agent/pre-step` 边界上。这三处不是随手挑的——都是"一旦发生就无法收回"的动作发生前的最后一刻：请求一旦发给模型、工具一旦真的动手、下一步一旦派生出去，都覆水难收。

## 它在树上长什么样

这一行写在 base bundle 的 patch 里[^1]：

```yaml
- id: session-checkpoint-policy
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
```

行注释写的是 `Durability checkpoints before each model request and top-level dispatch.`[^1]。这一行没有 `config`，`inject` 也不在 YAML 里——它写在代码里。

## 它注册了什么

它不注册服务、不注册工具、不注册命令、不注册 prompt 段。全部家当就是三个 waterfall 监听器，外加一份 inject 声明。

| 类型 | 名字 | 说明 |
|---|---|---|
| plugin name | `session-checkpoint-policy` | 声明在插件入口[^2] |
| inject | `['llm', 'sessionPersistence', 'sessions', 'tools']` | `sessionPersistence` 在列表里，意味着**没挂持久化后端这一行就不会激活**[^2] |
| 事件监听 | `llm/stream`（**waterfall**） | 懒包装下游流：先 `await ctx.sessions.flush(session)` 再 `yield* next()`，下游流在事件耐久之前根本不构造[^3] |
| 事件监听 | `tools/execute`（**waterfall**） | 只对**有 agent 且无 parent** 的顶层调用生效；flush 之后若已取消，返回规范的 aborted 结果，**不进工具体**[^4] |
| 事件监听 | `agent/pre-step`（**waterfall**） | 每次请求派生之前，把上一 step 提交的响应/结果批次持久化[^5] |

三个监听器长得是同一个形状：

```
on(事件, waterfall):
    if 不该管这一次:        return next()      // 三条屏障各有各的豁免条件
    await ctx.sessions.flush(session)          // 拒绝 → 抛出去，不 next()
    return next()                              // 只有落盘成功才放行下游
```

因为都是 waterfall，所以它**能拦截**：任何一个 flush 拒绝都会 fail-closed。

`llm/stream` 的特别之处在于"懒"——包装的是生成器，flush 排在 `yield*` 之前，下游那条流在事件落盘之前压根不存在[^3]：

```
async function* wrapped():
    await ctx.sessions.flush(session)
    yield* next()
```

`tools/execute` 的豁免条件写死在一个判断里，非顶层调用直接放行[^4]：

```
if exec.agent === undefined || exec.parent !== undefined:
    return next()          // 没有 agent 的、或有 parent 的嵌套调用，都不设检查点
await ctx.sessions.flush(session)
if 已取消: return 规范的 aborted 结果    // 不进工具体
```

`agent/pre-step` 没有这类豁免分支，每次派生前都会等一次 flush[^5]。

它插在管线的这些位置上：`llm/stream` 的包装是懒的；`tools/execute` 的包装在 pre-execute 策略与守卫**之后**；嵌套的工具派发复用外层模型可见调用的检查点，不重复插一次[^6]。

三处屏障各管一段边界，任何一处 flush 被拒都是各自范围内的 fail-closed，不牵连另外两处：

```mermaid
flowchart TD
    A["<b>turn 内某个动作即将发生</b>"]
    B["<b>模型请求前</b><br/>llm/stream：懒 flush 屏障"]
    C["<b>顶层工具派发前</b><br/>tools/execute：仅无 parent 的调用"]
    D["<b>下一步开始前</b><br/>agent/pre-step：持久化上一批响应/结果"]
    E["<b>flush 成功</b><br/>继续往下执行"]
    F["<b>flush 被拒</b><br/>该边界的动作不执行"]

    A --> B
    A --> C
    A --> D
    B -- "成功" --> E
    C -- "成功" --> E
    D -- "成功" --> E
    B -- "失败" --> F
    C -- "失败" --> F
    D -- "失败" --> F

    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class A entry
    class B,C,D main
    class E data
    class F danger
```

## 配置项

无配置项。README 称之为 `zero-config function plugin`[^7]。

它的行为完全由三个事件边界和 `ctx.sessions.flush()` 的语义决定；真正的批量参数在持久化后端那边——见 [session-persistence-jsonl](./dsh-session-persistence-jsonl.md) 的 `writeBatchMaxDelayMs`。

## 为什么要单独一个插件

持久化和检查点调度**故意是两个 Cordis 插件**[^8]。分工是这样的——

| 谁 | 干什么 |
|---|---|
| 后端 | 为 `session/event` 起有界的后台批次，并把每次 `session/flush` 变成立即的静默屏障 |
| 这个策略 | 选择请求、工具派发、下一步这三条屏障线 |

只加载后端不加载策略是合法组合，但崩溃时可能丢掉还在批窗里或还在写的事件[^8]。第一方持久化 app 与 runtime 两个插件都显式挂，特化部署可以故意省略或替换策略。

失败语义分两种，别混[^9]：

| 哪条屏障被拒 | 后果 |
|---|---|
| 模型边界、工具边界 | fail-closed——adapter 和顶层工具体都不会跑 |
| step 边界 | 在下一个请求开始前让整个 turn 失败 |

并发的工具检查点共用 session store 序列化的持久化排干，不会重复 seq。

取消时的规范结果由本包物化[^10]：

| 字段 | 值 |
|---|---|
| `isError` | `true` |
| content 文本 | `Error: tool call aborted before dispatch` |
| `error.message` | `tool call aborted before dispatch` |
| `error.info` | `{ name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH }` |

## 模型看得见什么

**本插件不加任何 prompt 或工具 schema**[^11]。

它唯一间接影响模型的路径要绕一大圈：工具检查点之后、结果之前发生硬崩溃，会在日志里留下一个耐久的未配对 call，恢复时由 [session](./dsh-session.md) 补上模型可见的 `TOOL_OUTCOME_UNKNOWN` 结果——该文案允许只读/幂等工作重试，有副作用则要求先核验状态或请用户确认。

token 效果：检查点成功时零 token、不改请求；恢复时为平衡被打断的转录多出一条短的 tool-result message。KV Cache：修复结果追加在可复用前缀之后，不使更早的缓存条目失效[^12]。

## 什么时候你会想换掉它 / 怎么换

两种改法。

**一、关掉它**（README 明确背书这种组合[^8]）。bundle 里的行在 patch 层删不掉，只能禁用：

```yaml
- id: session-checkpoint-policy
  disabled: true
```

后端仍然按自己的批窗写盘，但崩溃可能丢掉批窗内的事件。适合把吞吐看得比"每次工具派发都可回溯"更重的批处理场景。

这里有个坑：`config` 不能停一行，`disabled` 才能[^13]。

**二、换成自己的策略插件**。它没有 provide 任何服务，只是三个 waterfall 监听器，因此"替换"就是禁用这一行、再 `insert` 一个挂在同样三个事件上按你的规则 flush 的新插件[^14]。

别想着直接改本行的 `name`——那会因 name mismatch 被整条跳过[^14]。

另一个方向的调节旋钮不在这里：想缩小"两次语义检查点之间"的丢失窗口，调 [session-persistence-jsonl](./dsh-session-persistence-jsonl.md) 的 `writeBatchMaxDelayMs`。

## 坑与边界

三条来自 README[^15]：

- **它耐久记录的是执行意图，不是通用的 exactly-once 效果**。有副作用的工具应当在 provider 支持时把 `exec.callId` 当幂等键传下去。
- **流式 `assistant/chunk` 没有逐 chunk 检查点**。有界后台批次通常会在下一个语义检查点之前把它们持久化，但硬崩溃可能丢掉当前内存批次或正在进行的写。
- **一个已持久化但无结果的调用无法证明它的外部效果是否完成**，所以恢复只记录"结果未知"，不自动重试。

读源码补充一条 README 没写的：`llm/stream` 上的包装只在 `options.sessionId` 存在**且**该会话还在 store 里时才生效，否则直接 `next()`[^16]。也就是说，非会话绑定的辅助模型请求（例如标题生成）不会被它拦。

回到开头那句话：三处屏障管的是"什么时候必须落盘"，至于"批多大、多久落一次"，那是持久化后端自己的事——两者故意分开成两个插件，也故意不共享同一个故障域。

---

## 出处

[^1]: bundle 行：`packages/bundle/base/cordis.patch.yml:355`；行注释见同文件 `:354`。
[^2]: plugin name 声明：`packages/session/session-checkpoint-policy/src/index.ts:15`；inject 声明见同文件 `:18`。
[^3]: `llm/stream` 监听器：`packages/session/session-checkpoint-policy/src/index.ts:64`–`68` 与 `:34`–`37`；waterfall 派发模式定义见 `docs/event-producer-consumer.md:39`。
[^4]: `tools/execute` 顶层调用判定：`packages/session/session-checkpoint-policy/src/index.ts:71`；取消分支见同文件 `:70`–`75` 与 `docs/event-producer-consumer.md:56`。
[^5]: `agent/pre-step` 监听器：`packages/session/session-checkpoint-policy/src/index.ts:79`–`82` 与 `docs/event-producer-consumer.md:18`。
[^6]: 嵌套的工具派发复用外层模型可见调用的检查点：`packages/session/session-checkpoint-policy/README.md:21`。
[^7]: "zero-config function plugin"：`packages/session/session-checkpoint-policy/README.md:9`。
[^8]: "持久化和检查点调度故意是两个 Cordis 插件"、以及只加载后端不加载策略这一合法组合的说明：`packages/session/session-checkpoint-policy/README.md:19`。
[^9]: 失败语义分两种：`packages/session/session-checkpoint-policy/README.md:23`。
[^10]: 取消时的规范结果物化：`packages/session/session-checkpoint-policy/src/index.ts:41`–`50`。
[^11]: "本插件不加任何 prompt 或工具 schema"：`packages/session/session-checkpoint-policy/README.md:31`。
[^12]: token 与 KV Cache 效果说明：`packages/session/session-checkpoint-policy/README.md:33`–`39`。
[^13]: patch 的三种形态（`config` 不能停一行、`disabled` 才能）：`packages/boot/app-boot/src/profile.ts:127`–`130`。
[^14]: `insert` 语义：`vendor/include/src/index.ts:80`–`95`；name mismatch 时整条 patch 被跳过，见同文件 `:116`–`119`。
[^15]: 坑与边界三条：`packages/session/session-checkpoint-policy/README.md:41`–`45`。
[^16]: `llm/stream` 包装仅在 `options.sessionId` 存在且该会话还在 store 里时才生效：`packages/session/session-checkpoint-policy/src/index.ts:65`–`67`。
