# tools

> `@deepseek-ai/dsh-tools` · bundle：`base` · 配置树 id：`tools` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：工具注册表兼执行管线本体——每个 `tool-*` 插件把 schema 和 executor 注册进它，每个拦截型插件挂在它开出的 waterfall 上，本组另外两篇都是它的下游。

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:422-425`：

```yaml
    # The tool registry. Presentation mode is a deployment choice; omitting it here
    # keeps the schema default (native).
    - id: tools
      name: '@deepseek-ai/dsh-tools'
```

YAML 里既没有 `inject` 也没有 `config`：依赖写在类上（`static inject = ['systemPrompt']`，`packages/core/tools/src/index.ts:788`），配置全取 schema 默认值。

另外两个 bundle 都按 id 覆写了这一行的 config——`packages/bundle/web-app/cordis.patch.yml:35-41` 与 `packages/bundle/headless/cordis.patch.yml:17-20` 都写成 `mode: !!js process.env.DSH_TOOLS_MODE`，web-app 的注释原文是 `TEMPORARY workaround: DSH_TOOLS_MODE (native|code|both) opts a whole dsh process into Code Mode while per-session tool-presentation selection is being designed; unset keeps the schema default (native). Remove the env seam once the web UI owns the choice per session.`

base 文件头自己声明 `Row order carries no load semantics (activation is service-availability driven); the grouping is for readers.`（`packages/bundle/base/cordis.patch.yml:12-13`），所以 `tools` 写在 424 行、排在依赖它的 `timeout-policy`（343 行）之后，并不代表加载顺序。

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

它自己不监听任何事件（`src/index.ts` 内无 `ctx.on`）；同包 `src/invariant.ts:77-84` 才监听 `session/created` / `session/event` / `internal/dispatch`。

管线顺序（README:5 原文）：`tools/pre-execute` → 单调 guard → `tools/execute` → `tools/post-execute` → 定义自带的 `finalizeContent` → `tools/result`。公开方法：`register` `:1037`、`presentAs` `:946`、`restrict` `:1071`、`guard` `:1110`、`get` `:1204`、`schemas` `:1234`、`executionMode` `:1276`、`execute` `:1342`。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `mode` | `'native' \| 'code' \| 'both'` | `native` | 工具怎么呈现给模型：函数调用 / Code Mode / 两者 |
| `maxParallelSubCalls` | 正整数 | `10` | 一个 `run_code` 程序内并发子调用上限；`1` 退化为严格串行 |

schema 在 `packages/core/tools/src/index.ts:790-793`（`Config` 接口在 `:654`）。`code` / `both` 需要一个 `ctx.codeRuntime` 且其 `language` 有已注册的 SDK renderer（TypeScript / Python），否则 prompt 组装直接失败。

## 模型看得见什么

`native` 下模型看到每个可见定义的 name / description / JSON schema；`timeoutMs`、`isConcurrencySafe` 这类策略元数据永不进模型（`:250-252`、`:259`）。`code` 下模型只看到 `run_code` 的 schema、SDK 指令和生成的 SDK 块，外加 `tools:code-only` 规则；`both` 两者都发。README 对 KV cache 的原话是 `Prefix-stable while visible definitions and their order are unchanged. Registration, disposal, or scoped restriction may invalidate reuse from the first changed schema token.`

`code` 模式下模型直呼其它工具会在创建 execution 时就被判成 `UNKNOWN_TOOL`——早于 `tools/pre-execute`、approval 与 guard，所以没有任何拦截器会看到这次调用（`:1373-1381`、`:1423-1443`）。

## 什么时候你会想换掉它 / 怎么换

**换不掉**：全仓库三十来个插件 `inject: ['tools']`，卸掉它整棵树起不来。实际要动的是 `mode` 和 agent 级的可见性：

```yaml
- id: tools
  config:
    mode: both
    maxParallelSubCalls: 4
```

进程级的呈现开关只有 `mode` 一个（`maxParallelSubCalls` 只管 `run_code` 内的并发）；单个 agent 用 `ctx.tools.presentAs(mode)` 影子覆盖（`:946`），单个 agent 的可见工具集用 `ctx.tools.restrict({allow|deny})` 收窄（`:1071`，字段定义 `:680-685`）。想加自己的拦截逻辑不要改这个包——挂 `tools/pre-execute`（可拒可问）或 `tools/post-execute`（可改可 block），拿 [dsh-repeat-tool-reminder](./dsh-repeat-tool-reminder.md) 当模板；想做超时/重试/度量挂 `tools/execute`，拿 [dsh-tool-call-timeout-policy](./dsh-tool-call-timeout-policy.md) 当模板。

## 坑与边界

README 的 Known Limitations 逐条：

- **`timeoutMs` 只是声明** —— 原文 `the registry never enforces deadlines; enforcement requires the @deepseek-ai/dsh-tool-call-timeout-policy wrapper`。注册表只在 `:1046-1049` 校验它是正有限数，然后就不管了。
- **`tools/pre-execute` 故意不能改写 `exec.arguments`** —— 否则日志和渲染出的参数会和真正执行的脱节。
- **并发分类不是事件闸门** —— `executionMode()` 直读定义，插件只能给自己拥有的定义声明 classifier。
- **subagent / workflow 的调用方自定义结构化输出仍必须是 object 根** —— 这是消费侧的限制，共享 schema 词汇表本身支持任意 JSON 根。
- **Code Mode 的中间值是 execution-local 且不限字节** —— 只有最外层 `run_code` 输出受 worker 的 `maxOutputBytes`（默认 64 MiB）约束，会话回放重建不出中间值。
- **SDK 语言跟着唯一那个 runtime 走，呈现方式按 agent 而非按工具**；`run_code` 每次运行状态全新，没有 REPL 式内核。

README 正文另外两条同样是边界：`restrict()` 不是权限边界（Public API 一节原文 `This is live visibility composition, not an authority boundary`，README:22）；取消是协作式的，`ABORTED_BEFORE_DISPATCH` / `ABORTED` 会被更具体的 deny、wrapper 失败、工具失败、post 策略失败或 `TOOL_TIMEOUT` 盖掉（README:35）。

## 未确认

- ⚠️ 多个 `tools/execute` / `tools/post-execute` 监听器的实际嵌套顺序。cordis 的 `waterfall` 注释写着 `Listeners run outermost-first`，`register` 默认 `push`（`vendor/cordis/src/events.ts:227-228`、`:255`），即先注册者在外；但 base 头部又声明行序不含加载语义，而这些插件都靠 `inject: ['tools']` 延迟激活，最终注册次序未在源码中确认。
