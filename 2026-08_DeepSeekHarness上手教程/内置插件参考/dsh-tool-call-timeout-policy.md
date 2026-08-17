# tool-call-timeout-policy

> `@deepseek-ai/dsh-tool-call-timeout-policy` · bundle：`base` · 配置树 id：`timeout-policy` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：一个 `tools/execute` 环绕拦截器，给自己声明了 `timeoutMs` 的工具装上协作式截止时间，超时就把结果整个换成结构化的 `TOOL_TIMEOUT`。

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:343-344`：

```yaml
    - id: timeout-policy
      name: '@deepseek-ai/dsh-tool-call-timeout-policy'
```

两行到底：没有 `inject` 行（写在代码里），没有 `config`（它压根没有配置项）。`web-app` 与 `headless` 两个 bundle 都没有覆写或禁用这一行，三个 profile 里它本身的行为一致。

包目录 `packages/guard/timeout-policy`，包名却是 `dsh-tool-call-timeout-policy`——源码顶部留着 FIXME（`src/index.ts:6-9`）：`settle the intended @deepseek-ai/dsh-timeout-guard rename before the first tagged release`，紧接着标了 `suggestion only`，所以这只是个待拍板的改名提议，不是已定事项。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 插件形态 | function/namespace 插件 | 导出 `name` / `inject` / `apply`，**不是 service**（`src/index.ts:28`、`:31`、`:55`） |
| inject | `tools` | `src/index.ts:31`；既要挂它的 waterfall，也要读 `ctx.tools.get()` |
| 事件监听 | `tools/execute`（**waterfall**） | `src/index.ts:56`，环绕 dispatch，是唯一被允许替换 `exec.signal` 的钩子 |
| 导出常量 | `TOOL_TIMEOUT` | `src/index.ts:25`，同时用作 `deadline()` 的分类码和替换结果里的 `error.code` |
| 工具 / prompt 段 / 命令 | 无 | 模型不知道它存在 |

它不注册任何工具，也不往 system prompt 里加任何字。它是 [dsh-tools](./dsh-tools.md) 的 `tools/execute` 消费者——按 `docs/event-producer-consumer.md:56`，全仓库这个事件只有它和 `session-checkpoint-policy` 两个消费者，两个都在 base 里（`cordis.patch.yml:343`、`:355`）。

三步逻辑（`src/index.ts:56-80`）：

1. `ctx.tools.get(exec.name, exec.agent)?.timeoutMs`——没声明就 `return next()`，完全不碰。
2. `using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)`，把派生信号换到 `exec.signal` 上，`finally` 里恢复调用方原信号，好让 `tools/post-execute` 看到的不是这个可能已 abort 的信号。
3. dispatch 回来后用 `timeoutOf(d.signal, TOOL_TIMEOUT)` 判断**是不是自己这只表**响的；是就整个替换结果。判定基于信号而非结果形状，因为下游 provider 抛出的上游取消错误早已被注册表规整成普通 error 结果了。

三步落成图，关键分岔在第 3 步——它要分清是自己的表响了，还是外层另一个取消先到：

```mermaid
flowchart TD
    S["<b>tools/execute 派发</b><br/>某次工具调用进入 waterfall"]
    Q["<b>该工具是否声明 timeoutMs</b><br/>ctx.tools.get(name).timeoutMs"]
    N["<b>直接 next()</b><br/>完全不碰，零 token 成本"]
    D["<b>派生 deadline 信号</b><br/>替换 exec.signal"]
    X["<b>dispatch 执行</b><br/>工具自己响应 signal 并收敛"]
    C["<b>是否是自己这只表响的</b><br/>timeoutOf(d.signal, TOOL_TIMEOUT)"]
    T["<b>整体替换结果</b><br/>Error: tool call timed out"]
    O["<b>返回原结果</b><br/>正常完成，或读作上游取消"]

    S --> Q
    Q -- "未声明" --> N
    Q -- "已声明" --> D
    D --> X
    X --> C
    C -- "是" --> T
    C -- "否" --> O

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class S entry
    class Q,D,X,C main
    class N,O data
    class T danger
```

## 配置项

**无配置项。** 预算不来自这个插件，而来自被调工具自己的 `ToolDefinition.timeoutMs`——README 原话 `so this plugin is **zero-config**`，且「不可能写错工具名」。注册表只在 `packages/core/tools/src/index.ts:1046-1049` 校验它是正有限数，然后不管执行。

base 树上真正声明了 `timeoutMs` 的自带工具（README 只点了 web 那两个，源码里其实有四个）：

| 工具 | 声明处 | base 下的实际值 |
|---|---|---|
| `web_search` | `packages/web/tool-web/src/search.ts:256` | `60000`（`packages/bundle/base/cordis.patch.yml:418`） |
| `web_fetch` | `packages/web/tool-web/src/fetch.ts:476` | base 里 `fetch: false`（`cordis.patch.yml:417`），**没挂载** |
| `glob` | `packages/fs/tool-fs-search/src/glob.ts:326` | `30000`（默认值 `packages/fs/tool-fs-search/src/search-core.ts:42`，base 未覆写） |
| `grep` | `packages/fs/tool-fs-search/src/grep.ts:292` | 同上 `30000` |

`--profile web` 下这两个包的 base 行都被关掉了——`tool-web`（`packages/bundle/web-app/cordis.patch.yml:407-408`）和 `tool-fs-search`（`:315-316`）都是 `disabled: true`，注释说明这是因为 Web 面把模型可见的工具改成由每个会话自己挂 preset（`:276-285`）。装机自带的 `standard` preset 又把两个都挂了回来（`apps/cli/config/agent-presets/standard/agent.cordis.yml:59-62`、`:247-251`，后者仍是 `fetch: false` + `searchTimeoutMs: 60000`），所以 web 下谁带 `timeoutMs` 取决于会话挂的是哪个 preset，而不是 base 那几行。`bash` / `read` / `write` / `edit` 按 README 是**故意不声明**的（源码核对：`tool-bash` 里的 `timeoutMs` 是模型可传的调用参数 `packages/shell/tool-bash/src/index.ts:254`，不是 `ToolDefinition.timeoutMs`）。

## 模型看得见什么

不加 schema、不加 prompt。只有截止时间赢了才多出一条结果文本，逐字是 `Error: tool call timed out after <ms>ms`，结构体是 `{ isError: true, error: { message, info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } } }`（`src/index.ts:41-48`）。非超时调用零 token；超时时它反而能挡住一个更大的迟到结果进上下文。README 说 KV cache 影响是 append-only。

## 什么时候你会想换掉它 / 怎么换

- **想给所有工具一个兜底预算**：换不了，这个插件没有配置。要么改各工具插件的 timeout 配置（如 `tool-web` 的 `searchTimeoutMs`、`tool-fs-search` 的 `timeoutMs`，`packages/fs/tool-fs-search/src/index.ts:106`），要么自己写一个 `tools/execute` 插件按名字兜底。
- **不想要超时**：`- id: timeout-policy` + `disabled: true`，之后所有工具的 `timeoutMs` 声明都变成纯装饰。
- **要叠重试 / 沙箱 / 度量**：都挂同一个 `tools/execute`。README 原话——注册顺序决定语义：`"timeout covers the whole retry operation" (timeout registered outer) versus "timeout covers each attempt" (timeout registered inner)`。

## 坑与边界

- **协作式，永远不是硬杀**。派生信号只负责通知，终止权在工具自己和它把 `exec.signal` 转发到的那个能力上；`dsh-timeout` 库不拥有任何 kill。声明 `timeoutMs` 等于承诺「我会响应 `exec.signal` 并静默收敛」，不响应的工具超时后照跑。
- **没有全局兜底预算**（README: `No blanket budget`）——没声明就没截止时间。
- `timeoutOf` 用自有 code 做 scope，是为了不把**外层另一个 wrapper 先响的表**误读成自己超时；那种情况在这里读作普通的上游取消。
- 它替换的是最终模型可见结果，之后还要过 `tools/post-execute`（`packages/core/tools/src/index.ts:1569-1599` → `:1743`）——所以 [dsh-repeat-tool-reminder](./dsh-repeat-tool-reminder.md) 照样会看见这次调用并计数：模型反复调用同一个必超时的工具，会先吃 `TOOL_TIMEOUT`，再吃重复调用提醒。
- `TOOL_TIMEOUT` 不额外产生 session 事件，README 的理由是它就是最终的 `tool/result`，loop 已经记了。
- 它的 invariant 伴生插件是空实现（`src/invariant.ts:21`，理由在 `:18-19`：`No runtime invariant: this stateless policy plugin owns no package-local event history or mutable data relation beyond the seam it intercepts.`）。

## 未确认

- ⚠️ 它和 `session-checkpoint-policy` 在 `tools/execute` 上谁在外层。cordis 的 waterfall 是先注册者在外（`vendor/cordis/src/events.ts:227-228`、`:255`），但 base 头部声明行序不含加载语义（`packages/bundle/base/cordis.patch.yml:12-13`），两者又都 `inject` 了 `tools` 而延迟激活，最终次序未在源码中确认。
