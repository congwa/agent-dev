# 18 · 子 agent 与 workflow

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章讲 dsh 把活派出去的两条路：一次委派一个子 agent，和让模型写一段 JavaScript 脚本一口气调度几十个子 agent。

**读完这章你会**：

- 在 agent preset 里加一个自己的委派工具，指定它的 provider、模型、persona、工具白名单、深度上限
- 说清 `spawn` 和 `fork` 差在哪一件事上，以及为什么 fork 的子 agent 在 shipped preset 里跟包 README 说的不一样
- 找到子会话的转录，读懂它 header 上那几个字段
- 分清子 agent 把结果送回父会话的**三条互不相干**的通道，以及各自会不会额外烧掉一次模型请求
- 挂上 `codex` / `claude-code` 两个"把整轮交给外部真实进程"的 provider（**默认发行版里根本没装**，见第 7 节），并说得出代价
- 写一个最小 workflow 脚本，知道 `agent / parallel / pipeline / phase / log` 各自的失败语义，以及 `isolation` 为什么会把脚本直接打死

---

## 1. 从一个具体场景开始：十五个文件要审一遍

你让 agent 审十五个文件。它可以自己一个个读——十五份文件内容全部堆进这一个会话的上下文，读到后面就要触发压缩（阈值由部署配置决定，见第 16 章）。dsh 给了两条别的路：

```
父 agent 的一条 assistant message
├── subagent(prompt)               → 起 1 个子 Session，一次委派
│                                     子的中间步骤留在子会话，父只拿最终答案
└── workflow(meta, script)         → 起 1 个 worker thread 跑你的脚本
                                      脚本里的 agent() × N → N 个子 Session
                                      父只拿脚本 return 的那个 JSON
```

两者的分工，官方注入给模型的那段提示词写得很直白：**一两个委派就用 subagent，明确要"工作流/大规模编排"才用 workflow**（`packages/workflow/tool-workflow/README.md:41` 的原文如此）。

| | 一次委派 | workflow 脚本 |
|---|---|---|
| 谁写调度逻辑 | 父模型，一轮一个决定 | 父模型一次写完整段脚本 |
| 中间结果落在哪 | 每次委派的结果都进父上下文 | 留在脚本变量里，父看不见 |
| 并发 | 靠一条 message 里发多个工具调用（`packages/subagent/tool-subagent/README.md:32`） | `parallel` / `pipeline`，引擎管并发闸门 |
| 能不能接着聊 | continuable 模式可以 | 不能，一次跑完就结束（`docs/tool-catalog.md:1752`） |
| 出处 | `packages/subagent/` | `packages/workflow/` |

---

## 2. dsh 里的"一个子 agent"由三层拼出来

这里最容易误解：dsh **没有**"一个 markdown 文件定义一个子 agent"那种东西。一个子 agent 的形态由三层决定。

**第一层：provider（传输方式）。** `ctx.subagents` 是一个按名字注册的**多实例**注册表——和只允许一个实现的 bash 执行器不同，多个 provider 可以同时在线（`docs/subsystems/subagent.md:5`）。

| provider 包 | 子 agent 跑在哪 | `inheritsParentContext` |
|---|---|---|
| `subagent-spawn-in-process` | 本进程，全新会话（`README.md:5`） | `false`（`src/index.ts:44`） |
| `subagent-fork-in-process` | 本进程，带父的已完成对话（`README.md:5`） | `true`（`src/index.ts:64`） |
| `subagent-acp` | 进程外，走 ACP | `false`（`src/index.ts:149`） |
| `subagent-dsh-sdk` | 进程外，走 TypeScript SDK | `false`（`src/index.ts:96`） |
| `subagent-codex` / `subagent-claude-code` | 外部真实产品进程 | `false`（`src/index.ts:50` / `:55`，见第 7 节） |

包与角色的全表见 `packages/subagent/README.md:9`–`19`。`inheritsParentContext` 这个字段**只描述"子看不看得见父的已完成对话"**，不描述工具、服务或权限的继承（`docs/subsystems/subagent.md:408`）。

**第二层：delegation tool 实例。** 一个 `@deepseek-ai/dsh-tool-subagent` 实例 = 一个 provider + 一个模型可见的工具名。想要"另一个模型 / 另一套 persona / 另一份工具白名单"，就再加一个实例，改不了同一个实例的策略（`packages/subagent/tool-subagent/README.md:82`）。配置项与默认值在 `packages/subagent/tool-subagent/src/index.ts:81`–`99`（Schema 定义），字段语义在同文件 `:30`–`:78` 的类型注释里：

| key | 默认 | 说明 |
|---|---|---|
| `provider` | 必填 | `ctx.subagents` 上的 provider 名 |
| `toolName` | `subagent` | 模型看到的名字，每个实例必须不同 |
| `enableRunInBackground` | `true` | 关掉后 schema 里没有这个参数，显式传 `run_in_background: true` 也会在执行期被拒（`src/index.ts:254`–`255`） |
| `backgroundMode` | `one-shot` | `one-shot` 默认前台；`continuable` 默认后台并返回一个持久子 id |
| `agentOptions` | 省略 | 子的 `provider` / `model` / `maxTokens` |
| `persona` | 省略 | 只影响这个子，遮蔽部署 persona |
| `toolFilter` | 省略 | `allow` / `deny`；被过滤的工具**既从 prompt 消失也拒绝执行** |
| `maxDepth` | `3` | `0` = 禁止再委派；`'provider-managed'` = 不下发上限 |

**第三层：preset 决定子 agent 看得见哪些工具。** 子 agent **不会**重新挂载 preset，而是通过 `composeFrom()` 绑到父正在跑的那份 **standing composition**（父这次会话实际跑着的那棵插件树）上（`packages/preset/agent-presets/README.md:35`）。所以父在 `minimal` preset 下，子也在 `minimal` 下。而 `apps/cli/config/agent-presets/minimal/agent.cordis.yml` 全文 62 行、`subagent` 与 `workflow` 一个字都没有——从 minimal 出发的会话根本没有委派工具。

> 想知道这一点上 Pi / Codex / LangChain 怎么做，见 [三个 agent 系统源码解剖](../2026-08_三个agent系统源码解剖/00-总览与阅读指南.md)。

### 最小可用配置

下面这段抄自 `examples/headless-agent/cordis.yml` 的 `:91`–`:92`、`:94`–`:97`、`:113`–`:119` 三段（原文注释、fork 那条链、`tool-subagent-control` 与 `tool-subagent-report` 都没抄进来，只留 spawn 一条路）：

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

**这里最容易踩的**：在 web / CLI 形态下，上面这种"写在 profile 根上的行"不生效。`packages/bundle/web-app/cordis.patch.yml:374`–`396` 把 base bundle 里的 `tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`、`workflow-worker-thread`、`tool-workflow` 全部 `disabled: true`，改由 preset 提供；preset roster 在同文件 `420`–`424` 挂载，默认 preset 是 `standard`。**registry 和 provider 留在 host 层（进程单例，一个名字只能注册一次），preset 只挑"这个 agent 看见哪些委派工具"**——`apps/cli/config/agent-presets/code/agent.cordis.yml:166`–`170` 的注释原话，`packages/bundle/web-app/cordis.patch.yml:367`–`372` 是同一段话的另一处。所以你要加自己的委派工具，改的是 preset 目录里的 `agent.cordis.yml`，不是 profile。

两个挂载期就会响亮失败的配置错误（`packages/subagent/tool-subagent/src/index.ts:285`–`296`）：给一个没有 `depthLimit` 能力的 provider 配了数字 `maxDepth`；给一个没有 `prepareContinuable` 的 provider 配了 `backgroundMode: continuable`。这也是为什么 codex / claude-code 那两行必须写 `maxDepth: provider-managed`。

---

## 3. spawn 与 fork：差别只有 seed 一项

`fork` 与 `spawn` 共用同一个 run driver，唯一的行为差异是会话种子（`packages/subagent/subagent-fork-in-process/README.md:5`）。

关键在种子的边界。父起子 agent 的那一刻，父自己的 turn 还开着：日志里有 assistant 的工具调用，但没有对应的 tool result，也没有 `turn/end`。直接抄过去会给子一个不平衡的非法会话。所以 fork 取的是**到最后一个 `turn/end` 为止的连续前缀**（`README.md:9`–`11`）；父还没跑完一个 turn 时种子为空，fork 退化成 spawn。

种子只搬对话历史。子拿到的是**全新的扁平注册作用域**，不继承父的工具限制，也不继承任何权限（`README.md:13`）。

**一个文档与配置对不上的地方（以配置为准）**：三处官方文字都说 fork 的委派工具在所有 shipped 组合里是 one-shot——`packages/subagent/subagent-fork-in-process/README.md:42` 与 `:61`、`docs/tool-catalog.md:1505`（"`subagent_fork` stays `one-shot`"）。而专门为这件事写的 Agent Note 把"所有 shipped 组合"逐个点名，只有三个：base bundle、ACP 示例、headless 示例（`.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md:15`），并在结论里承认"约束只活在三个配置文件和一句代码注释里，不是一道 gate——将来某个 bundle 行或 profile patch 把 fork 设成 `continuable`，不会有任何东西响亮失败"（同文件 `:49`）。

实际配置正是如此：base bundle（`packages/bundle/base/cordis.patch.yml:329`）与两个 example（`examples/headless-agent/cordis.yml:129`、`examples/acp-agent/cordis.yml:132`）确实是 one-shot；但**四个 shipped agent preset 里有委派工具的那三个，fork 全是 `continuable`**——`apps/cli/config/agent-presets/standard/agent.cordis.yml:198`、`code/agent.cordis.yml:199`、`cordis/agent.cordis.yml:186`（第四个 `minimal` 一条委派工具都没有）。而 web 形态用的正是 preset。这就是 Note 预告的那个无声漏洞已经发生了。

---

## 4. 子会话就是一个普通 Session，这意味着什么

本地 provider 在 `start()` 返回之前就**先发布一个普通的子 agent / 子 Session**，把这个 session id 当作 `SubagentRun.id`（`packages/subagent/subagent/README.md:69`）。不是"运行记录"，就是会话本身。带来四件具体的事：

**一、header 上多了几个字段。** `packages/subagent/subagent/src/child-agent.ts:102`–`119` 一次写全：

| 字段 | 值 |
|---|---|
| `cwd` | 继承父 header（`:110`） |
| `agentPreset` | 从父的**活作用域链**读，不是从父 header 读（`:108`，理由在 `:91`–`:93`） |
| `parentSession` | 父 session id（`:112`） |
| `origin` | 固定 `'subagent'`（`:115`） |
| `delegationDepth` | 父深度 + 1（`:49`）；持久化且单调，冷恢复只能加不能减（`README.md:55`） |
| `seedLength` | 只在种子非空时才写，记录前多少条事件来自父（`:118`）——实际上只有 fork 会写 |

**二、枚举靠 header 而不是靠一张运行表。** `listChildren()` 直接合并活会话存储与可选的会话持久化，在里面挑 `parentSession` 匹配且 `origin === 'subagent'` 的直接子（`packages/subagent/subagent/src/list-children.ts:141`–`142`），**不加载、不恢复任何 Agent，也不需要 query 服务**（`README.md:25`）。`listDescendants()` 走同一套语料的整棵树，普通会话和 one-shot 子仍然是可穿过的中间节点（`README.md:26`）。

**三、子的权限在委派那一刻就钉死。** `captureDelegatedPolicyOverrides(parent)` 快照父会话**显式**的沙箱覆盖，并在审批能力被组合进来时把子的审批策略钉成 `'never'`——不管父自己是什么策略；这些以 `source: 'delegation'` 的事件写进子自己的日志，位置在 fork 种子之后，所以新策略盖过旧种子状态（`README.md:61`）。子还会拿到一段固定的运行时上下文语句，原文在 `README.md:134`：需要更大权限时**不要重试**，把限制写进回复交给父处理。

**四、深度是持久的。** 数字 `maxDepth` 超了会得到确定的报错文本 `Error: subagent depth <attempted> exceeds maxDepth <max>`（`packages/subagent/subagent-in-process-driver/README.md:89`，构造点在 `child-agent.ts:33`）。

---

## 5. 报告怎么回到父会话：三条互不相干的通道

这是本章最容易糊涂的地方。**三条通道彼此独立，都可能同时发生，父都要付 token。**

| 通道 | 谁发起 | 父看到什么 | 会不会额外起一个 turn |
|---|---|---|---|
| 前台 tool result | 父自己 await | 只有子的最终文本；非 `completed` 变成 `Error: <message>` 并把残留文本附在停止原因后面 | 不会，就是这次工具调用的返回 |
| `report` 工具 | **子主动调** | `Background subagent <child-id> reported:` + 子的 `output` 原文 | `wakeup`（默认）起一个普通新 turn；`quiet` 只注入不请求 |
| settlement notice | **runtime 自己** | `Background subagent <child-id> finished and will do no further work unless you send it more.` + `Its closing message:` 与收尾内容（没有则 `It left no closing message.`） | 空闲父起一个 turn；忙的父被引导到最近的 step 边界 |

第一条见 `packages/subagent/tool-subagent/README.md:11` 与 `:54`。

第二条：`report` 不是全局工具，而是通过 `registerContinuableSetup` 注册的**子作用域**能力，只在 continuable 的进程内子里存在，root、one-shot 子、远程 provider 都看不到（`packages/subagent/tool-subagent-report/README.md:5`）。它**故意**穿透子的全局 `toolFilter`——白名单不能把唯一的回话通道删掉；真要一个没有回话通道的子，就别装这个包（`:11`）。它不指定收件人：`exec.agent` 就是身份凭证，收件人由服务从子的持久 `parentSession` 推出来（`:7`）。父侧看到的那句框（含 `{ kind: 'subagent-report', senderSessionId }` 溯源）在 `:49`。`reportDelivery` 是部署策略、模型改不了；默认 `wakeup` 的理由是"已经停下来的父没有别的理由回头看"（`:9`）。

第三条：**Activation**（一个 continuable 子在本进程里的一段常驻期，不是请求也不是结果，`packages/subagent/subagent/README.md:73`）结算时，管理器**无条件**给父发一条账目，不看子有没有调过 `report`——因为最需要交代的收尾（撞上下文上限、模型失败、被取消、被拆），恰恰是子来不及自己说话的那些（`README.md:81`）。它的 provenance 是 `{ kind: 'subagent-settled', form: 'notice' }`，**与子自己写的 `subagent-report` 是不同的 kind**，免得转录把 runtime 写的话记到子头上（同 `:81`）。父侧原文在 `:115`。

**这里最容易踩的**：一个既 `report` 又结算的 continuable 子，父要**同时**付两笔（`README.md:119`）。而且 `report` 默认 `wakeup`，嵌套子频繁上报会放大模型开销——report 包的 README 自己把这条列为已知限制，并说接受"上报被延迟读取"的部署应该改用 `quiet`（`packages/subagent/tool-subagent-report/README.md:66`）。

后台 one-shot 是第四种形态但不是新通道：它注册一个普通 Task，返回 `started background subagent job <id>`，结果要用 `job_output` 收、用 `job_kill` 停（`packages/subagent/tool-subagent/README.md:13`、`:40`；生成这句工具描述的代码在 `src/index.ts:305`）。

---

## 6. 控制类工具：列出、发消息、中止

三个全局工具由 `@deepseek-ai/dsh-tool-subagent-control` 注册一次（而不是每个委派工具各注册一份）；根插件只注册 `send_message` 和 `interrupt_agent`，`list_agents` 在它单独可加载的 `./list-agents` 子插件里（`packages/subagent/tool-subagent-control/README.md:5`）。

| 工具 | 干什么 | 硬边界 |
|---|---|---|
| `send_message(subagent_id, message)` | 变成子的**下一个** FIFO turn | 不能改写正在跑的 turn；不返回子的回答；失败即"没送到"（`docs/tool-catalog.md:1556`） |
| `interrupt_agent(agent_id)` | 停掉目标当前 turn | 只停当前 turn：排队消息原地保留，它起的孙子继续跑，子本身仍可继续对话；已结束的目标是可接受的 no-op（`docs/tool-catalog.md:1513`） |
| `list_agents(scope?)` | 列 continuable 子；`descendants` 走整棵树并标注 `parent=<id> depth=<n>` | **one-shot 子不会出现**；只有 depth-1 才是 `send_message` 候选，更深的只能 `interrupt_agent`（`packages/subagent/tool-subagent-control/README.md:11`） |

`list_agents` 的三个状态里 `ready` 最容易误读：它表示"只在存储里、可恢复"，**不是终态，也不是一个等着被收取的结果**（`docs/tool-catalog.md:1534`）。这个列表是快照不是送达承诺（`packages/subagent/tool-subagent-control/README.md:75`）：`send_message` 自己会做权威检查并可能失败（`docs/tool-catalog.md:1534`），`interrupt_agent` 则自己做权威的活血缘检查，所以发现结果过期不会凭空授权（`README.md:75`）。它也没有分页和上限，长期存在、子很多的父每次调用都要付整张表的 token（`:65`、`:76`）。

`interrupt` 的授权范围**故意**比 `send_message` 宽：任何记录在 Activation 血缘里的活祖先都能停掉后代，理由是"停一个 turn 是幂等的，而且不投递任何内容"（`packages/subagent/subagent/README.md:97`）。

---

## 7. 把整轮交给外部真实进程：`codex` 与 `claude-code`

这两个 provider 不在 dsh 里跑模型，而是起真正的产品进程，把一整个任务扔进去，只把最终答案取回来。

| | `codex` | `claude-code` |
|---|---|---|
| 起什么 | `codex app-server --stdio`，一个 ephemeral thread、恰好一个 turn | 官方 Claude Agent SDK `query()`，一个原生 `claude` 进程 |
| 可选能力 | 全部不支持 | 全部不支持 |
| 配置/登录态从哪来 | 宿主机原生 codex 配置与认证 | 宿主机原生 user/project/local Claude 设置与账号态 |
| 无人值守下的审批 | 选一个非审批决定，优先 `cancel`；未知请求 fail closed | `AskUserQuestion` 关闭，无任何交互回调 |
| 特殊停止原因映射 | `contextWindowExceeded` → `max-tokens` | 既不产生 `max-tokens` 也不产生 `refusal` |
| 出处 | `packages/subagent/subagent-codex/README.md:5,13,15,19,28` | `packages/subagent/subagent-claude-code/README.md:5,9,11,17,19,23` |

**这里最容易踩的，也是本节最要紧的一条**：这两个 provider **不在任何 shipped 组合里**。三个 preset 确实各带一行 `disabled: true` 的委派工具（以 `apps/cli/config/agent-presets/code/agent.cordis.yml:204`–`220` 为例，`standard` 在 `:203`/`:212`、`cordis` 在 `:191`/`:200`），preset 注释也说"复制一份 preset 再删掉 `disabled`"（`:201`–`:203`）。但**光删 `disabled` 不够**：`@deepseek-ai/dsh-subagent-codex` / `-claude-code` 这两个 **provider 行**在 base bundle、web-app bundle、`apps/cli` 里都不存在，连 npm 依赖都不是——`packages/bundle/base/tests/base.spec.ts:38`–`41` 是一条专门断言它们缺席的测试。而 `tool-subagent` 只在它的 provider 存在时才注册（`packages/subagent/tool-subagent/README.md:9`），所以缺了 provider 行，那个工具永远不会出现。两份包 README 里"shipped profiles load this provider once on the host"（codex `:30`、claude-code `:34`）与仓库配置对不上。

要真的用起来，唯一在仓库里能找到的完整形状是 `examples/acp-agent/product-subagent-both.cordis.yml:9`–`27`：**先 insert 两个 provider 行，再 insert 两个委派工具行**。两个包各自 README 里的挂载片段（`subagent-codex/README.md:32`–`47`、`subagent-claude-code/README.md:36`–`51`）也是这个两段式，配置只有 `env` 与 `disposeGraceMs` 两项。

代价，逐条：

- **凭据不会自动流过去。** subprocess seam 会把 credential 形状的环境变量从子环境里剥掉，所以要给子用的 API key 必须显式写进 `env`；`PATH` / `HOME` 这类普通变量仍然继承（`subagent-codex/README.md:28`；claude-code 同义在 `:32`）。
- **能力全部为零。** 输出 schema、子 persona、工具过滤、harness 侧深度限制，都会被共享服务对这两个 provider 直接拒绝（`subagent-claude-code/README.md:97`、`subagent-codex/README.md:90`）——所以 `maxDepth` 必须写 `provider-managed`。
- **只有最终文本。** 推理、中间消息、工具流量、stderr、工作区 diff 全部留在产品本地，父会话一个字也拿不到（`subagent-codex/README.md:89`、`subagent-claude-code/README.md:96`）。
- **不可枚举、不可续。** 一次运行一个进程、一个 thread/query、一个 turn，没有续聊、没有 resume、没有池化（`subagent-codex/README.md:85`、`subagent-claude-code/README.md:91`）；远程 provider 没有本地子 Session，因此不进持久枚举（`docs/subsystems/subagent.md:404`）。
- **宿主设置是权威的。** 项目级/用户级设置能改掉模型、工具和行为，provider 不提供过滤或密闭模式（`subagent-claude-code/README.md:92`）。
- **没有墙钟超时，也没有副作用回滚。** 长任务只能靠调用方取消，取消前改过的文件不会还原（`subagent-codex/README.md:91`、`subagent-claude-code/README.md:98`，两份 README 各自的最后一条）。

---

## 8. workflow：worker thread 里的一段脚本

`ctx.workflowEngine` 与 `ctx.subagents` 的形状不同：它**一个 context 只允许一个引擎**，没有按名字的注册表，换引擎是换配置而不是并存（`docs/subsystems/workflow.md:5`）。当前唯一实现是 `dsh-workflow-worker-thread`（`docs/subsystems/workflow.md:7`）：**一次运行一个 worker thread，脚本的 vm context 在 worker 里，子 agent 仍然留在 host 上，通过一套类型化协议跨线程调用**（`packages/workflow/workflow-worker-thread/README.md:5`）。

拆线程只有一个首要目的：同步的脚本循环不能堵住 harness 的事件循环，而一个无视取消的脚本可以连 worker 一起被 terminate。**它不是安全沙箱**——`node:vm` 在这里是"塑形 API"的手段，逃逸出去的脚本能拿到宿主进程的权限（`README.md:9`、`:13`、`:120`）。它给的是有用的**收容**：CPU 自旋不影响 host、`worker.terminate()` 是真的终点、worker 以空环境启动（除去未构建时的 loader 管线）所以环境变量里的凭据不会漏过去、跨线程消息走 structured-clone 并在脚本边界做纯 JSON 校验（`:15`–`:20`）。

脚本里能用的全部东西（`packages/workflow/workflow-worker-thread/src/runtime.ts:100`–`113` 把它们作为数据属性写进 vm context）：

| hook | 语义 | 失败时 |
|---|---|---|
| `agent(prompt, opts?)` | 跑一个子 agent 到结束。无 `schema` 返回最终文本；有 `schema` 返回校验过的对象 | 子自己失败 → `null`（用 `.filter(Boolean)` 过滤）；opts 用错 → fatal |
| `parallel(thunks)` | 并发跑零参函数并 **全部** await —— 这是一道栅栏，只在某一阶段真需要全部前序结果时用 | 单个 thunk 抛 → 该项 `null`；fatal 透传（`runtime.ts:413`–`424`） |
| `pipeline(items, ...stages)` | 每个 item 独立走完所有 stage，**阶段之间没有栅栏**；stage 收 `(prev, item, index)` | 普通抛 → 该 **item** 变 `null` 并跳过它剩下的 stage；fatal 透传（`runtime.ts:443`–`457`） |
| `phase(title)` | 纯进度分组，**没有任何执行语义**；`meta.phases` 只是标题词表（`docs/subsystems/workflow.md:41`） | 非空字符串以外 → fatal（`runtime.ts:470`–`477`） |
| `log(message)` | 叙述一行 | 非字符串 → fatal（`runtime.ts:480`–`486`） |
| `args` | 工具调用的 `args`，原样 | — |

`parallel` 与 `pipeline` 的 per-item `null` 只留给**子运行失败**和阶段内的普通脚本错误；hook 误用（参数不对、未知选项、schema 越界、撞到上限、seam 启动失败、取消）抛的是 `fatal: true` 的 `WorkflowError`，两个组合子会**重新抛出**而不是把它变成 `null`（`docs/subsystems/workflow.md:116`；实现见 `runtime.ts:421` 与 `:454`，用的是跨 realm 的 `instanceof` 判定，脚本自己造的对象伪造不出 fatal——判定函数在 `packages/workflow/workflow/src/index.ts:146`–`148`）。

引擎的闸门（`packages/workflow/workflow-worker-thread/README.md:77`–`84`）：

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

## 9. 跑一个最小 workflow

两条路。**第一条**：在会话里让模型调用 `workflow` 工具——你不写脚本，模型写；前提是当前 preset 里有那两行（`apps/cli/config/agent-presets/code/agent.cordis.yml:222`–`228`：先挂 `workflow-worker-thread` 并把 `provider` 指到 `spawn`，再挂 `tool-workflow`）。

**第二条**：自己驱动引擎。下面这段改编自 `packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.e2e.ts:31`–`60` 与 `:79`–`:84`。插件清单、`create` 形状、`start` 调用形状与原测试一致；改动有三处：import 换成包名（原测试用相对路径 `../src/index.ts`）、`sessionId` 显式用 `SessionId()` 品牌构造器（`packages/core/session/src/types.ts:29`；`CreateAgentOptions.sessionId` 是品牌类型，裸字符串过不了类型检查）、第二个 `agent()` 的 prompt 与 schema 做了精简（原文还有一个 `confidence` 字段）。它需要环境变量 `DEEPSEEK_API_KEY`（`packages/llm/llm-deepseek/src/index.ts:45`），原测试没有 key 时会自跳过；本教程**未实际运行过它**。

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

期望输出：`completed 2 { prose: '…', containsFour: true }`（原测试对这三项的断言在 `:83`–`:89`）。`start()` 是同步返回 `WorkflowRun` 的，不要 `await` 它（`packages/workflow/workflow/src/index.ts:168`）。

三件必须记住的运行契约：**`run.result` 永远不 reject**（脚本失败 resolve 成 `stopReason: 'error'`，取消在宽限内 resolve 成 `cancelled`）；**每条路径都必须 `dispose()`**，它等价于 cancel + 有界结算 + 子静默，卡死的脚本也不会把它挂住（`docs/subsystems/workflow.md:95`）。第三件：脚本 `return` 的值要过 `materializeFromRealm`——函数、symbol、循环、稀疏数组、非有限数、嵌套 `undefined`、奇异原型一律拒绝（`packages/workflow/workflow-worker-thread/README.md:53`）。

`schema` 只接受**以对象为根**、且只用 `type/properties/required/additionalProperties/items/enum/const/oneOf` 的子集，`pattern`/`format`/数值边界都不行（`docs/tool-catalog.md:1743`）。

---

## 10. 为什么 `isolation` 会被直接拒绝

脚本里写 `agent(prompt, { isolation: 'container' })`，得到的不是"被忽略"，而是脚本**当场死亡**。机制在 `packages/workflow/workflow-worker-thread/src/runtime.ts`：第 39 行列出全部受支持选项 `label / phase / schema / provider / model`，第 41 行单独列出一组"deferred"选项 `effort / isolation / agentType`，第 371 行给它们一条专门的报错——"该选项是 deferred、本引擎不支持"，与第 373 行"该选项无法识别"区分开。两者都是 `UNSUPPORTED_OPTION`；两处都没传 `fatal`，而 `WorkflowError` 的 `fatal` 默认就是 `true`（`packages/workflow/workflow/src/index.ts:137`），所以都会杀掉脚本。

为什么是这个设计：dsh 的 workflow 脚本契约刻意对齐 Claude Code 的 dynamic workflows 词表（`.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md:9`、`:17`），所以 CC 那边有、这边没实现的选项会真的被人写出来。而这个仓库明令禁止"接受然后忽略"：一个拼错的选项如果变成一个 `null`，就和"子 agent 运行失败"完全无法区分——这正是 `parallel` / `pipeline` **重新抛出** fatal 而不是把该项置 `null` 的原因（`:19`）。`effort` / `isolation` / `agentType` 与"嵌套 `workflow()`"、"token `budget`"一起被列为 deferred，各自报错时都点名自己（`:62`）。

顺带分清两个容易混的东西：workflow 脚本里没有 `isolation`，而 `ctx.codeRuntime`（第 20 章的 Code Mode）确实有一个 `isolation` 描述符，取值 `'worker-thread' | 'process' | 'container'`——但文档明写它**只是诊断标签，不构成安全承诺**（`docs/subsystems/code-runtime.md:161`）。

---

## 11. 本章未确认

- ⚠️ 仓库未安装依赖（`node_modules` 不存在），本章**没有运行过任何 dsh 命令或测试**。所有结论来自逐行读源码、包 README、子系统文档与 shipped 配置；第 9 节的示例是照 e2e 测试改编的形状，未实际执行。
- ⚠️ fork 的 `backgroundMode` 冲突（第 3 节）：我核对了 6 个配置文件的实际值与 Agent Note 的原文，但没有跑起来验证 web 默认会话里 `subagent_fork` 最终落到哪个模式，也没有验证 Note 里描述的"prefix 复用损失"实际发生。
- ⚠️ 第 7 节"两个产品 provider 未随发行版安装"依据的是配置文件缺行 + `packages/bundle/base/tests/base.spec.ts:38`–`41` 的断言，未实际执行 `pnpm install` 或跑 CLI 确认。其余（凭据剥离、Windows `.cmd` 转写、无人值守审批映射、进程树终止阶梯）全部依据两份 README 与 `docs/tool-catalog.md`，均未在运行中确认，本机也没有安装这两个可执行文件。
- ⚠️ `list_agents` 的 `running / idle / ready` 状态细化、冷恢复的三级投影缓存阶梯，只读了 `packages/subagent/subagent/README.md:105` 与 `docs/tool-catalog.md` 的描述，未跟进 `continuation.ts` 逐行确认。
- ⚠️ 第 5 节"settlement notice 在忙父身上并进最近 step 边界"的措辞出自 `packages/subagent/subagent/README.md:85`，属于官方文档描述，未在代码中逐行确认。
- ⚠️ 第 10 节最后一段把"vm/worker 不是安全边界"与"`isolation` 被拒"联系起来是我的推断；仓库明说的只有两件事——它是 deferred（未实现），以及必须响亮失败。
