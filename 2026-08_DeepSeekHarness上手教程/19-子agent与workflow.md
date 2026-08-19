# 19 · 子 agent 与 workflow

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。

派活出去有两条路：委派一个子 agent，或者让模型写一段 JavaScript 脚本，一口气调度几十个子 agent。

这一章把两条路都拆开，重点回答三个问题——子 agent 到底由什么拼出来（不是一个 markdown 文件），它跟父 agent 共享什么、不共享什么，以及你手上的需求该走哪条路。

有几处仓库自己都没对齐的地方，我会点名：fork 的模式在文档和配置里说的不是一回事；两个"接外部产品"的 provider 在包 README 里说得像开箱可用，实际默认发行版连依赖都没装。

---

## 十五个文件要审一遍，你有两条路

假设你让 agent 审十五个文件。

它可以自己一个个读，代价是十五份文件内容全部堆进同一个会话的上下文，读到后面就要触发压缩（阈值由部署配置决定，见 [17 章](./17-压缩与长会话.md)）。

dsh 给了两条别的路：

```
父 agent 的一条 assistant message
├── subagent(prompt)               → 起 1 个子 Session，一次委派
│                                     子的中间步骤留在子会话，父只拿最终答案
└── workflow(meta, script)         → 起 1 个 worker thread 跑你的脚本
                                      脚本里的 agent() × N → N 个子 Session
                                      父只拿脚本 return 的那个 JSON
```

怎么选，官方注入给模型的那段提示词说得比任何架构图都直白：workflow 工具 `ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration`，`For one or two delegations, prefer plain subagent calls`（`packages/workflow/tool-workflow/README.md:41`）。

**一两个委派用 subagent，明确要"工作流/大规模编排"才用 workflow。**

| | 一次委派 | workflow 脚本 |
|---|---|---|
| 谁写调度逻辑 | 父模型，一轮一个决定 | 父模型一次写完整段脚本 |
| 中间结果落在哪 | 每次委派的结果都进父上下文 | 留在脚本变量里，父看不见 |
| 并发 | 一条 message 里发多个工具调用（`packages/subagent/tool-subagent/README.md:32`） | `parallel` / `pipeline`，引擎管并发闸门 |
| 能不能接着聊 | continuable 模式可以 | 不能，一次跑完就结束（`docs/tool-catalog.md:1752`） |
| 出处 | `packages/subagent/` | `packages/workflow/` |

---

## 一个子 agent 是三层拼出来的

如果你用过那种"一个 markdown 文件定义一个子 agent"的设计，先把它忘掉，dsh 里没有这个东西。

一个子 agent 的形态由三层决定，改哪一层的效果完全不同。三层从上往下的关系是：preset 挑出模型看得见哪些委派工具，每个工具实例绑一个 provider，provider 决定子跑在哪。

```mermaid
flowchart TD
    P3["<b>第三层 preset</b><br/>父正在跑的 standing composition，子不重挂"]
    P2["<b>第二层 delegation tool 实例</b><br/>一个实例 = 一个 provider + 一个工具名"]
    P1["<b>第一层 provider</b><br/>子跑在哪、走什么传输"]
    T["<b>模型看见的工具</b><br/>subagent / subagent_fork / …"]
    N["<b>minimal preset 里一条委派工具都没有</b><br/>从 minimal 出发的会话根本没得派活"]

    P3 -- "挑哪些实例在线" --> P2
    P2 -- "带策略 persona / toolFilter / maxDepth" --> P1
    P2 --> T
    P3 -.-> N

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class P1,P2,P3 main
    class T entry
    class N note
```

**第一层是 provider，决定这个子 agent 跑在哪、用什么传输。**

`ctx.subagents` 是按名字注册的**多实例**注册表——和只允许一个实现的 bash 执行器不同，多个 provider 可以同时在线（`docs/subsystems/subagent.md:5`）。

| provider 包 | 子 agent 跑在哪 | `inheritsParentContext` |
|---|---|---|
| `subagent-spawn-in-process` | 本进程，全新会话（`README.md:5`） | `false`（`src/index.ts:44`） |
| `subagent-fork-in-process` | 本进程，带父的已完成对话（`README.md:5`） | `true`（`src/index.ts:64`） |
| `subagent-acp` | 进程外，走 ACP | `false`（`src/index.ts:149`） |
| `subagent-dsh-sdk` | 进程外，走 TypeScript SDK | `false`（`src/index.ts:96`） |
| `subagent-codex` / `subagent-claude-code` | 外部真实产品进程 | `false`（`src/index.ts:50` / `:55`） |

包与角色的全表在 `packages/subagent/README.md:9`–`19`。

这里有个字段名很容易读成"继承"两个字的全部含义：`inheritsParentContext` **只描述"子看不看得见父的已完成对话"**，工具、服务、权限的继承跟它一点关系都没有（`docs/subsystems/subagent.md:408`）。

**第二层是 delegation tool 实例，决定模型看见的那个工具叫什么、带什么策略。**

一个 `@deepseek-ai/dsh-tool-subagent` 实例 = 一个 provider + 一个模型可见的工具名。想要"另一个模型 / 另一套 persona / 另一份工具白名单"，办法是再加一个实例，而不是去改同一个实例的策略（`packages/subagent/tool-subagent/README.md:82`）。

配置项与默认值定义在 `packages/subagent/tool-subagent/src/index.ts:81`–`99` 的 Schema 里，各字段的语义在同文件 `:30`–`:78` 的类型注释：

| key | 默认 | 说明 |
|---|---|---|
| `provider` | 必填 | `ctx.subagents` 上的 provider 名 |
| `toolName` | `subagent` | 模型看到的名字，每个实例必须不同 |
| `enableRunInBackground` | `true` | 关掉后 schema 里没有这个参数 |
| `backgroundMode` | `one-shot` | `one-shot` 默认前台；`continuable` 默认后台并返回持久子 id |
| `agentOptions` | 省略 | 子的 `provider` / `model` / `maxTokens` |
| `persona` | 省略 | 只影响这个子，遮蔽部署 persona |
| `toolFilter` | 省略 | `allow` / `deny` |
| `maxDepth` | `3` | `0` = 禁止再委派；`'provider-managed'` = 不下发上限 |

表里有两格值得展开。

`enableRunInBackground` 关掉之后不只是参数从 schema 里消失，显式硬塞一个 `run_in_background: true` 也会在执行期被拒（`src/index.ts:254`–`255`）——它不是一个建议性的开关。

`toolFilter` 过滤掉的工具是**既从 prompt 里消失也拒绝执行**，两头都堵死。

`enableRunInBackground` 和 `backgroundMode` 合起来决定一次委派落成哪种形态：

```
if not enableRunInBackground:      前台 one-shot        // schema 里根本没有那个参数
elif backgroundMode == 'one-shot':
    if 模型请求了后台:              后台 one-shot        // 注册普通 Task
    else:                          前台 one-shot
elif backgroundMode == 'continuable': continuable       // 默认后台，返回持久子 id
```

这四种形态后面几节会反复出现，先记住名字就行。

```mermaid
flowchart TD
    A["<b>模型调用委派工具</b>"]
    B{"enableRunInBackground"}
    C{"backgroundMode"}
    D1["<b>前台 one-shot</b><br/>父 await，工具返回子的最终文本"]
    D2["<b>后台 one-shot</b><br/>注册普通 Task，job_output 收、job_kill 停"]
    D3["<b>continuable</b><br/>返回持久子 id，send_message 续聊"]
    R["<b>关掉后硬塞 run_in_background</b><br/>执行期被拒，不是建议性开关"]

    A --> B
    B -- "false，schema 里没有这个参数" --> D1
    B -- "true" --> C
    C -- "one-shot，默认前台" --> D1
    C -- "one-shot 且请求后台" --> D2
    C -- "continuable，默认后台" --> D3
    B -.-> R

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class D1,D2,D3 main
    class A,B,C entry
    class R danger
```

**第三层是 preset，决定子 agent 看得见哪些工具。**

这一层最反直觉：子 agent **不会**重新挂载 preset，它是通过 `composeFrom()` 绑到父正在跑的那份 **standing composition**（父这次会话实际跑着的那棵插件树）上的（`packages/preset/agent-presets/README.md:35`）。

父在 `minimal` preset 下，子也就在 `minimal` 下，没有第二种可能。而 `apps/cli/config/agent-presets/minimal/agent.cordis.yml` 全文 62 行，`subagent` 和 `workflow` 一个字都没有——从 minimal 出发的会话根本没有委派工具可用。

> 想知道这一点上 Pi / Codex / LangChain 各自怎么做，见 [五个 agent 系统源码解剖](../2026-08_五个agent系统源码解剖/00-总览与阅读指南.md)。

### 最小可用配置，以及它为什么在 web 下不生效

下面这段抄自 `examples/headless-agent/cordis.yml` 的 `:91`–`:92`、`:94`–`:97`、`:113`–`:119` 三段，原文的注释、fork 那条链、`tool-subagent-control` 与 `tool-subagent-report` 都没抄进来，只留 spawn 一条路：

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'

- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: spawn

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable
    maxDepth: 1
```

照抄进 web / CLI 形态就会发现它不起作用，这是本节最容易踩的坑。

`packages/bundle/web-app/cordis.patch.yml:374`–`396` 把 base bundle 里的 `tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`、`workflow-worker-thread`、`tool-workflow` 全部设成 `disabled: true`，改由 preset 提供；preset roster 在同文件 `420`–`424` 挂载，默认 preset 是 `standard`。

分工的原话是：**registry 和 provider 留在 host 层（进程单例，一个名字只能注册一次），preset 只挑"这个 agent 看见哪些委派工具"**（`apps/cli/config/agent-presets/code/agent.cordis.yml:166`–`170` 的注释，`packages/bundle/web-app/cordis.patch.yml:367`–`372` 是同一段话的另一处）。

所以你要加自己的委派工具，改的是 preset 目录里的 `agent.cordis.yml`，不是 profile。

另有两个配置错误会在挂载期就响亮失败，不会拖到运行时（`packages/subagent/tool-subagent/src/index.ts:285`–`296`）：

| 配错了什么 | 后果 |
|---|---|
| 给一个没有 `depthLimit` 能力的 provider 配数字 `maxDepth` | 挂载期失败 |
| 给一个没有 `prepareContinuable` 的 provider 配 `backgroundMode: continuable` | 挂载期失败 |

第一条正是 codex / claude-code 那两行必须写 `maxDepth: provider-managed` 的原因。

---

## spawn 和 fork 只差一件事：种子

`fork` 与 `spawn` 共用同一个 run driver，唯一的行为差异是会话种子（`packages/subagent/subagent-fork-in-process/README.md:5`）。

这条差异全落在一刀切在哪里：

```mermaid
flowchart TD
    subgraph LOG["父会话日志"]
        T1["turn 1 · 到 turn/end 收尾"]
        T2["turn 2 · 到 turn/end 收尾"]
        T3["当前 turn · 有 assistant 的工具调用<br/>没有 tool result，也没有 turn/end"]
    end
    CUT["<b>切到最后一个 turn/end 为止的连续前缀</b>"]
    F["<b>fork 子会话</b><br/>种子 = 这段前缀，header 上写 seedLength"]
    S["<b>spawn 子会话</b><br/>种子为空；父还没跑完一个 turn 时 fork 也退化成它"]
    X["<b>种子只搬对话历史</b><br/>全新扁平注册作用域，不继承工具限制与权限"]

    T1 --> T2 --> T3
    T2 -- "边界在这里" --> CUT
    CUT --> F
    F -.-> X
    S -.-> X

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class CUT,F,S main
    class T1,T2,T3 data
    class X note
```

有意思的是种子的边界怎么划。

父起子 agent 的那一刻，父自己的 turn 还开着：日志里有 assistant 的工具调用，但没有对应的 tool result，也没有 `turn/end`。直接把当前历史抄过去，子拿到的会是一个不平衡的非法会话。

所以 fork 取的是**到最后一个 `turn/end` 为止的连续前缀**：

```
seed = []
for e in 父会话事件:
    seed.append(e)
    if e is turn/end:  cut = len(seed)   // 每见一次 turn/end 就把刀口往后挪
seed = seed[:cut]                        // 半截的当前 turn 被整段丢掉

if seed 为空:  行为等同 spawn            // 父还没跑完一个完整 turn
```

出处 `README.md:9`–`11`。父还没跑完一个完整 turn 时种子为空，fork 就退化成了 spawn。

种子只搬对话历史，别的什么都不搬。子拿到的是**全新的扁平注册作用域**，不继承父的工具限制，也不继承任何权限（`README.md:13`）。

### 一处文档与配置对不上（以配置为准）

三处官方文字都说 fork 的委派工具在所有 shipped 组合里是 one-shot：`packages/subagent/subagent-fork-in-process/README.md:42` 与 `:61`，还有 `docs/tool-catalog.md:1505`（"`subagent_fork` stays `one-shot`"）。专门为这件事写的 Agent Note 把"所有 shipped 组合"逐个点名，只有三个——base bundle、ACP 示例、headless 示例（`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md:15`）。

同一份 Note 在结论里给自己留了句话："约束只活在三个配置文件和一句代码注释里，不是一道 gate——将来某个 bundle 行或 profile patch 把 fork 设成 `continuable`，不会有任何东西响亮失败"（同文件 `:49`）。

它预告的漏洞已经发生了。

| 配置文件 | fork 的模式 | 位置 |
|---|---|---|
| base bundle | `one-shot` | `packages/bundle/base/cordis.patch.yml:329` |
| headless 示例 | `one-shot` | `examples/headless-agent/cordis.yml:129` |
| ACP 示例 | `one-shot` | `examples/acp-agent/cordis.yml:132` |
| preset `standard` | **`continuable`** | `apps/cli/config/agent-presets/standard/agent.cordis.yml:198` |
| preset `code` | **`continuable`** | `code/agent.cordis.yml:199` |
| preset `cordis` | **`continuable`** | `cordis/agent.cordis.yml:186` |
| preset `minimal` | 一条委派工具都没有 | — |

被点名的那三处确实是 one-shot，但**四个 shipped agent preset 里带委派工具的那三个，fork 全是 `continuable`**。而 web 形态用的正是 preset。

---

## 子会话就是一个普通 Session

本地 provider 在 `start()` 返回之前就**先发布一个普通的子 agent / 子 Session**，然后把这个 session id 当作 `SubagentRun.id`（`packages/subagent/subagent/README.md:69`）。它不是一条"运行记录"，就是会话本身。

这个选择带来四件很具体的事：header 多了几个字段、枚举靠 header、权限在委派那一刻钉死、深度穿得过持久化。

**header 上多了几个字段。** `packages/subagent/subagent/src/child-agent.ts:102`–`119` 一次写全：

| 字段 | 值 |
|---|---|
| `cwd` | 继承父 header（`:110`） |
| `agentPreset` | 从父的**活作用域链**读，不是从父 header 读（`:108`，理由在 `:91`–`:93`） |
| `parentSession` | 父 session id（`:112`） |
| `origin` | 固定 `'subagent'`（`:115`） |
| `delegationDepth` | 父深度 + 1（`:49`），持久化且单调 |
| `seedLength` | 只在种子非空时才写（`:118`） |

后两个字段有额外含义。`delegationDepth` 冷恢复时只能加不能减（`README.md:55`），递归预算是穿得过持久化的。`seedLength` 记录前多少条事件来自父，实际上只有 fork 会写它。

**枚举靠 header，而不是靠一张运行表。**

```
listChildren(parent):
    候选 = 活会话存储 ∪ 可选的会话持久化
    return [s for s in 候选
            if s.header.parentSession == parent.id
            and s.header.origin == 'subagent']
    // 全程不加载、不恢复任何 Agent，也不需要 query 服务
```

`listChildren()` 的挑选逻辑在 `packages/subagent/subagent/src/list-children.ts:141`–`142`，"不加载 Agent、不要 query 服务"这条写在 `README.md:25`。`listDescendants()` 走同一套语料的整棵树，普通会话和 one-shot 子仍然是可以穿过的中间节点（`README.md:26`）。

**子的权限在委派那一刻就钉死。** `captureDelegatedPolicyOverrides(parent)` 快照父会话**显式**的沙箱覆盖，并在审批能力被组合进来时把子的审批策略钉成 `'never'`——不管父自己是什么策略。这些以 `source: 'delegation'` 的事件写进子自己的日志，位置在 fork 种子之后，所以新策略能盖过旧种子里的状态（`README.md:61`）。

子同时会拿到一段固定的运行时上下文语句，原文在 `README.md:134`：需要更大权限时**不要重试**，把限制写进回复交给父处理。

**深度是持久的。** 数字 `maxDepth` 超了会得到确定的报错文本 `Error: subagent depth <attempted> exceeds maxDepth <max>`（`packages/subagent/subagent-in-process-driver/README.md:89`，构造点在 `child-agent.ts:33`）。

---

## 结果怎么回到父会话：三条互不相干的通道

这是整章最容易糊涂的一节。三条通道彼此独立，可能同时发生，而且父每一条都要付 token。

| 通道 | 谁开口 | 起不起新 turn | 父付账 |
|---|---|---|---|
| 一 · 前台 tool result | 父自己 `await` 出来的 | 不额外起，它就是工具返回值 | 一笔 |
| 二 · `report` 工具 | 子主动调 | 默认 `wakeup` 起一个普通新 turn | 一笔 |
| 三 · settlement notice | runtime 无条件发 | 空闲父起一个 turn，忙父并进最近 step 边界 | 一笔 |

把三条摆在同一条时间线上，谁开口、谁付账就清楚了：

```mermaid
sequenceDiagram
    participant P as 父会话
    participant C as 子会话
    participant M as runtime 结算管理器
    P->>C: 前台 one-shot 委派
    C-->>P: 通道一 tool result，只有最终文本，不额外起 turn
    P->>C: continuable 委派，先拿到持久子 id
    C-->>P: 通道二 report，子主动调，默认 wakeup 起一个新 turn
    C->>M: Activation 结算
    M-->>P: 通道三 settlement notice，无条件发，不看子报没报
    Note over P: 既 report 又结算的子，父两笔都付
```

**第一条是前台 tool result，父自己 `await` 出来的。**

父看到的只有子的最终文本；子的停止原因不是 `completed` 时，这个返回会变成 `Error: <message>`，残留文本附在停止原因后面。它不额外起 turn，因为它就是这次工具调用的返回值（`packages/subagent/tool-subagent/README.md:11` 与 `:54`）。

**第二条是 `report` 工具，子主动调的。** 父会看到 `Background subagent <child-id> reported:` 加上子的 `output` 原文。

`report` 不是全局工具，而是通过 `registerContinuableSetup` 注册的**子作用域**能力，只在 continuable 的进程内子里存在，root、one-shot 子和远程 provider 都看不到（`packages/subagent/tool-subagent-report/README.md:5`）。

它**故意**穿透子的全局 `toolFilter`——白名单不能把唯一的回话通道删掉；真想要一个没有回话通道的子，办法是别装这个包（`:11`）。调用时不指定收件人，`exec.agent` 就是身份凭证，收件人由服务从子的持久 `parentSession` 推出来（`:7`）。父侧看到的那个框带着 `{ kind: 'subagent-report', senderSessionId }` 的溯源（`:49`）。

投递方式 `reportDelivery` 是部署策略，模型改不了。默认 `wakeup`，会起一个普通的新 turn，理由写在 `:9`：已经停下来的父没有别的理由回头看。`quiet` 则只注入不请求。

**第三条是 settlement notice，runtime 自己发的。**

Activation（一个 continuable 子在本进程里的一段常驻期，不是请求也不是结果，`packages/subagent/subagent/README.md:73`）结算时，管理器**无条件**给父发一条账目，不看子有没有调过 `report`。原因很实际：最需要交代的那些收尾——撞上下文上限、模型失败、被取消、被拆——恰恰是子来不及自己说话的（`README.md:81`）。

父看到的原文在 `:115`：`Background subagent <child-id> finished and will do no further work unless you send it more.`，后面跟 `Its closing message:` 与收尾内容，没有收尾内容则是 `It left no closing message.`。

它的 provenance 是 `{ kind: 'subagent-settled', form: 'notice' }`，**和子自己写的 `subagent-report` 是不同的 kind**，免得转录把 runtime 写的话记到子头上（同 `:81`）。空闲的父会为它起一个 turn，忙的父则被引导到最近的 step 边界。

于是就有了这条容易踩的账：一个既 `report` 又结算的 continuable 子，父要**同时**付两笔（`README.md:119`）。而 `report` 默认还是 `wakeup`，嵌套子频繁上报会把模型开销放大——report 包的 README 自己把这条列为已知限制，并建议能接受"上报被延迟读取"的部署改用 `quiet`（`packages/subagent/tool-subagent-report/README.md:66`）。

后台 one-shot 是第四种形态，但它不是新通道：它注册一个普通 Task，返回 `started background subagent job <id>`，结果要用 `job_output` 收、用 `job_kill` 停（`packages/subagent/tool-subagent/README.md:13`、`:40`；生成这句工具描述的代码在 `src/index.ts:305`）。

---

## 列出、发消息、中止

三个控制类工具由 `@deepseek-ai/dsh-tool-subagent-control` 注册一次，而不是每个委派工具各注册一份。根插件只注册 `send_message` 和 `interrupt_agent`，`list_agents` 在它单独可加载的 `./list-agents` 子插件里（`packages/subagent/tool-subagent-control/README.md:5`）。

三个工具各自能作用到谁，取决于目标在委派树上的位置：

```mermaid
flowchart TD
    R["<b>父</b>"]
    C1["<b>depth 1 的 continuable 子</b><br/>list_agents 默认列它"]
    C2["<b>depth 2 的孙</b><br/>只有 descendants 范围看得见"]
    O["<b>one-shot 子</b><br/>不出现在 list_agents 里"]
    N["<b>interrupt 只停当前那个 turn</b><br/>排队消息保留，孙子继续跑，子还能继续对话"]

    R -- "send_message 只能发给 depth 1" --> C1
    R -- "interrupt_agent 任何活祖先都能停后代" --> C2
    R --> O
    C1 --> C2
    C2 -.-> N

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class C1,C2 main
    class R,O entry
    class N note
```

| 工具 | 作用范围 | 边界 |
|---|---|---|
| `send_message(subagent_id, message)` | 只有 depth-1 的 continuable 子 | 变成子的**下一个** FIFO turn；不能改写正在跑的 turn，也不返回子的回答，失败就意味着"没送到" |
| `interrupt_agent(agent_id)` | 任何记录在 Activation 血缘里的活祖先→后代 | 只停目标当前这个 turn；对已结束的目标是可接受的 no-op |
| `list_agents(scope?)` | continuable 子；`descendants` 走整棵树 | 快照而非送达承诺，无分页无上限 |

出处：`send_message` 见 `docs/tool-catalog.md:1556`，`interrupt_agent` 见 `docs/tool-catalog.md:1513`。

`interrupt_agent` 的边界比名字看起来窄得多：排队消息原地保留，它起的孙子继续跑，子本身仍然可以继续对话。它的授权范围**故意**比 `send_message` 宽，理由是"停一个 turn 是幂等的，而且不投递任何内容"（`packages/subagent/subagent/README.md:97`）。

`list_agents` 的 `descendants` 范围会标注 `parent=<id> depth=<n>`。**one-shot 子不会出现在列表里**；只有 depth-1 的才是 `send_message` 的候选，更深的只能 `interrupt_agent`（`packages/subagent/tool-subagent-control/README.md:11`）。

它返回的三个状态里 `ready` 最容易读错：它表示"只在存储里、可恢复"，**不是终态，也不是一个等着被收取的结果**（`docs/tool-catalog.md:1534`）。

整个列表是快照，不是送达承诺（`packages/subagent/tool-subagent-control/README.md:75`）——`send_message` 自己会做权威检查并可能失败（`docs/tool-catalog.md:1534`），`interrupt_agent` 自己做权威的活血缘检查，所以拿到过期结果也不会凭空授权（`README.md:75`）。它没有分页也没有上限，一个长期存在、子很多的父，每次调用都要为整张表付 token（`:65`、`:76`）。

---

## 把整轮交给外部真实进程：codex 与 claude-code（默认没装）

这两个 provider 不在 dsh 里跑模型，而是起真正的产品进程，把一整个任务扔进去，只把最终答案取回来。

| | `codex` | `claude-code` |
|---|---|---|
| 起什么 | `codex app-server --stdio`，一个 ephemeral thread、恰好一个 turn | 官方 Claude Agent SDK `query()`，一个原生 `claude` 进程 |
| 可选能力 | 全部不支持 | 全部不支持 |
| 配置/登录态从哪来 | 宿主机原生 codex 配置与认证 | 宿主机原生 user/project/local Claude 设置与账号态 |
| 无人值守下的审批 | 选一个非审批决定，优先 `cancel`；未知请求 fail closed | `AskUserQuestion` 关闭，无任何交互回调 |
| 特殊停止原因映射 | `contextWindowExceeded` → `max-tokens` | 既不产生 `max-tokens` 也不产生 `refusal` |
| 出处 | `packages/subagent/subagent-codex/README.md:5,13,15,19,28` | `packages/subagent/subagent-claude-code/README.md:5,9,11,17,19,23` |

现在说本节最要紧的一条：**这两个 provider 不在任何 shipped 组合里。**

这句话的后果要沿着注册链走一遍才看得清，它断在中间那一环：

```mermaid
flowchart TD
    A["<b>preset 里那行委派工具</b><br/>写着 disabled: true，注释教你复制一份 preset 再删掉它"]
    B["<b>删掉 disabled</b>"]
    Q{"provider 行在不在"}
    D["<b>tool-subagent 只在它的 provider 存在时注册</b>"]
    E["<b>工具永远不会出现</b><br/>base / web-app / apps-cli 里都没有这两行，连 npm 依赖都不是"]
    OK["<b>工具注册成功</b><br/>能力全零，maxDepth 必须写 provider-managed"]
    FIX["<b>两段式挂载</b><br/>先 insert 两个 provider 行，再 insert 两个委派工具行"]

    A --> B --> Q
    Q -- "不在，默认发行版就是这样" --> D --> E
    Q -- "在" --> OK
    E -- "怎么补" --> FIX --> Q

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class B,OK,FIX main
    class A,Q entry
    class D,E danger
```

三个 preset 确实各带一行 `disabled: true` 的委派工具（以 `apps/cli/config/agent-presets/code/agent.cordis.yml:204`–`220` 为例，`standard` 在 `:203`/`:212`、`cordis` 在 `:191`/`:200`），preset 注释也确实教你"复制一份 preset 再删掉 `disabled`"（`:201`–`:203`）。

但光删 `disabled` 不够。`@deepseek-ai/dsh-subagent-codex` / `-claude-code` 这两个 **provider 行**在 base bundle、web-app bundle、`apps/cli` 里都不存在，连 npm 依赖都不是——`packages/bundle/base/tests/base.spec.ts:38`–`41` 是一条专门断言它们缺席的测试。

而 `tool-subagent` 只在它的 provider 存在时才注册（`packages/subagent/tool-subagent/README.md:9`），provider 行缺了，那个工具就永远不会出现。两份包 README 里的 "shipped profiles load this provider once on the host"（codex `:30`、claude-code `:34`）与仓库配置对不上。

要真的用起来，仓库里唯一能找到的完整形状是 `examples/acp-agent/product-subagent-both.cordis.yml:9`–`27`：**先 insert 两个 provider 行，再 insert 两个委派工具行**。两个包各自 README 的挂载片段（`subagent-codex/README.md:32`–`47`、`subagent-claude-code/README.md:36`–`51`）也是这个两段式，配置项只有 `env` 与 `disposeGraceMs` 两项。

装上之后，代价逐条是：

- **凭据不会自动流过去。** subprocess seam 会把 credential 形状的环境变量从子环境里剥掉，所以要给子用的 API key 必须显式写进 `env`；`PATH` / `HOME` 这类普通变量仍然继承（`subagent-codex/README.md:28`；claude-code 同义在 `:32`）。
- **能力全部为零。** 输出 schema、子 persona、工具过滤、harness 侧深度限制，都会被共享服务对这两个 provider 直接拒绝（`subagent-claude-code/README.md:97`、`subagent-codex/README.md:90`），所以 `maxDepth` 必须写 `provider-managed`。
- **只有最终文本。** 推理、中间消息、工具流量、stderr、工作区 diff 全部留在产品本地，父会话一个字也拿不到（`subagent-codex/README.md:89`、`subagent-claude-code/README.md:96`）。
- **不可枚举、不可续。** 一次运行一个进程、一个 thread/query、一个 turn，没有续聊、没有 resume、没有池化（`subagent-codex/README.md:85`、`subagent-claude-code/README.md:91`）；远程 provider 没有本地子 Session，因此也不进持久枚举（`docs/subsystems/subagent.md:404`）。
- **宿主设置是权威的。** 项目级/用户级设置能改掉模型、工具和行为，provider 不提供过滤，也不提供密闭模式（`subagent-claude-code/README.md:92`）。
- **没有墙钟超时，也没有副作用回滚。** 长任务只能靠调用方取消，取消前改过的文件不会还原（`subagent-codex/README.md:91`、`subagent-claude-code/README.md:98`，两份 README 各自的最后一条）。

---

## workflow：worker thread 里的一段脚本

`ctx.workflowEngine` 的形状和 `ctx.subagents` 不一样：它**一个 context 只允许一个引擎**，没有按名字的注册表，换引擎是换配置而不是并存（`docs/subsystems/workflow.md:5`）。

当前唯一实现是 `dsh-workflow-worker-thread`（同文件 `:7`），它的分布方式是**一次运行一个 worker thread，脚本的 vm context 在 worker 里，子 agent 仍然留在 host 上，通过一套类型化协议跨线程调用**（`packages/workflow/workflow-worker-thread/README.md:5`）。

拆线程的首要目的只有一个：同步的脚本循环不能堵住 harness 的事件循环，而一个无视取消的脚本可以连 worker 一起被 terminate。

脚本和子 agent 分居两侧，中间只有一套类型化协议：

```mermaid
flowchart LR
    subgraph WK["worker thread（一次运行一个）"]
        VM["<b>node:vm context</b><br/>塑形 API 的手段，不是安全边界"]
        G["<b>脚本能用的六样</b><br/>agent / parallel / pipeline / phase / log / args"]
    end
    subgraph HO["host 进程"]
        EG["<b>ctx.workflowEngine</b><br/>一个 context 只允许一个引擎"]
        SA["<b>ctx.subagents</b><br/>子 agent 仍然留在 host 上"]
        CH["<b>子 Session × N</b>"]
    end

    EG -- "起 worker，送 meta / script / args" --> VM
    VM --> G
    G -- "agent() 跨线程调用，structured-clone + 纯 JSON 校验" --> SA
    SA --> CH
    CH -- "结果回传" --> G
    G -- "脚本 return 的东西，过 materializeFromRealm" --> EG

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    class VM,G main
    class CH data
    class EG,SA entry
```

**它不是安全沙箱。** `node:vm` 在这里是"塑形 API"的手段，逃逸出去的脚本能拿到宿主进程的权限（`README.md:9`、`:13`、`:120`）。

它给的是有用的**收容**而非隔离：CPU 自旋不影响 host，`worker.terminate()` 是真的终点，worker 以空环境启动（除去未构建时的 loader 管线）所以环境变量里的凭据不会漏过去，跨线程消息走 structured-clone 并在脚本边界做纯 JSON 校验（`:15`–`:20`）。

脚本里能用的全部东西就六样，`packages/workflow/workflow-worker-thread/src/runtime.ts:100`–`113` 把它们作为数据属性写进 vm context。

`agent(prompt, opts?)` 跑一个子 agent 到结束。没有 `schema` 就返回最终文本，有 `schema` 就返回校验过的对象。子自己失败返回 `null`，所以脚本里 `.filter(Boolean)` 是常规动作；但 opts 用错是 fatal。

`parallel(thunks)` 并发跑一组零参函数并 **全部** await。它本质是一道栅栏，只在某一阶段真的需要全部前序结果时才该用。单个 thunk 抛异常那一项变 `null`，fatal 透传（`runtime.ts:413`–`424`）。

`pipeline(items, ...stages)` 让每个 item 独立走完所有 stage，**阶段之间没有栅栏**，stage 收到的是 `(prev, item, index)`。普通异常会让该 **item** 变成 `null` 并跳过它剩下的 stage，fatal 同样透传（`runtime.ts:443`–`457`）。

两个组合子的形状差别就在有没有那道栅栏：

```
parallel(thunks):
    out = []
    并发跑所有 thunk，全部 await 完才返回      // 这就是那道栅栏
    每个 thunk：普通异常 → out[i] = null
                fatal   → 重新抛出，脚本死

pipeline(items, ...stages):
    对每个 item 独立地：                        // item 之间不互相等
        prev = undefined
        for index, stage in stages:
            prev = stage(prev, item, index)
            普通异常 → 该 item 置 null，跳过它剩下的 stage
            fatal    → 重新抛出，脚本死
```

```mermaid
flowchart LR
    subgraph PA["parallel(thunks) · 一道栅栏"]
        A1["thunk 1"]
        A2["thunk 2"]
        BAR["<b>全部 await 完才往下</b>"]
        A1 --> BAR
        A2 --> BAR
    end
    subgraph PI["pipeline(items, stages) · 阶段之间没有栅栏"]
        I1["item 1"] --> S1["stage A"] --> S2["stage B"]
        I2["item 2"] --> S3["stage A"] --> S4["stage B"]
    end

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    class BAR,S1,S2,S3,S4 main
    class A1,A2,I1,I2 entry
```

`phase(title)` 是纯进度分组，**没有任何执行语义**，`meta.phases` 只是一张标题词表（`docs/subsystems/workflow.md:41`）。传非空字符串以外的东西是 fatal（`runtime.ts:470`–`477`）。

`log(message)` 叙述一行，非字符串是 fatal（`runtime.ts:480`–`486`）。`args` 就是工具调用的 `args`，原样送进来。

这里的分界线要记清楚：`parallel` 与 `pipeline` 的 per-item `null` **只留给子运行失败和阶段内的普通脚本错误**。

hook 误用（参数不对、未知选项、schema 越界、撞到上限、seam 启动失败、取消）抛的是 `fatal: true` 的 `WorkflowError`，两个组合子会**重新抛出**而不是把它变成 `null`（`docs/subsystems/workflow.md:116`；实现见 `runtime.ts:421` 与 `:454`）。判定用的是跨 realm 的 `instanceof`，脚本自己造的对象伪造不出 fatal——判定函数在 `packages/workflow/workflow/src/index.ts:146`–`148`。

引擎侧的闸门（`packages/workflow/workflow-worker-thread/README.md:77`–`84`）：

| key | 默认 | 含义 |
|---|---|---|
| `provider` | `spawn` | `agent()` 用哪个 host 侧 provider |
| `maxConcurrentAgents` | `0` | 并发上限，`0` = 按 CPU 并行度解析 |
| `maxTotalAgents` | `1000` | 单次运行的 `agent()` 总数 |
| `maxItemsPerCall` | `4096` | 一次 `parallel()` / `pipeline()` 接受的条目数 |
| `syncTimeoutMs` | `5000` | 脚本首个同步切片的 vm 超时 |
| `disposeGraceMs` | `5000` | 强制结算 / terminate 的宽限 |

脚本**看不见也换不掉** provider：`subagentProvider` 与 `maxTotalAgents` 是引擎级策略，普通 `workflow` 工具两者都不设（`README.md:86`）。

---

## 跑一个最小 workflow

第一条路是在会话里让模型调用 `workflow` 工具——脚本你不写，模型写。前提是当前 preset 里有那两行：先挂 `workflow-worker-thread` 并把 `provider` 指到 `spawn`，再挂 `tool-workflow`（`apps/cli/config/agent-presets/code/agent.cordis.yml:222`–`228`）。

第二条路是自己驱动引擎。

下面这段改编自 `packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.e2e.ts:31`–`60` 与 `:79`–`:84`，插件清单、`create` 形状、`start` 调用形状都与原测试一致。三处改动：

| 改动 | 为什么 |
|---|---|
| import 换成包名 | 原测试用相对路径 `../src/index.ts` |
| `sessionId` 显式用 `SessionId()` 品牌构造器 | `CreateAgentOptions.sessionId` 是品牌类型，裸字符串过不了类型检查（`packages/core/session/src/types.ts:29`） |
| 第二个 `agent()` 的 prompt 与 schema 做了精简 | 原文还有一个 `confidence` 字段 |

它需要环境变量 `DEEPSEEK_API_KEY`（`packages/llm/llm-deepseek/src/index.ts:45`），原测试没有 key 时会自跳过，本教程**未实际运行过它**。

```ts
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(LlmDeepSeek)
await ctx.plugin(SubagentRuntime)
await ctx.plugin(Spawn, { providerName: 'spawn' })
await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })

const parent = await ctx.agents.create({
  sessionId: SessionId('wf-demo-session'),
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
})

const run = ctx.workflowEngine.start({
  meta: {
    name: 'e2e-worker-arithmetic',
    description: 'two real children: one prose, one structured',
    phases: [{ title: 'Ask' }, { title: 'Judge' }],
  },
  script: `phase('Ask')
log('asking the prose child')
const prose = await agent('Reply with exactly one short sentence: what is 2 + 2?')
phase('Judge')
const judged = await agent(
  'Does this answer contain the number 4? ' + prose,
  { schema: { type: 'object', properties: { containsFour: { type: 'boolean' } }, required: ['containsFour'] } },
)
return { prose, containsFour: judged === null ? null : judged.containsFour }`,
  parent: parent.agent,
})

const result = await run.result
await run.dispose()
console.log(result.stopReason, result.agentsStarted, result.value)
```

期望输出是 `completed 2 { prose: '…', containsFour: true }`（原测试对这三项的断言在 `:83`–`:89`）。注意 `start()` 是同步返回 `WorkflowRun` 的，不要 `await` 它（`packages/workflow/workflow/src/index.ts:168`）。

三件运行契约必须记住：

| 契约 | 说明 |
|---|---|
| `run.result` 永远不 reject | 脚本失败 resolve 成 `stopReason: 'error'`，取消在宽限内 resolve 成 `cancelled` |
| 每条路径都必须 `dispose()` | 等价于 cancel + 有界结算 + 子静默，卡死的脚本也不会把它挂住（`docs/subsystems/workflow.md:95`） |
| 返回值要过 `materializeFromRealm` | 函数、symbol、循环、稀疏数组、非有限数、嵌套 `undefined`、奇异原型一律拒绝（`packages/workflow/workflow-worker-thread/README.md:53`） |

`schema` 那边也有子集限制：只接受**以对象为根**、且只用 `type/properties/required/additionalProperties/items/enum/const/oneOf` 的写法，`pattern`、`format`、数值边界都不行（`docs/tool-catalog.md:1743`）。

---

## isolation 为什么会把脚本直接打死

脚本里写 `agent(prompt, { isolation: 'container' })`，得到的不是"被忽略"，是脚本**当场死亡**。

机制在 `packages/workflow/workflow-worker-thread/src/runtime.ts`，四行凑出来的：

```
:39   支持的选项 = label / phase / schema / provider / model
:41   deferred 选项 = effort / isolation / agentType

opts 里出现一个陌生 key：
    if key in deferred 选项:  throw WorkflowError(UNSUPPORTED_OPTION, "该选项是 deferred、本引擎不支持")   // :371
    else:                     throw WorkflowError(UNSUPPORTED_OPTION, "该选项无法识别")                   // :373
```

两处都是 `UNSUPPORTED_OPTION`，两处都没传 `fatal`，而 `WorkflowError` 的 `fatal` 默认就是 `true`（`packages/workflow/workflow/src/index.ts:137`），所以都会杀掉脚本。

什么变成 `null`、什么当场杀掉脚本，分界线在这里：

```mermaid
flowchart TD
    E["<b>脚本跑着出事了</b>"]
    Q{"是哪一类"}
    N1["<b>子 agent 自己运行失败</b><br/>agent() 返回 null，所以脚本里常写 filter(Boolean)"]
    N2["<b>阶段内的普通脚本错误</b><br/>parallel 把该项、pipeline 把该 item 置 null"]
    D1["<b>fatal 的 WorkflowError</b><br/>参数不对 / 未知选项 / schema 越界 / 撞上限 / seam 启动失败 / 取消"]
    D2["<b>parallel 与 pipeline 重新抛出</b><br/>脚本当场死亡"]
    ISO["<b>deferred 选项</b><br/>effort / isolation / agentType，报错点名自己"]

    E --> Q
    Q -- "子运行失败" --> N1
    Q -- "普通异常" --> N2
    Q -- "hook 误用" --> D1 --> D2
    ISO --> D1

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class N1,N2 main
    class E,Q entry
    class D1,D2 danger
    class ISO note
```

为什么要这么狠？

因为 dsh 的 workflow 脚本契约刻意对齐了 Claude Code 的 dynamic workflows 词表（`.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md:9`、`:17`），CC 那边有、这边没实现的选项，读者是真的会写出来的。

而这个仓库明令禁止"接受然后忽略"：一个拼错的选项如果只是变成一个 `null`，它就和"子 agent 运行失败"完全无法区分——这正是 `parallel` / `pipeline` 选择**重新抛出** fatal 而不是把该项置 `null` 的同一个理由（`:19`）。`effort` / `isolation` / `agentType` 与"嵌套 `workflow()`"、"token `budget`"一起被列为 deferred，各自报错时都会点名自己（`:62`）。

顺带分清两个容易混的东西：workflow 脚本里没有 `isolation`，而 `ctx.codeRuntime`（[21 章](./21-CodeMode.md)的 Code Mode）确实有一个 `isolation` 描述符，取值 `'worker-thread' | 'process' | 'container'`——但文档明写它**只是诊断标签，不构成安全承诺**（`docs/subsystems/code-runtime.md:161`）。

---

## 一句话带走

**子 agent 是 provider、delegation tool 实例、父的 standing composition 三层拼出来的，模型和 persona 在委派那一刻就钉死；workflow 则是另一件事——它把调度逻辑一次性交给一段脚本，中间结果对父不可见。**

判断标准可以简化成一句：中间结果你希望父看见吗？希望，就一次委派一个；不希望、而且路数固定，就写 workflow。

---
