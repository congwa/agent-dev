# tools

> `@deepseek-ai/dsh-tools` · bundle：`base` · 配置树 id：`tools` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：工具注册表兼执行管线本体——每个 `tool-*` 插件把 schema 和 executor 注册进它，每个拦截型插件挂在它开出的 waterfall 上，本组另外两篇都是它的下游。

## 它在树上长什么样

base bundle 里它只占两行：

```yaml
    # The tool registry. Presentation mode is a deployment choice; omitting it here
    # keeps the schema default (native).
    - id: tools
      name: '@deepseek-ai/dsh-tools'
```

YAML 里既没有 `inject` 也没有 `config`。依赖不是写在这儿的，而是写在类上——`static inject = ['systemPrompt']`；配置则全取 schema 默认值。

另外两个 bundle 都按 id 覆写了这一行的 config，`web-app` 和 `headless` 都写成 `mode: !!js process.env.DSH_TOOLS_MODE`。web-app 的注释原文是：

> `TEMPORARY workaround: DSH_TOOLS_MODE (native|code|both) opts a whole dsh process into Code Mode while per-session tool-presentation selection is being designed; unset keeps the schema default (native). Remove the env seam once the web UI owns the choice per session.`

有个地方容易读岔：`tools` 写在 424 行，排在依赖它的 `timeout-policy`（343 行）**之后**。这不代表加载顺序倒置——base 文件头自己声明了 `Row order carries no load semantics (activation is service-availability driven); the grouping is for readers.`

出处：base 那两行见 `packages/bundle/base/cordis.patch.yml:422-425`，头部声明见同文件 `:12-13`；类上的 `static inject` 见 `packages/core/tools/src/index.ts:788`；两处覆写见 `packages/bundle/web-app/cordis.patch.yml:35-41` 与 `packages/bundle/headless/cordis.patch.yml:17-20`。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.tools`（`ToolRuntime`） | 声明 `src/index.ts:137-140`，类 `:787` |
| 静态注入 | `systemPrompt` | `:788`；构造时 `ctx.systemPrompt.tools(...)` 自动把 schema 灌进 prompt 组装（`:832`） |
| 机会性依赖 | `ctx.get('approval')` | 无静态 inject；未挂 approval 时 `ask` 退化为 deny（`:1693-1706`） |
| 事件 producer | `tools/pre-execute`（**waterfall**） | allow/deny/ask 闸门，声明 `:152`，派发 `:1475` |
| 事件 producer | `tools/execute`（**waterfall**） | around-dispatch，**唯一允许替换 `exec.signal` 的位置**，声明 `:163`，派发 `:1573` |
| 事件 producer | `tools/post-execute`（**waterfall**） | 换 content/value、block、挂 `additionalContexts`，声明 `:175`，派发 `:1743` |
| 事件 producer | `tools/code-dispatch-log`（**waterfall**） | 只改 `run_code` 子调用的落库副本，模型看不到，声明 `:189` |
| 事件 producer | `tools/result`（emit） | 只读、已冻结的最终结果，声明 `:197`，派发 `:1665-1666` |
| 事件 producer | `tools/change`（emit） | 注册表变动，**故意不做 scope 过滤**，声明 `:198-207`，派发 `:813` |
| prompt 段 | `tools:code-only`（order 99） | 进程默认 `mode ≠ native` 时全局注册（`:833-836`），`presentAs` 另按 agent 注册（`:968-969`）；`code` 下渲染禁令、`both` 下渲染空串（`:51`、`:855-863`） |
| prompt 段 | `tools:sdk`（order 150） | 按运行时语言生成的 SDK 文本（`code-mode.ts:23`、`index.ts:875-879`） |
| 工具 | `run_code` | 保留传输，位于可过滤的注册层之外，`code-mode.ts:20` |

它自己**不监听任何事件**——`src/index.ts` 内一个 `ctx.on` 都没有。同包 `src/invariant.ts:77-84` 才是监听方，听的是 `session/created` / `session/event` / `internal/dispatch`。

公开方法一览：

| 方法 | 行号 |
|---|---|
| `register` | `:1037` |
| `presentAs` | `:946` |
| `restrict` | `:1071` |
| `guard` | `:1110` |
| `get` | `:1204` |
| `schemas` | `:1234` |
| `executionMode` | `:1276` |
| `execute` | `:1342` |

管线顺序（README:5 原文）：`tools/pre-execute` → 单调 guard → `tools/execute` → `tools/post-execute` → 定义自带的 `finalizeContent` → `tools/result`。

写成伪代码，注意 Code Mode 的那道判断在整条管线**之前**：

```
execute(call):
    exec = 创建 execution(call)
    if mode 是 code 且 call.tool 不是 run_code:
        return UNKNOWN_TOOL          // 这里就返回了，下面一行都跑不到

    决定 = waterfall(tools/pre-execute, exec)   // allow / deny / ask
    决定 = guard(决定)                          // 只能收紧，不能放宽
    结果 = waterfall(tools/execute, exec)       // around-dispatch，可换 exec.signal
    结果 = waterfall(tools/post-execute, 结果)  // 可换 content/value、block、挂 additionalContexts
    结果 = 定义自带的 finalizeContent(结果)
    emit(tools/result, freeze(结果))            // 只读，改不动
```

同样一条路径的流程图：

```mermaid
flowchart TD
    ENTRY["<b>创建 execution</b><br/>Code Mode 下先判 UNKNOWN_TOOL，早于以下全部环节"]
    A["<b>tools/pre-execute</b><br/>waterfall，allow / deny / ask 闸门"]
    B["<b>单调 guard</b><br/>只能收紧不能放宽"]
    C["<b>tools/execute</b><br/>waterfall，around-dispatch<br/>唯一允许替换 exec.signal 处"]
    D["<b>tools/post-execute</b><br/>waterfall，换 content/value、block、挂 additionalContexts"]
    E["<b>finalizeContent</b><br/>定义自带的收尾逻辑"]
    F["<b>tools/result</b><br/>emit，只读、已冻结的最终结果"]

    ENTRY --> A --> B --> C --> D --> E --> F

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class ENTRY entry
    class A,B,C,D,E main
    class F data
```

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `mode` | `'native' \| 'code' \| 'both'` | `native` | 工具怎么呈现给模型：函数调用 / Code Mode / 两者 |
| `maxParallelSubCalls` | 正整数 | `10` | 一个 `run_code` 程序内并发子调用上限；`1` 退化为严格串行 |

schema 在 `packages/core/tools/src/index.ts:790-793`，`Config` 接口在 `:654`。

`code` / `both` 有个前置条件：需要一个 `ctx.codeRuntime`，且其 `language` 有已注册的 SDK renderer（TypeScript / Python）。否则不是运行时才报错，是 prompt 组装直接失败。

## 模型看得见什么

| mode | 模型看到的 |
|---|---|
| `native` | 每个可见定义的 name / description / JSON schema |
| `code` | `run_code` 的 schema、SDK 指令、生成的 SDK 块，外加 `tools:code-only` 规则 |
| `both` | 两者都发 |

`timeoutMs`、`isConcurrencySafe` 这类策略元数据**永不进模型**（`:250-252`、`:259`）。

README 对 KV cache 的原话是 `Prefix-stable while visible definitions and their order are unchanged. Registration, disposal, or scoped restriction may invalidate reuse from the first changed schema token.`

`code` 模式下模型如果直呼其它工具，会在创建 execution 时就被判成 `UNKNOWN_TOOL`。这个判定早于 `tools/pre-execute`、approval 与 guard——**所以没有任何拦截器会看到这次调用**，你想在 `pre-execute` 里记一笔都记不到（`:1373-1381`、`:1423-1443`）。

## 什么时候你会想换掉它 / 怎么换

**换不掉**。全仓库三十来个插件 `inject: ['tools']`，卸掉它整棵树起不来。

实际要动的是 `mode` 和 agent 级的可见性：

```yaml
- id: tools
  config:
    mode: both
    maxParallelSubCalls: 4
```

进程级的呈现开关只有 `mode` 一个，`maxParallelSubCalls` 只管 `run_code` 内的并发，别指望它影响呈现。

要按 agent 调整，走这两个方法：

| 想做的事 | 方法 | 行号 |
|---|---|---|
| 单个 agent 换呈现模式（影子覆盖） | `ctx.tools.presentAs(mode)` | `:946` |
| 单个 agent 收窄可见工具集 | `ctx.tools.restrict({allow\|deny})` | `:1071`，字段定义 `:680-685` |

想加自己的拦截逻辑，不要改这个包：

- 可拒可问 → 挂 `tools/pre-execute`；可改可 block → 挂 `tools/post-execute`。模板拿 [dsh-repeat-tool-reminder](./dsh-repeat-tool-reminder.md)。
- 超时 / 重试 / 度量 → 挂 `tools/execute`。模板拿 [dsh-tool-call-timeout-policy](./dsh-tool-call-timeout-policy.md)。

## 坑与边界

README 的 Known Limitations 逐条：

- **`timeoutMs` 只是声明**。原文 `the registry never enforces deadlines; enforcement requires the @deepseek-ai/dsh-tool-call-timeout-policy wrapper`。注册表只在 `:1046-1049` 校验它是正有限数，然后就不管了。
- **`tools/pre-execute` 故意不能改写 `exec.arguments`**。否则日志和渲染出的参数会和真正执行的脱节。
- **并发分类不是事件闸门**。`executionMode()` 直读定义，插件只能给自己拥有的定义声明 classifier。
- **subagent / workflow 的调用方自定义结构化输出仍必须是 object 根**。这是消费侧的限制，共享 schema 词汇表本身支持任意 JSON 根。
- **Code Mode 的中间值是 execution-local 且不限字节**。只有最外层 `run_code` 输出受 worker 的 `maxOutputBytes`（默认 64 MiB）约束，会话回放重建不出中间值。
- **SDK 语言跟着唯一那个 runtime 走，呈现方式按 agent 而非按工具**；`run_code` 每次运行状态全新，没有 REPL 式内核。

README 正文另外两条同样是边界：

- `restrict()` 不是权限边界。Public API 一节原文 `This is live visibility composition, not an authority boundary`（README:22）。
- 取消是协作式的。`ABORTED_BEFORE_DISPATCH` / `ABORTED` 会被更具体的 deny、wrapper 失败、工具失败、post 策略失败或 `TOOL_TIMEOUT` 盖掉（README:35）。
