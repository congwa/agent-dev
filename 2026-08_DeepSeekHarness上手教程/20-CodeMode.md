# 20 · CodeMode

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章只讲 `run_code` 这一条路线：三种呈现模式的语义、TypeScript / Python 两个运行时、隔离边界到底在哪一层、以及开它要付什么代价。

**读完这章你会**：

- 用一段 patch 把一个 dsh 部署从 `native` 切到 `code` 或 `both`，并知道哪些 profile 已经自带了运行时
- 说清 `code` 模式下模型看到的工具列表变成了什么、system prompt 里多出来的两段是什么
- 讲出 worker thread 隔离了什么、没隔离什么，以及为什么官方自己写的是 "Containment, not a security boundary"
- 读懂 `code run failed (<kind>)` 的六种 kind，并知道子调用记录落在哪个事件里
- 判断自己的部署该不该开、开了之后延迟和可审计性会怎么变

---

## 1. 从"数一遍仓库里的 TODO"说起

假设你让 agent 统计 `**/*.ts` 里有多少行含 `TODO`。

**native 模式**（默认）下模型只能一次发一个工具调用：`glob` 拿到 300 个路径 → 300 次 `read` → 每次 read 的**整份文件内容**都作为 tool result 进入对话历史 → 模型再自己数。三百个来回，几十万 token，而你最后只想要一个数字。

**code 模式**下模型发的是一次 `run_code`，参数是一段程序：

```ts
const found = await tools.glob({ pattern: '**/*.ts' })
const files = await Promise.all(found.paths.map(path => tools.read({ file_path: path })))
const total = files.reduce((sum, file) => sum + file.lines.filter(line => line.text.includes('TODO')).length, 0)
console.log(`${found.paths.length} files, ${total} TODO lines`)
```

这段程序里的字段名不是我编的，都是生成给模型看的类型：`glob` 参数是 `pattern`（必填）+ `path`（可选），返回 `{ root: string, paths: string[] }`（`packages/fs/tool-fs-search/src/glob.ts:317`–`:335`）；`read` 参数是 `file_path`（必填）+ `offset` / `limit`，返回 `{ path, offset, lines: [{ number, text }], totalLines }`（`packages/fs/tool-fs/src/read.ts:79`–`:105`）。

一个照抄前要知道的边界：`read` 一次最多返回 2000 行，这既是默认值也是上限（`READ_LIMIT`，`packages/fs/tool-fs/src/read.ts:16`），所以上面这段统计的是每个文件的前 2000 行。

关键不变量只有一句，它写在生成的 SDK 指令里：**只有程序 `print` / `return` 出来的东西会回到对话**，中间那 300 份文件内容从不进入模型上下文（`packages/core/tools/src/ts-types.ts:257`）。

这就是 CodeMode 的全部卖点：把"多轮工具调用"折叠成"一段程序 + 一个筛选过的结果"。

---

## 2. 三种模式：native / code / both

先约定一个词：下文说的 **wire**，指的是"这一轮请求真正发给模型 API 的那份工具列表"——模型只能调它看得见的东西，wire 上没有的名字它连提都提不出来。

模式是工具注册表 `ctx.tools` 的一个配置项，类型定义在 `packages/core/tools/src/index.ts:651`，schema 与默认值在 `packages/core/tools/src/index.ts:791`：

```ts
mode: z.union(['native', 'code', 'both'] as const).default('native'),
```

| | 模型 wire 上看到的工具 | prompt 里多出的段落 | 模型能直接调什么 |
|---|---|---|---|
| `native`（默认） | 每个可见工具的完整 schema | — | 所有可见工具 |
| `code` | **只有 `run_code`** | `tools:code-only`（order 99）+ `tools:sdk`（order 150） | **只有 `run_code`** |
| `both` | 所有工具 schema **加上** `run_code` | 只有 `tools:sdk`；`tools:code-only` 渲染成空串 | 全都能 |

两个 order 常量：`COLLAPSE_SECTION_ORDER = 99`（`packages/core/tools/src/index.ts:51`）、`SDK_SECTION_ORDER = 150`（`packages/core/tools/src/code-mode.ts:23`）。

`wireSchemas()` 是这张表的实现（`packages/core/tools/src/index.ts:980`）：`code` 分支把 schema 列表 filter 到只剩 `run_code`（`:996`），`both` 分支返回全量再加上 `run_code`（`:1000`）。

**`code` 不只是"少给点 schema"，它同时收窄了执行面。** 模型如果在 `code` 模式下直接发一个 `read` 调用，注册表在 `createExecution` 阶段（`packages/core/tools/src/index.ts:1364`）就把它判成 `UNKNOWN_TOOL`，早于 `tools/pre-execute`、早于审批 `ask`、早于 guard——也就是说没有任何插件会看到这个注定失败的调用（判定点 `:1381`，理由见 `:1373`–`:1379` 的注释；README 的同一句在 `packages/core/tools/README.md:120`）。谓词只有一行（`packages/core/tools/src/index.ts:1325`）：

```ts
return !nested && this.modeFor(scope) === 'code' && name !== RUN_CODE_NAME
```

`!nested` 是关键：程序内部的子调用带着外层执行的 `parent` token，不算 model-direct，所以照样能调所有工具。

拒绝信息特意写了回路（`packages/core/tools/src/index.ts:1441`）：

```
only `run_code` is callable directly — call `<name>` from inside a `run_code` program instead
```

之所以要这句，是因为同一份 prompt 刚刚才声明过那个工具，一句光秃秃的 `unknown tool` 会让模型判定"这个部署坏了"而不是"我该换个写法"（`packages/core/tools/src/index.ts:1432`–`:1435`）。

`both` 不加这条规则，因为 `both` 下 native 调用**确实**能执行，写一条假规则比不写更糟（`packages/core/tools/src/index.ts:852`）。渲染时的判断就一行三元表达式（`:861`）。

**最容易踩的坑**：`code` 模式下 `systemPrompt.toolOrder` 里如果还写着 native 工具名，每次 prompt 装配都会直接失败——那些名字已经不在这个模式的 wire 校验集合里了。这是设计行为不是 bug（`.agents/notes/implemented/feature/2026-06-15-code-mode.md:33`）。

---

## 3. 怎么打开它

CodeMode 需要**两样东西同时到位**：一个非 native 的 `mode`，加一个挂上 `ctx.codeRuntime` 的运行时插件。

### 3.1 官方 bundle 已经帮你挂好了运行时

`dsh-web-app` 和 `dsh-headless` 两个 bundle 的 patch 里都已经 insert 了 worker-thread 运行时：

- `packages/bundle/web-app/cordis.patch.yml:47`–`:49`
- `packages/bundle/headless/cordis.patch.yml:22`–`:25`

而且都留了一个环境变量开关（`packages/bundle/web-app/cordis.patch.yml:35`–`:41`）：

```yaml
- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE
```

`dsh web` 是 `--profile web` 的别名子命令（`apps/cli/src/args.ts:156`），所以在 web / headless 这两个 profile 下，最省事的开法是：

```bash
DSH_TOOLS_MODE=code npx @deepseek-ai/dsh web
```

不设这个变量时值是 `undefined`，schema 兜回默认 `native`。注意源码里那段注释明说这是 **TEMPORARY workaround**，等 Web UI 支持按会话选模式后会被移除（`packages/bundle/web-app/cordis.patch.yml:37`）——别把它写进长期脚本。

### 3.2 自己写 patch（比如 `$DSH_HOME/cordis.patch.yml`）

家目录级的用户 patch 层路径见 `docs/user/develop/basic/publish.md:118`。写法：

```yaml
- id: tools
  config:
    mode: code
    maxParallelSubCalls: 4

- insert:
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
      config:
        computeMs: 60000
        maxWallMs: 600000
        maxOutputBytes: 67108864
        maxOldGenerationSizeMb: 512
```

这四个字段就是 worker-thread 运行时的全部可调项，写的值即默认值（`packages/code-runtime/code-runtime-worker-thread/src/index.ts:239`–`:244`；README 明写 "there are no other tunables"，`packages/code-runtime/code-runtime-worker-thread/README.md:19`）。

如果你的 profile 已经 insert 过 `code-runtime`（web / headless 都是），就**只留 `- id: tools` 那一段**——`insert` 的语义是往配置里新增行，不是幂等覆盖（`docs/architecture.md:27`）。另外按 patch 层的整体替换语义，`- id: tools` 的 `config` 会**替换**而不是深合并上一层的 config（`docs/user/develop/basic/publish.md:123`）——四层叠加的机制见第 02 章。

### 3.3 只让某一个 agent 用 code 模式

`mode` 是部署级默认值；单个 agent 可以自己声明，走 `ctx.tools.presentAs(mode)`（`packages/core/tools/src/index.ts:946`），或者在 agent preset 里挂一行 `@deepseek-ai/dsh-agent-tool-presentation`（这行的 `mode` 字段是必填、没有默认值：`packages/core/agent-tool-presentation/src/index.ts:50`–`:52`）。解析规则是"链上最近的 scope 胜出"（`packages/core/tools/src/index.ts:900`），一个 scope 只能声明一次，第二次直接抛错——"模型看到哪种形态"有两个答案是矛盾，不是覆盖（`packages/core/tools/src/index.ts:956`）。

这一行插件不把 `codeRuntime` 写进静态 `inject`，而是在 `apply` 里对非 native 模式做 `ctx.inject(['codeRuntime'], ...)`（`packages/core/agent-tool-presentation/src/index.ts:35`、`:69`）：这样部署里没挂运行时时，这条 row 会停在 pending，由 `dsh-agent-presets` 点名报错，而不是拖到第一次请求才炸（`:67`–`:68`）。

### 3.4 忘了挂运行时会看到什么

```
dsh-tools: mode "code" requires a code runtime — load a ctx.codeRuntime
implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set
tools mode to "native"
```

出处 `packages/core/tools/src/index.ts:1022`。这个检查在 prompt 装配时跑，不是启动时——因为 `ctx.tools` 不能被"必须有 code runtime"绑架（同文件 `:1003`–`:1007` 的注释解释了为什么不用静态 inject）。

---

## 4. 模型在 code 模式下看到的三样东西

### 4.1 一个 `run_code` 工具

两个**必填**参数，`code` 和 `description`（`packages/core/tools/src/code-mode.ts:305`–`:311`）。`description` 是必填的，因为 UI 拿它当这次调用的标题（`packages/core/tools/src/code-mode.ts:643`–`:649`）。工具描述本身按运行时语言分派——TypeScript flavor 在 `packages/core/tools/src/code-mode.ts:46`，Python flavor 在 `:61`，选哪个是在 schema 投影那一刻现读 `ctx.codeRuntime.language` 决定的（`packages/core/tools/src/code-mode.ts:113`、`:659`）。

`run_code` 这个名字是保留的：不管配的哪种 mode，你都不能注册、遮蔽、restrict 或移除它（`packages/core/tools/README.md:16`）。生成后的完整 schema 在 `docs/tool-catalog.md:121`。

### 4.2 一段固定的使用说明（`tools:sdk`，order 150）

TypeScript 版本的原文在 `packages/core/tools/src/ts-types.ts:250`–`:259`，四条要点：

- `await tools.name(args)`，怪名字用 `tools["my-tool"](args)`；参数必须是无损 JSON
- 失败的工具调用 reject 出 `ToolCallError`，带 `toolName` 和 `message`，可以 `try/catch` 后继续
- 独立只读调用可以放进 `Promise.all` 并发；会改状态的调用独占执行、按提交顺序
- **只有 `print` / `return` 的内容会回来**，中间结果永远不进对话

Python 版本在 `packages/core/tools/src/py-types.ts:734`–`:743`，同样四条，换成 `asyncio.gather` / `print(...)`。Python 那版多一条 TypeScript 没有的警告：`TypedDict` 类**在运行期不存在**，只能用 plain `dict` 传参，写 `FooArgs(field=1)` 会 `NameError`（`packages/core/tools/src/py-types.ts:736`）。

### 4.3 一段生成的类型声明

固定骨架是源码里的字面量（`packages/core/tools/src/ts-types.ts:284`–`:291`）：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type ToolName = keyof ToolOutputMap

declare class ToolCallError extends Error {
  readonly name: "ToolCallError";
  readonly toolName: ToolName;
}

declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;
}
```

`ToolArgsMap` / `ToolOutputMap` 的成员由 `jsonSchemaToTs` 从每个工具的 `parameters` 和 `output.schema` 现生成（取值在 `packages/core/tools/src/index.ts:1239`–`:1253`，渲染在 `packages/core/tools/src/ts-types.ts:277`–`:280`），一个工具一行，名字不是合法标识符就加引号（`packages/core/tools/src/ts-types.ts:21`–`:24`）。`run_code` 自己被排除在外（`packages/core/tools/src/index.ts:1241`）。工具按名字**字典序**排，保证工具集不变时逐字节相同（`packages/core/tools/src/ts-types.ts:264`–`:268`、`:274`）；官方把这条描述为 prefix-cache 友好（`packages/core/tools/README.md:122`）。

`code` 模式还会多一段 `tools:code-only`（order 99，排在各工具自己的说明之前），原文是（`packages/core/tools/src/index.ts:58`）：

> `run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.

排在前面是有理由的：每个工具插件都会注册自己那段"怎么用我"的说明（order 100–199，例如 `read` 是 100、`glob` 是 103），如果规则排在它们后面，模型先读到一整本工具手册，然后才被告知只能调 `run_code`（`packages/core/tools/src/index.ts:843`–`:850`）。

---

## 5. 程序跑在哪里：worker thread 运行时

`ctx.codeRuntime` 是个抽象 seam——dsh 把"能力的接口定义"和"具体后端实现"拆成两个包，接口包只说做什么、不说怎么做（`packages/code-runtime/code-runtime/src/index.ts:102`）。这个接口只有三个成员：`run(request)`（`:134`）、`language`（`:111`）、`isolation`（`:119`）。仓库里唯一发布的后端是 `@deepseek-ai/dsh-code-runtime-worker-thread`，它报 `language = 'typescript'`、`isolation = 'worker-thread'`（`packages/code-runtime/code-runtime-worker-thread/src/index.ts:246`–`:247`）。

一次 `run()` 的路径：

```
run(request)
  ├─ 类型擦除（host 侧，node:module 的 stripTypeScriptTypes）
  │    └─ 擦不掉的语法（enum / namespace / 语法错误）→ 直接返回 kind:'exception'，worker 根本不 spawn
  ├─ new Worker(WORKER_PATH, { env: {}, execArgv: [], resourceLimits, stdout:true, stderr:true })
  │                              ↑空环境    ↑不继承 loader flag   ↑堆上限
  ├─ worker 内：new AsyncFunction('tools', 'ToolCallError', 'console', "'use strict';\n" + code)
  │                                                          ↑五方法 console shim，不是 Node 全量 console
  └─ 每个 tools.xxx() 调用 → message port → host 侧回到工具管线
```

出处：类型擦除 `packages/code-runtime/code-runtime-worker-thread/src/index.ts:302`–`:308`；worker spawn 参数 `:378`–`:393`；AsyncFunction 构造 `packages/code-runtime/code-runtime-worker-thread/src/bootstrap.ts:406`–`:411`；console shim 只有 `log`/`info`/`warn`/`error`/`debug` 五个方法（`packages/code-runtime/code-runtime-worker-thread/README.md:52`）。程序作为 async function 的**函数体**执行，这就是 top-level `await` 和 `return` 能用的原因。

### 隔离到底是什么级别

官方自己写得很直白（`packages/code-runtime/code-runtime-worker-thread/README.md:5`）：

> **Containment, not a security boundary**: trust posture is bash-equivalent by design

Agent Note 说得更细（`.agents/notes/implemented/feature/2026-06-15-code-mode.md:84`）：模型代码**可以够到 Node API**，权限跟 bash 工具相当；`worker.terminate()` 只结束线程，**不杀它 spawn 出去的 OS 进程**。之所以敢这么设计，是因为这套 harness 本来就带 `dsh-bash-local`，那个东西的环境权限更大（`.agents/notes/implemented/feature/2026-06-15-code-mode.md:23`）。

所以别把 `isolation: 'worker-thread'` 当安全承诺读——`isolation` 字段自己的文档就写着（`packages/code-runtime/code-runtime/README.md:15`）：

> A label for deployments and diagnostics, **not a security claim**.

要硬边界得等 container 后端，仓库里 `'process'` / `'container'` 目前只是声明过的取值，没有实现（`packages/code-runtime/code-runtime/README.md:37`）。

worker 实际提供的东西是这几样：独立 isolate、空环境（`env: {}`，比 spawned command 的洗环境规则更狠，`packages/code-runtime/code-runtime-worker-thread/README.md:30`）、堆上限、以及能杀死同步死循环的硬终止。

### 两个互相独立的预算

| 配置 | 计的是什么 | 为什么需要它 |
|---|---|---|
| `computeMs`（默认 60000） | worker **实测**的 event loop 忙碌时间（`eventLoopUtilization()` 每 25ms 采样） | 死循环藏不住；等慢工具的程序**不计时** |
| `maxWallMs`（默认 600000） | 墙钟，从不为任何事暂停 | 兜住忙碌时间看不见的情况：await 一个永远不 resolve 的 promise |

两个到期分别在 `packages/code-runtime/code-runtime-worker-thread/src/index.ts:540`（`compute budget exhausted`）和 `:544`（`wall-clock ceiling reached`），最终都汇进同一个 `finish()`，由它调 `worker.terminate()`（`:424`、`:436`）。采样间隔 25ms 是内部常量、故意不做成配置，代价是 `computeMs` 到期最多晚一个采样周期（`packages/code-runtime/code-runtime-worker-thread/src/index.ts:57`–`:63`）。`maxWallMs` 在加载时就检查不超过 `MAX_TIMER_DELAY_MS`（= `2147483647`，`packages/util/timeout/src/index.ts:25`），因为 `setTimeout` 会把更大的延迟直接压成 1ms（`packages/code-runtime/code-runtime-worker-thread/src/index.ts:264`–`:268`）。

堆溢出不是 timeout，它表现为 worker 的 OOM 退出，即 `kind: 'worker-exit'`（`packages/code-runtime/code-runtime-worker-thread/README.md:27`）。

### 一次 run 一个全新 worker，不做池化

这是明确的设计选择：程序的世界随 worker 一起死，没有跨 run 状态可记、状态串味在结构上不可能发生、每次 run 都能只靠会话日志重建（`packages/code-runtime/code-runtime-worker-thread/README.md:23`）。代价就是每次 `run_code` 都要付一次 worker 冷启动。持久 REPL kernel 被记为未来工作（`packages/code-runtime/code-runtime/README.md:36`），在 MVP 阶段明确拒绝，理由是跨调用状态对日志不可见（`packages/core/tools/README.md:198`）。

### Python 呢

注册表里有 Python 的 SDK renderer，任何报 `language: 'python'` 的运行时都能驱动它（`packages/core/tools/README.md:16`）。但**仓库里没有 Python 后端包**：`packages/code-runtime/` 下只有 `code-runtime` 和 `code-runtime-worker-thread` 两个包，seam 的文档也写着 "only `'typescript'` has a published backend"（`packages/code-runtime/code-runtime/src/index.ts:109`）。挂了一个语言没有 renderer 的运行时，prompt 装配会大声失败（`packages/core/tools/src/index.ts:1024`–`:1026`）。

---

## 6. 一次 `run_code` 内部到底发生了什么

```
模型发出 run_code({ code, description })
        │
        ├─ 建 bindings：遍历「调用方 agent 可见」的工具集，排除 run_code 自己
        │     functions = Object.create(null)      ← null 原型，名叫 __proto__ 的工具也是普通 key
        │     bindings = [{ global: 'tools', functions,
        │                   errorClass: { name:'ToolCallError', memberNameProperty:'toolName' } }]
        │
        └─ runtime.run({ program, bindings, signal })
              │
              └─ 程序里每一次 await tools.foo(args)
                    ├─ args 做无损 JSON 快照（undefined / BigInt / 环 / 稀疏数组 / -0 → 这一次调用被拒）
                    ├─ subCallId = `<外层callId>:code:<n>`      ← n 按提交顺序编号
                    ├─ append  tool/code-dispatch-start        ← 只在真正开始时写，排队里被放弃的不写
                    ├─ 走【完整】工具管线：pre-execute → guard → execute → post-execute → result
                    ├─ append  tool/code-dispatch              ← 带完整 content / isError
                    └─ 成功 → 返回规范 JSON 值；失败 → 程序里 reject 出 ToolCallError(toolName, message)
```

代码位置：bindings 构造 `packages/core/tools/src/code-mode.ts:601`–`:620`（排除 `run_code` 在 `:607`）；子调用 id `:470`；两个日志事件 `:535`（start）与 `:510`（settle）；快照与管线的成文契约在 `packages/core/tools/README.md:123`。失败那一环分两半：host 侧只把结果 reject 成一个带 message 的普通 Error（`packages/core/tools/src/code-mode.ts:589`–`:592`），worker 侧再把它实例化成程序可见的 `ToolCallError`（`packages/code-runtime/code-runtime-worker-thread/src/bootstrap.ts:246`–`:259`）。

三条值得单独记住的性质：

1. **子调用不绕过任何策略。** 它走的是和 native 调用完全相同的管线，所以第 12 章讲的六道关卡、第 17 章讲的审批与沙箱，在 `run_code` 程序里一条都不少。CodeMode 不是权限旁路。
2. **并发沿用 native 的调度契约。** 连续的"并发安全"调用最多重叠 `maxParallelSubCalls` 个（默认 10，见 `packages/core/tools/src/index.ts:792`；设成 `1` 就退回严格串行），独占调用会清空池子、单独跑、并把 barrier 一直持有到它的 post-execute 完成（`packages/core/tools/src/code-mode.ts:343`–`:357` 那段长注释）。第 1 节的例子里 `glob` 没声明并发安全所以独占，`read` 声明了 `isConcurrencySafe: () => true`（`packages/fs/tool-fs/src/read.ts:135`）所以能并发。
3. **结算纪律。** run 一旦结束（正常、超时、外层取消都算），bridge 会 abort 所有在飞的子调用并**排空队列后才返回**，保证每一条 `tool/code-dispatch` 都落在这个还开着的 turn 里（`packages/core/tools/src/code-mode.ts:623`–`:629`）。

---

## 7. 失败分类与错误定位

运行时把失败作为**结果里的一个字段**返回，而不是 reject——`run()` 只在调用方违反 seam 契约时才 reject（`packages/code-runtime/code-runtime/src/index.ts:96`–`:97`；README 举的例子是"disposed 之后再提交 run"，`packages/code-runtime/code-runtime/README.md:13`）。六种 kind 定义在 `packages/code-runtime/code-runtime/src/types.ts:105`：

| kind | 含义 | 常见触发 |
|---|---|---|
| `exception` | 程序抛了，或没通过解析 / 类型擦除 | 语法错误、写了 `enum` 或 namespace |
| `timeout` | 某个实现自己的预算到期，message 会说是哪个 | `compute budget exhausted` / `wall-clock ceiling reached` |
| `abort` | `CodeRunRequest.signal` 触发 | 用户取消、外层结算 |
| `worker-exit` | 执行基座自己死了且没结算 | 堆超了 `maxOldGenerationSizeMb` |
| `invalid-output` | `return` 的值不是无损 JSON | 返回了 `BigInt`、函数、循环引用 |
| `output-limit` | 日志 + 完成值 / 失败信息的序列化超了 `maxOutputBytes` | 打印了整个仓库 |

这六类是**正交结果**：预算到期不是异常，abort 不是 timeout，基座猝死两者都不是（`packages/code-runtime/code-runtime/src/types.ts:92`–`:94` 的类型注释原话）。

模型侧看到的文本是 `Error: code run failed (<kind>): <message>`，后面按情况跟一段 `Captured output:` 和捕获到的行（`packages/core/tools/README.md:180`；拼装在 `packages/core/tools/src/code-mode.ts:631`–`:633`）。抛出点是 `CodeRunFailedError`（`code: 'CODE_RUN_FAILED'`，`packages/core/tools/src/code-mode.ts:139`–`:143`）。

**日志按发出顺序过 port，不用等程序结束**：console / stdout / stderr 的文本一产生就跨 port，所以一个被 kill 掉的程序**仍然能看到它已经打印的东西**（`packages/code-runtime/code-runtime-worker-thread/README.md:29`）。这是排查 CodeMode 问题时最有用的一条。但别误会成"能实时看日志"：seam 层的 `run()` 是一次性的，`logs` 只在 resolve 出来的 `CodeRunResult` 上，没有流式日志或进度 API（`packages/code-runtime/code-runtime/README.md:35`）。

**去哪查子调用**：`deriveMessages()` 不投影 `tool/code-dispatch*` 这两个事件，所以它们不进模型上下文，但**它们在会话日志里**，且带的是 `tool/result` 那套 `content` + `isError` 词汇，UI 就用同一条渲染路径画子调用（`packages/core/tools/src/types.ts:41`–`:56`）。也就是说：模型只看见你 print 的那一行，你自己能翻出完整的 300 次 read。

---

## 8. 代价清单：什么时候值得开

| 维度 | 变化 | 出处 |
|---|---|---|
| **token** | **不保证省**。官方原话：CodeMode 是拿"每个工具的 schema"换"生成的 SDK 文本 + 一个 transport schema"，不承诺普遍降低。`both` 模式两份都发，只多不少 | `packages/core/tools/README.md:170`；`both` 的两份见 `packages/core/tools/src/index.ts:1000` |
| **省 token 的真正来源** | 中间工具结果不进上下文——省的是**结果**，不是 schema | `packages/core/tools/src/ts-types.ts:257` |
| **延迟** | 每次 `run_code` 多一次 worker 冷启动（无池化）+ 一次 host 侧类型擦除 | `packages/code-runtime/code-runtime-worker-thread/README.md:23` |
| **KV cache** | SDK 文本按字典序确定性生成，工具集不变就逐字节稳定；改 mode 或改可见工具集会从第一个变化的 token 起失效 | `packages/core/tools/README.md:174` |
| **可审计性（好的一面）** | 每次子调用都有 `tool/code-dispatch-start` / `tool/code-dispatch` 一对事件，带完整参数与结果 | `packages/core/tools/src/types.ts:11`–`:23` |
| **可审计性（坏的一面）** | 中间 binding 值**无法从会话回放重建**，且没有字节上限，可能吃光进程或 worker 内存 | `packages/core/tools/README.md:197` |
| **错误定位** | 多一层：工具报错先变成程序里的 `ToolCallError`，可能被模型自己的 `try/catch` 吞掉，最后只剩它 print 的东西 | `packages/code-runtime/code-runtime-worker-thread/src/bootstrap.ts:258`–`:259` |
| **副作用** | 程序中途失败，**已经发生的工具副作用不回滚** | `packages/core/tools/README.md:118` |
| **孤儿进程** | 程序 spawn 出去的 OS 进程在 `terminate()` 后**存活** | `packages/code-runtime/code-runtime-worker-thread/README.md:49` |
| **配置连带** | `code` 下 native 名字的 `toolOrder` 会让每次装配失败 | `packages/core/tools/README.md:16` |

一个务实的判断：

- **值得开**：工作负载里有大量"读一堆东西→只要一个汇总"的形状（批量搜索、跨文件统计、批量重命名）；或者你已经在为 tool result 的体积做压缩。
- **先别开**：多租户 / 不可信输入场景（隔离级别不够）；工具副作用重且需要逐步审批的流程（模型会把一整串操作塞进一个程序，人类审的粒度变粗）；对首 token 延迟敏感的交互场景。
- **想两头要**：用 `both`，让模型自己选——代价是 prompt 里两套都在。或者用 `presentAs` / agent preset 只给特定子 agent 开。

> 想知道这一点上 Pi / Codex / LangChain 怎么做，见 [三个 agent 系统源码解剖](../2026-08_三个agent系统源码解剖/00-总览与阅读指南.md)。

---

## 9. 一个最小的可跑场景

仓库自带一个完整的 code 模式 overlay：`examples/acp-agent/code-mode.cordis.yml`，一共 28 行。它的核心就两处——把 app 的 `tools.mode` 设成 `code`（`:20`–`:21`），再 insert 运行时（`:26`–`:28`）：

```yaml
      - id: acp-agent
        name: '@deepseek-ai/dsh-acp-demo'
        config:
          tools:
            mode: code
      - insert:
          - id: code-runtime
            name: '@deepseek-ai/dsh-code-runtime-worker-thread'
```

上面是节选。这个文件是一个 `cordis-plugin-include` patch，因为"config patch 整体替换"所以 `provider` / `model` / `persona` 这些基础字段都得原样重述一遍——原文第 4–5 行的注释就是这么说的。

跑它的命令在 `package.json:137`：

```bash
pnpm run demo:code-mode
```

它等价于 `node --import tsx packages/examples/acp-demo/src/bin.ts --config examples/acp-agent/code-mode.cordis.yml`（`scripts/demo-code-mode.mjs:9`–`:15`），需要 DeepSeek API key（同文件 `:1`）。同目录还有 `both-mode.cordis.yml`（与 code 版逐行 diff 只差注释和 `mode: both` 一行）和 `code-mode-workspace-context.cordis.yml`。

**期望看到什么**：模型的第一条工具调用是 `run_code`；UI 上这一行的标题是模型自己写的 `description`；程序体作为 `rawInput` 挂在这次调用上（`packages/core/tools/src/code-mode.ts:645`–`:650`）。会话日志里能翻到每个 `tools.xxx()` 对应的 `tool/code-dispatch-start` / `tool/code-dispatch` 事件对；模型上下文里只有程序 print 和 return 的内容。程序既没 print 也没 return 时，模型收到的是字面量 `(run_code completed with no output)`（`packages/core/tools/src/code-mode.ts:325`）。

---

## 10. 本章未确认

- ⚠️ **本章没有运行过任何东西**（仓库未装依赖，也不允许装），全部结论来自逐行读源码、包 README 与 `docs/`。命令与配置片段的形状可信，实际输出请自行验证。
- ⚠️ **Python 后端不在这个仓库里**：`packages/code-runtime/` 下只有 `code-runtime` 与 `code-runtime-worker-thread` 两个包。`packages/core/tools/README.md:16` 说 `dsh-code-runtime-python` 是 "delivered separately"，我无法确认它是否已发布、发布在哪。
- ⚠️ **程序在 worker 里具体能拿到哪些 Node 全局**（`process`、动态 `import()`、`require` 等）我没有逐个验证。README 与 Agent Note 只笼统写了 "model code can reach Node APIs"、权限与 bash 相当（`.agents/notes/implemented/feature/2026-06-15-code-mode.md:84`），本章按这个口径描述，没有列具体清单。
- ⚠️ **`DSH_TOOLS_MODE` 是临时方案**：bundle patch 里的注释自称 TEMPORARY，等 Web UI 支持按会话选模式后会移除（`packages/bundle/web-app/cordis.patch.yml:37`）。rc.6 及以后是否还在，本章未覆盖。
- ⚠️ **同一个 id 被 `insert` 两次会怎样**：patch 引擎在 `@deepseek-ai/cordis-plugin-include` 里，该包不在本仓库源码树内，我只能确认 `insert` 的语义是"新增行"（`docs/architecture.md:27`），没能验证 id 冲突时的具体行为。
- ⚠️ **Web UI 里 `run_code` 子调用的具体卡片形态**只读到 `packages/client/ui-tool/README.md:47` 一句（生产事件只产生一层 dispatch），未逐行确认前端组件。
- ⚠️ **`maxParallelSubCalls` 与外层 agent loop 并发池是否共享额度**：README 说子调用"沿用 native 调度契约"（`packages/core/tools/README.md:123`），但两者是否同一个池，我没有从 `agent-loop` 侧交叉验证。
