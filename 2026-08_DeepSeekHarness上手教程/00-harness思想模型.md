# 00 · harness 思想模型

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`，2026-08-13 19:38 +0800），2026-08-14 核对。本章只做一件事：把 "harness" 这个词讲清楚，并用 dsh 自己的代码证明它和"框架"不是同一种东西。不讲安装、不讲配置，那些从 01 章开始。

**读完这章你会**：

- 用一句话说清 harness 是什么，以及它和"把流程写死成节点与边"的框架差在哪
- 指出 harness 式设计的真实工作量落在哪里（不在循环里）
- 打开 dsh 仓库，自己复现"循环只占一个包、环境占几十个包"这个事实
- 用一条判据判断你手上的东西是框架还是 harness
- 按你的目的（用起来 / 写插件 / 当底座）选出该读的章节

---

## 1. 一句话定义，以及这个词从哪来

**harness = 把一个语言模型变成能干活的 agent 所需要的、模型之外的那一整套东西。**

拆开说：模型负责决定"下一步做什么"；harness 负责让这个决定能落地——给它工具、执行工具、把结果变成模型看得懂的文本、决定哪些操作需要人点头、决定超时了怎么办、决定上下文塞满了扔掉什么、把发生过的事记成一份可回放的日志。

dsh 的 README 第一句就是这个定位：

> DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI.
> — `README.md:5`

官方中文版没有翻掉 harness，而是保留原词后加了个括号注解："由 DeepSeek AI 开发的开源 agent harness（智能体框架）"（`README.zh.md:5`）。这个注解不算错，但它恰好抹掉了本章要讲的区别——所以下面我一律用 harness 原词。

### 挽具这个比喻

harness 的字面义是**挽具**：套在马身上、把马的力气传到车上的那套皮具与绳索。这个比喻能解释三件事，但请把它当**解释性比喻**看，不是任何文档里的原话：

| 挽具 | 对应到 agent |
|---|---|
| 力量来自马，不是挽具 | 能力来自模型，不是 harness |
| 挽具不教马怎么跑，只决定力往哪传、什么时候能停 | harness 不规定推理步骤，只决定模型的动作如何作用于世界 |
| 换一匹更强的马，挽具照用 | 换更强的模型，harness 基本不用改 |

最后一条是全章的题眼，第 6 节会把它变成一条可执行的判据。

### 词源那条线：能核实的和不能核实的

社区里流传的说法是这样一条演化线：`test harness`（跑测试用的固定装置）→ `eval harness`（跑模型评测用的那一层）→ `agent harness`（跑 agent 用的那一层）。**这条线我无法在 dsh 仓库里核实**，本教程也没有可引用的一手来源，所以它进本章末尾的未确认列表。

仓库里能核实的只有两件事：

1. dsh 自己用 harness 指**产品整体**。术语表里写 "The harness convention: a live agent is the key of its own scope"（`docs/glossary.md:14`）；agent-loop 的 README 写 "This is the only package in the harness that contains concrete loop logic"（`packages/core/agent-loop/README.md:7`）。两处的 harness 都等于"这套 agent 运行时"。
2. **同一个仓库里，harness 也仍在"测试夹具"的老意义上使用**：`docs/testing.md:23` 提到 `makeBridgeHarness({ withBash: true })` —— 一个在测试里接上真实工具与执行器（`dsh-bash-local` + `dsh-tool-bash`）的夹具工厂。

也就是说，"给被测对象搭一套外围装置，让它能真的跑起来"这个意思，在同一份代码库里同时服务于测试和 agent。这是个可核实的巧合，至于历史上是不是前者传给了后者，我不写。

---

## 2. 框架式写法长什么样

先看反面。下面是一段**示意伪代码**，展示"把流程写死成节点与边"的典型形状。

> ⚠️ 这段代码是我为讲解编造的伪代码，**不是任何具体库的真实 API**。本教程没有核验过 LangChain 等库的当前接口，所以这里不使用任何真实库名与真实方法名。想看真正逐行读源码的对照分析，见[五个 agent 系统源码解剖](../2026-08_五个agent系统源码解剖/00-总览与阅读指南.md)。

```text
graph = new Graph()

graph.node("fetch_log",  fetchLog)
graph.node("locate",     locateFault)
graph.node("patch",      applyPatch)
graph.node("verify",     runTests)

graph.edge("fetch_log", "locate")
graph.edge("locate",    "patch")
graph.edge("patch",     "verify")
graph.edge("verify",    END,   when = testsPass)
graph.edge("verify",    "patch", when = testsFail)

graph.run(input)
```

这段东西读起来很舒服：流程一目了然、可以画成图、可以单测每个节点、跑一万次都是同一条路。它的代价也正好长在同一个地方——

**模型只能顺着你铺的轨道走。你没画的那条边，它就走不了。**

具体是这样：

- `verify` 失败了，模型判断问题其实出在日志取错了周期，想回 `fetch_log`。**没有这条边**，它回不去。
- `locate` 阶段模型意识到该先看一眼配置文件。**图里没有这个节点**，它看不了。
- 模型想在 `patch` 之前先问一句人。**这不是图上的一个状态**，它问不了。

于是维护就变成了不断补边补节点：每发现一种模型"本来会做但被拦住"的行为，就往图里加一条边。图越长越像一张流程图，而你正在用流程图去规定一个比流程图聪明的东西该怎么想。

---

## 3. harness 式写法长什么样

harness 的做法是反过来的：**核心循环短到无话可说，顺序交给模型。**

先约定两个词，dsh 术语表给了定义：**turn** = 一次把已进入 inbox 的输入排空，模型和它的工具都停下来才结束；**step** = 一次模型请求外加这次响应引发的工具执行，一个 turn 含零到多个 step（`docs/glossary.md:37-38`）。

dsh 的驱动循环在 `packages/core/agent-loop/src/agent.ts`，最外层在私有方法 `kick()`（`agent.ts:210`）里，就是这样一行：

```ts
// packages/core/agent-loop/src/agent.ts:212
while (await this.turn()) {}
```

`turn()`（`agent.ts:246`）内部再套一层 `while (true)`（`agent.ts:263`）反复取 step，而 `step()`（`agent.ts:332`）的骨架只有四件事：拼请求 → 流式收模型输出 → 落日志 → 看有没有工具调用。**一个 step 收不收工，判据就是 `agent.ts:393-394` 那两行**：

```ts
// packages/core/agent-loop/src/agent.ts:393
const toolCalls = message.content.filter(block => block.type === 'tool-call')
if (toolCalls.length === 0) return { kind: 'completed' }
```

没有工具调用，这个 step 就算完成；有就执行完再走下一个 step（`agent.ts:395-399`）。最外层那个 `while` 的终止条件是另一处：inbox 里没有待处理输入了，`turn()` 返回 `false`（`agent.ts:324`）。

**"取日志 → 定位 → 修改 → 验证"这个顺序在代码里根本不存在**，它是模型每一轮自己决定的。想先看配置文件？调 `read` 就行（工具名见 `packages/fs/tool-fs/src/read.ts:77`）。想验证完回头重取日志？再调一次 `bash` 就行（`packages/shell/tool-bash/src/index.ts:243`）。没有边要补，因为压根没有图。

### 立刻纠正一个误解

看到这里最容易得出的结论是"harness 更简单"。**不对。harness 不是更简单，是难点搬了家。**

框架里你控制的是**控制流**；harness 里你控制的是**模型所处的环境**：

| 你要操心的东西 | 框架式 | harness 式 |
|---|---|---|
| 下一步做什么 | 你写死 | 模型决定 |
| 工具返回给模型的文本长什么样 | 顺带 | **核心工作** |
| 出错时模型看到的错误信息 | 顺带 | **核心工作**，它决定模型会不会重试对 |
| 哪些动作要人点头 | 通常没有 | **核心工作** |
| 工具卡住了怎么办 | 节点超时 | **核心工作**，且要分工具 |
| 上下文塞满了扔什么、留什么 | 通常没有 | **核心工作** |

这张表右列的每一行，都是一个模型看得见、并据此改变行为的东西。工程量全在这里。下面用 dsh 的包结构把这句话坐实。

---

## 4. 用 dsh 自己作为证据

### 4.1 循环在配置里就是一行 `- id:`

先补三个词，第 02 / 21 章细讲：**profile** 是一份具名的启动组合（列出它要叠哪些 bundle），**bundle** 是"一组 Cordis 配置行 + 它们挂载的代码"的分发格式，两者各自在自己的 `package.json` 的 `dsh` 字段里声明（`docs/architecture.md:19-23`）。dsh 的启动树就由这些 bundle 的 patch 文件按序叠出来，`dsh-base` 是每个 profile 的第一层（`docs/architecture.md:25`）。

在这份文件里，**agent 循环和其它任何插件长得一模一样**：

```yaml
# packages/bundle/base/cordis.patch.yml:436
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []
```

整份文件 451 行、78 个这样的 `- id:` 行，它只是其中之一。而按 `docs/architecture.md:27` 的说法，上层 patch 按 id 命中某一行后会**整体替换它的 config**（不是深合并）——包括这一行。架构文档把这件事说得更直白：

> Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so every part is replaceable from configuration.
> — `docs/architecture.md:11`
>
> There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.
> — `docs/architecture.md:13`

### 4.2 有多少包真的依赖循环实现

**我的统计口径**：遍历 `packages/<group>/<pkg>/package.json`（共 219 份，用 `find packages -mindepth 3 -maxdepth 3 -name package.json | wc -l` 得到），解析 JSON，按 `dependencies` / `peerDependencies` / `devDependencies` / `optionalDependencies` 四个字段分别统计谁引用了 `@deepseek-ai/dsh-agent-loop`（精确匹配包名，因此不含另一个包 `@deepseek-ai/dsh-agent-loop-testkit`，它在 `packages/test-support/agent-loop-testkit/`）。结果：

| 依赖字段 | 包数 | 是谁 |
|---|---|---|
| `dependencies` | 1 | `@deepseek-ai/dsh-base`（`packages/bundle/base/package.json:46`，位于 41 行起的 `dependencies` 块）——它只是负责把这个插件装进树里的 bundle |
| `peerDependencies` | 1 | `@deepseek-ai/dsh-agent-spine-demo`（`packages/examples/agent-spine-demo/package.json:37`，位于 34 行起的 `peerDependencies` 块）——一个示例包 |
| `devDependencies` | 25 | 测试期依赖，配合 `dsh-agent-loop-testkit` 起一个真循环来跑集成测试 |
| `optionalDependencies` | 0 | — |

**219 个包里，运行期依赖循环实现的是 2 个，其中 1 个是 bundle、1 个是示例。**其余 217 个包在运行期不 import 循环（其中 25 个只在自己的测试里用它），它们通过服务与事件挂在扩展点上。这就是 agent-loop README 那句话的工程表现：

> This is the only package in the harness that contains concrete loop logic. Everything else is an abstract service or a plugin against extension points — new behavior goes into plugins, not here.
> — `packages/core/agent-loop/README.md:7`

### 4.3 与此对照：环境有多少包

同样用 `ls -d packages/<group>/*/ | wc -l` 数每个分组下的包目录。表里反复出现的 **seam** 是 dsh 术语表的词：一个可替换的能力，由"服务定义 + 一到多个提供方 + 消费方"三种角色构成，`packages/shell` 是它给的范例（`docs/glossary.md:9`）。

| 分组 | 包数 | 管什么 |
|---|---|---|
| `packages/session/` | 13 | 会话日志、持久化（jsonl / sqlite）、投影、统计、标题、遥测 |
| `packages/subagent/` | 11 | 子 agent 委派的多种 provider 与控制工具 |
| `packages/shell/` | 9 | shell 执行 seam、本地/沙箱后端、bash / pwsh 工具 |
| `packages/fs/` | 7 | 文件读写 seam、本地与沙箱 provider、观察策略、三个文件类工具 |
| `packages/interaction/` | 5 | 审批、权限预设、人类命令、向用户提问 |
| `packages/sandbox/` | 4 | 沙箱 seam、本地后端、策略、Windows ACL |
| `packages/compaction/` | 4 | 压缩 seam、摘要后端、工具结果裁剪、`/compact` 命令 |
| `packages/context/` | 4 | 往上下文里注入内容（时间、agent 指令等） |
| `packages/workflow/` | 4 | workflow 引擎、worker 线程执行、两个工具 |
| `packages/hooks/` | 3 | 两个 hook 协议桥（Claude Code / Codex）+ 它们共用的协议库 |
| `packages/spill/` | 3 | 超大工具输出落盘、只回填预览与定位符 |
| `packages/guard/` | 2 | 重复调用提醒、按工具超时 |
| `packages/core/tools/` | 1 | 工具注册表与执行管线本体 |
| **合计** | **70** | |
| 对照：`packages/core/agent-loop/` | **1** | 全仓唯一含具体循环逻辑的包（`packages/core/agent-loop/README.md:5`、`:7`） |

源码体量同样悬殊（`find <dir> -path '*/src/*' -name '*.ts' | xargs wc -l`）：`agent-loop/src` 共 1643 行，而 `core/tools/src` 5620 行、`fs` 分组 5746 行、`session` 分组 8385 行。

另外全仓有 22 个包名以 `@deepseek-ai/dsh-tool-` 开头（同样遍历 219 份 package.json 的 `name` 字段统计）：其中 13 个落在上表分组里（已计入相应行），另外 9 个在上表根本没列的分组——`extensions` / `goal` / `jobs` / `lsp` / `session-query` / `skill` / `terminal` / `todo` / `web` 各一个。

**工程量的真实分布：循环 1 个包；上表这 13 个分组就 70 个包，而上表还不是环境的全部。**

---

## 5. 环境工程学：四个真实样例

下面四个都是 dsh 内置插件。它们都不改流程，只改模型所处的环境——而效果比在图上加一条边更强，因为它们对**大量**路径同时生效（每个的覆盖边界在各自小节里写清楚）。

### 5.1 没读过就不许写：`fs-observation-policy`

**它在改什么**：这个插件在 `ctx.fs` provider 之上加一层文件层不变式——记录"这个 owner 观察过哪些路径、观察到的版本是多少"，再把这份记录翻译成 provider 的 CAS 守卫（CAS = compare-and-swap，写的时候带上你以为的版本号，对不上就整个写入失败；`packages/fs/fs-observation-policy/README.md:42`）。它的插件体只挂三个 `fs/*` 监听器，源码里就是三行 `ctx.on`（`src/index.ts:119`、`:122`、`:127`，对照表在 `README.md:36-38`）：编辑一个从没读过的文件 → 抛 `FS_NOT_OBSERVED`，错误文本是 `edit requires reading "<path>" first`（`src/index.ts:82`）；读过但文件已被改动 → 报 `FS_STALE_VERSION`，工具层再给消息追加一句 `— re-read the file, then retry`（`README.md:58`）。

**为什么比改流程有效**：如果用图去解决，你得在每个可能编辑文件的节点前插一个"先读"节点，而且只覆盖你想到的那些节点。这里是一条文件层不变式，凡是走文件工具的改动、任何顺序、任何模型走法都绕不过去。

**它管到哪为止**（README 自己写了三条边界，别记错）：闸门只对**经文件工具发出的改动**生效——`fs/write-intent` / `fs/edit-intent` 是那个工具包 dispatch 的，管线图上标的是 "tool-fs mutations only"（`docs/tool-execution-pipeline.md:19`、`README.md:32`）；直接拿 `ctx.fs` 写文件的插件不经过它（`README.md:50`），直接拿 `ctx.fs` 读文件也不会被记成"观察过"（`README.md:72`）。它约束的也**不是"你读全了没有"**：任何一次窗口读都授权整文件覆写（`README.md:73`）。

### 5.2 重复调同一个工具时提醒：`repeat-tool-reminder`

**它在改什么**：它统计每个 agent"连续调用同一工具、且参数规范化后完全相同"的次数，在配置的次数上注入一段升级式提醒，让模型停下来重读上一次结果、换个做法或者收工。默认阈值 `[3, 5, 8]`，写在 Schema 的 `.default()` 里（`packages/guard/repeat-tool-reminder/src/index.ts:46`，配置示例见 `README.md:13`）。它**不否决、不改写**任何调用（`README.md:5`）。

**为什么比改流程有效**：卡在循环里是模型的典型失败模式，但它可能卡在任何一对工具上——图里没法穷举。这个插件挂在 `tools/post-execute` 上（`src/index.ts:213`），连被 `tools/pre-execute` 拒掉的调用也计数（`README.md:28`），因为"反复撞一堵拒绝的墙"正是最该打断的循环。提醒通过决策的 `additionalContexts` 走，落成一条带来源标注的合成 `user/message`，`tool/result` 仍然是工具自己的原始输出（`README.md:35`）——审计不被污染。

### 5.3 超时是一个可插拔策略，不是硬编码：`timeout-policy`

**它在改什么**：一个零配置插件，整个插件体只注册一个 `tools/execute` 环绕监听器（源码里就一句 `ctx.on('tools/execute', ...)`，`packages/guard/timeout-policy/src/index.ts:56`）。预算不写在它自己身上，而是从工具**自己的**声明 `ToolDefinition.timeoutMs` 里读（`README.md:5`）；超时时把结果换成结构化的 `TOOL_TIMEOUT`（`src/index.ts:46`、`README.md:24`）。在配置里它也是一行：

```yaml
# packages/guard/timeout-policy/README.md:12
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'
```

**为什么比改流程有效**：删掉这一行，超时能力整体消失，别的什么都不变；多个 `tools/execute` 环绕器按注册顺序组合（`README.md:36`），而 Cordis 的规则是"listeners run outermost-first"、默认注册是 push 到队尾（`vendor/cordis/src/events.ts:228`、`:236-241`、`:255`），所以先注册的在外层——于是"超时覆盖整个重试"还是"超时覆盖每次重试"变成一个配置顺序问题。

三个必须知道的代价：它是**协作式**的，只通过 `exec.signal` 通知，不做强杀，忽略 signal 的工具不会停（`README.md:32`）；**没有全局默认预算**，内置的 `bash` / `read` / `write` / `edit` 都故意不声明 `timeoutMs`（`README.md:57`）；别把它和 `bash` 自带的那个 `timeoutMs` **参数**搞混——那是模型可传的入参，由执行器自己实现并会杀掉命令（`packages/shell/tool-bash/src/index.ts:254`），跟这个插件不是一回事。

### 5.4 后置关卡可以把校验失败灌回给模型：`tools/post-execute` 的 `block`

**它在改什么**：工具执行完之后还有一道 waterfall（`docs/tool-execution-pipeline.md:21`）。waterfall 是 dsh/Cordis 的洋葱式派发：一串监听器层层套在最内层的默认行为外面，每层都能改写参数、也能不调 `next()` 直接短路掉后面所有人（第 10 章专讲）。这道关卡的返回类型定义在：

```ts
// packages/core/tools/src/index.ts:597
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

选 `block` 时，注册表把这次调用**改写成一个 `isError` 结果，内容就是你给的 `feedback`**（`packages/core/tools/src/index.ts:1748-1755`）。

**为什么比改流程有效**：这意味着"编辑完跑一遍 lint，不过就把 lint 报错当成这次编辑工具的失败返回给模型"可以做成一个插件，而不必在图里加一个 lint 节点再加一条回边。模型看到的是它熟悉的东西——一次失败的工具调用加一段错误文本——它天然就会去修。整条管线的形状见 `docs/tool-execution-pipeline.md`（文字说明在 `:6`，mermaid 图从 `:8` 起），逐关讲解在第 12 章。

---

## 6. 一句判据

分辨手上的东西是框架还是 harness，问自己一个问题：

> **假如明天模型强十倍，我代码里哪些行会变成累赘？**

- **写死的边会。**"验证失败必须回到修改"这条边，在更强的模型手里是障碍——它本来想回去重取日志。你写下的每一条顺序约束，都是在为今天这个模型的弱点打补丁，而补丁会比弱点活得更久。
- **沙箱、审批、日志、截断不会。**模型强十倍，你更需要沙箱（它能干的破坏更大）、更需要审批（它敢做的动作更多）、一样需要日志（要能复盘）、一样需要截断与压缩（上下文窗口再大也是有限的）。这些约束的对象不是模型的智力，是**它作用的这个世界**。

框架的代码随模型变强而贬值；harness 的代码随模型变强而增值。这是本章唯一需要记住的一句话。

---

## 7. 框架什么时候仍然是对的

上面这些不构成"框架该被淘汰"。有明确的场景，框架就是更好的答案：

| 场景 | 为什么该用固定流程 |
|---|---|
| 需要确定性 | 同样输入必须同样输出；模型自选顺序做不到 |
| 需要可审计 | 合规要求能指着一张图说"就是这几步，不会有别的" |
| 每天跑一万次的固定路径 | 路径已知且稳定，让模型每次重新决策是纯浪费 token 和延迟 |
| 步骤本身不需要判断 | 抽字段、转格式、调三个接口——本来就没有"下一步做什么"这个问题 |

真实系统通常两者都要：外层是确定性流程，某一个需要判断的环节里嵌一个 agent。

**而 dsh 自己也有确定性成分**，这不矛盾：

| 确定性成分 | 是什么 | 出处 |
|---|---|---|
| hook | 在生命周期点跑外部 shell 脚本；两个桥接插件直接吃现成的 `hooks.json` | `packages/hooks/README.md:5`、`:10-11` |
| 人类命令 | `ctx.commands` 上的斜杠命令，**不触发模型 turn**，也不变成模型消息 | `docs/architecture.md:115`、`docs/glossary.md:31` |
| 子 agent 委派 | 把一段活交给子 agent，多个具名 provider 可并存 | `packages/subagent/README.md:5` |
| workflow 引擎 | 跑模型写的编排脚本，有一个 provider 把脚本放进 worker 线程 | `packages/workflow/README.md:5`、`:10` |

区别只有一个，但很关键：**它们是启动树里普通的一行 `- id:`，上层 patch 能整行替换掉（`docs/architecture.md:27`），不是骨架。**装上以后它们也不承担"决定下一步做什么"这件事——那始终在模型手里。而框架里的图是骨架，拆了就没有程序了。

---

## 8. 本系列怎么读

正文 28 篇（00–27），外加参考区 [`内置插件参考/`](./内置插件参考/README.md)——按默认启动树逐个插件成篇，**130 篇**。计数口径见参考区索引开头那一节（`- id:` 行数与不重复包名不是同一个数）。

| 章 | 标题 | 章 | 标题 |
|---|---|---|---|
| 00 | harness 思想模型（本章） | 14 | [系统提示词与上下文装配](./14-系统提示词与上下文装配.md) |
| 01 | [五分钟跑起来](./01-五分钟跑起来.md) | 15 | [会话日志与分叉](./15-会话日志与分叉.md) |
| 02 | [配置的四层结构](./02-配置的四层结构.md) | 16 | [压缩与长会话](./16-压缩与长会话.md) |
| 03 | [接模型](./03-接模型.md) | 17 | [沙箱审批与权限](./17-沙箱审批与权限.md) |
| 04 | [Cordis 是什么](./04-Cordis是什么.md) | 18 | [子 agent 与 workflow](./18-子agent与workflow.md) |
| 05 | [你的第一个插件](./05-你的第一个插件.md) | 19 | [MCP 与其它扩展点](./19-MCP与其它扩展点.md) |
| 06 | [Service](./06-Service能力从哪来.md) | 20 | [Code Mode](./20-CodeMode.md) |
| 07 | [effect 与生命周期](./07-effect与生命周期.md) | 21 | [做一个 bundle 和 profile](./21-做一个bundle和profile.md) |
| 08 | [插件配置与 Schema](./08-插件配置与Schema.md) | 22 | [headless 与 SDK](./22-headless与SDK.md) |
| 09 | [事件系统](./09-事件系统.md) | 23 | [遥测与数据边界](./23-遥测与数据边界.md) |
| 10 | [waterfall 专章](./10-waterfall专章.md) | 24 | [调试手册与常见坑](./24-调试手册与常见坑.md) |
| 11 | [写一个工具](./11-写一个工具.md) | 25 | [Goal 模式](./25-Goal模式.md) |
| 12 | [工具执行管线](./12-工具执行管线.md) | 26 | [Ralph Loop](./26-RalphLoop.md) |
| 13 | [hook 兼容层](./13-hook兼容层.md) | 27 | [自己写一个续跑插件](./27-自己写一个续跑插件.md) |

### 三条路线

**A. 我只想用起来**（不写代码）
`01` 跑起来 → `03` 接模型 → `02` 配置四层 → `17` 沙箱审批 → `16` 压缩与长会话 → `24` 常见坑。
`23` 遥测与数据边界在公司电脑上先读。

**B. 我要写插件扩展它**（在 A 的基础上）
`04` Cordis 心智模型 → `05` 第一个插件 → `06` Service → `07` effect 与生命周期 → `08` 配置与 Schema → `09` 事件系统 → `10` waterfall → `11` 写工具 → `12` 工具执行管线。
本章第 5 节那四个样例用到的关卡，逐关讲解在 `12`；已有 `hooks.json` 想直接复用走 `13`；扩展点找不着北时查 `19` 那张对照表。

**C. 我要拿它当底座造自己的产品**（在 B 的基础上）
`22` headless 与 SDK（怎么嵌进自己的程序）→ `21` bundle 与 profile（怎么把你的组合分发出去）→ `14` 上下文装配 + `15` 会话日志（你的产品语义最终要落到这两处）→ `18` 子 agent 与 workflow → `20` Code Mode。
长程任务是两条相反的路，都要读：`25` 保留会话的 Goal 模式 vs `26` 扔掉会话的 Ralph Loop，然后 `27` 自己写一个续跑插件。

按需查阅：`内置插件参考/` 一插件一篇，在正文里遇到某个包名想知道它到底注册了什么、模型看到什么、有什么已知限制时再翻。

---

## 9. 本章未确认

- ⚠️ **`test harness` → `eval harness` → `agent harness` 这条词源演化线未经核实**。dsh 仓库里没有任何关于这个词来历的表述；本教程也没有可引用的一手来源。仓库里能确认的只有：README 用 harness 指产品整体（`README.md:5`），术语表与 agent-loop README 用它指"这套运行时"（`docs/glossary.md:14`、`packages/core/agent-loop/README.md:7`），同时 `docs/testing.md:23` 仍在"测试夹具"的老意义上使用同一个词。三者共存是事实，谁先谁后是猜测。
- ⚠️ **挽具比喻是本章的解释性写法，不是引文**。dsh 文档里没有任何地方用挽具解释这个词。
- ⚠️ **第 2 节的框架伪代码不对应任何真实库**。本教程没有核验过 LangChain 等库的当前接口，故刻意不使用任何真实库名与方法名；那类源码级分析见隔壁系列。
- ⚠️ **所有包数与行数统计均为 2026-08-14 在 commit `47f9438` 上现场统计**，口径已在正文写明；换 commit 后需重数。第 4.3 节的 70 只覆盖表里那 13 个分组，不是"环境"的全集。
- ⚠️ **第 7 节"这些确定性成分是可替换的一行配置"这一点，依据是 `docs/architecture.md:27` 描述的 patch 语义，本教程没有真的删掉它们跑一遍**；"全都不装 agent 还能跑"属于推论，未经验证。
- ⚠️ **本章没有运行过任何代码**（仓库未安装依赖）。第 3 节的循环骨架、第 5 节四个插件的行为，均来自源码与包 README 的逐行阅读，未经实际执行验证；标 `README.md:` 的是文档声称，标 `src/` 与 `.ts:` 的是我在源码里读到的。
- ⚠️ **简报记录 npm 上已有 `0.1.0-rc.6`，本次核验没有联网确认，本教程也不覆盖其差异**。仓库内 `package.json:3` 与 `apps/cli/package.json:4` 均为 `0.1.0-rc.5`。
