# 27 · Ralph Loop

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。正文只讲机制；可照抄的模板统一收在文末[附录](#附录可以照抄的模板)，出处收在[脚注](#出处)，点角标可跳转。

长任务跑到几十轮开始劈叉的时候，第一反应往往是：模型记性不够，得想办法让它记住更多。

不是的。真实病灶常常正好相反——模型**记得太多了**。几十轮之后它开始"记得"一些从没发生过的事：早期一次失败的尝试、一段被推翻的设计、一句自己安慰自己的"已修复"。这些不是凭空幻觉，是上下文在累积：所有中间推理都还留在同一条对话里，错误进去之后会被一遍遍重新发给模型（直到压缩把它盖掉），每一轮还要把这段前缀再付一次钱。

[26 章](./26-Goal模式.md)的 goal 选择留在这条对话里，靠驱动器不断塞下一条提示。Ralph 选了相反的那条路：**每一轮换一个全新的 child。**

换新 child 之后，跨轮还剩什么？只剩三样——不可变的目标、共享工作区（`cwd` 下的真实文件），以及上一轮留下的一份有大小上限的结构化交接报告。这就是本章第一根柱子：**工作区是长期记忆，对话不是。**

一轮接一轮的形状是这样：目标每轮原样重发，工作区被反复读写并一直留着，而 child 本身用完即弃，只有一份有界报告能跨过轮次边界。

```mermaid
flowchart TD
    OBJ["<b>不可变 objective</b><br/>每轮原样重发"]
    C1["<b>Ralph round N</b><br/>全新 child，无父会话无 seed"]
    R1["<b>结构化报告</b><br/>五字段，有大小上限"]
    C2["<b>Ralph round N+1</b><br/>又一个全新 child"]
    P["<b>父会话</b><br/>只落一次调用 + 一个终态"]

    subgraph WS["共享工作区：cwd 工作树，长期记忆与事实源"]
        W1["真实文件，跨轮一直在"]
    end

    OBJ --> C1
    C1 -- "读 / 写" --> WS
    C1 --> R1
    R1 -- "有界交接" --> C2
    OBJ --> C2
    C2 -- "读，并核对报告" --> WS
    C2 --> P

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    class C1,C2,R1 main
    class W1,P data
    class OBJ entry
```

这个形状有个很贴的比喻：工作区是工地，child 是换班的施工队。工地一直在那儿，一班干完人就走，下一班带着同一张施工图（objective）进场，手里只有上一班留的一张字数有限的交接单。这个比喻能直接推出本章好几个结论：上一班说的胡话随下班消失（错误不传染）；新班组每次都得重新巡一遍场（每轮重付"读工作区"的钱）；交接单可能写错，但工地本身不会说谎（所以要拿工作区去核对报告）。后面每一条都会在源码里验到。

这一章讲 dsh 自带的 `ralph` 工具怎么把这件事做出来。读的时候不妨一直带着一个问题：同样是"朝一个目标反复推进"，为什么 goal 和 Ralph 在"什么时候继续、什么时候停、状态放哪"上会分岔得这么远。最后一节专门算这笔账。

## 先把三个词钉死：loop、round、handoff

上面那张图里出现了三种东西：整个循环、每一轮的 child、跨轮的那份报告。官方术语表给它们各起了名字，定义值得原样抄一遍，因为后面所有讨论都以它为准[^1]：

| 术语 | 定义 |
|---|---|
| Ralph loop | 一次**前台**的 fresh-agent workflow run，朝一个不可变目标推进 |
| Ralph round | loop 里的**一个全新 child session**，不带父会话也不带此前 child 的 seed |
| Ralph handoff | 从上一个 continue 轮传给下一轮的**规范化、有上限**的结构化报告 |

同一段还把它**不是**什么写清楚了：不是 same-session goal，不是 agent-loop 的一个模式，不是调度器，也不是通用 workflow 脚本的一个特性[^1]。

至于"Ralph loop"这个名字在社区里的出处，**仓库里查不到**——文档站、包 README、Agent Note 里都没有溯源。所以本章只讲 dsh 这一份实现。

## 它是一个普通插件，不是内核里的一个模式

读到"每轮换新 child"这种深改执行方式的机制，很容易默认它动了内核。恰恰没有——这是本章最值得记住的架构判断：**Ralph 是一条策略，不是一台机器。** `tool-ralph` 是 workflow 家族里一个独立的插件包，注入四个服务就干活[^2]：

```
ralph 工具（模型可见）
   │  inject: ['tools', 'workflowEngine', 'subagents', 'systemPrompt']
   ├── ctx.tools         注册 ralph 这个工具 + 输出 schema + 渲染
   ├── ctx.systemPrompt  注册一段 order 116 的路由指引
   ├── ctx.workflowEngine 起一次 run，执行内置的固定脚本
   │        └── 脚本里的 agent() ──> ctx.subagents ──> spawn provider ──> 一个全新 child
   └── ctx.subagents     调用前当场校验 provider 能力
```

workflow 引擎与 subagent 的通用机制在 [19 章](./19-子agent与workflow.md)，本章只讲 Ralph 这条策略。

用 capability seam（能力缝：一个服务接口 + 可替换的实现，[07 章](./07-Service能力从哪来.md)）的语言说，`ctx.workflowEngine` 这条缝上，`tool-workflow`（模型自己写脚本）和 `tool-ralph`（脚本写死）是**两个并列的 Consumer**；`ctx.subagents` 的 Consumer 列表里也有 `tool-ralph`，注明"要求一条 fresh 的结构化输出路由"[^3]。

为什么不做进内核？总的理由一句话：把 Ralph 行为塞进 `dsh-agent-loop`、goal driver 或者公开的 workflow 脚本语言，等于**把一条策略焊死在跟它无关的执行机器上**。

Agent Note 把四条被否掉的方案逐条写了[^4]：

| 被否的方案 | 为什么否 |
|---|---|
| 放进 same-session goal driver | goal 的轮次故意保留同一条对话，而 Ralph 的定义性质恰恰是每轮换新上下文；两者一合，goal 的生命周期和 child 编排就再也分不开了 |
| 给通用 `workflow` 工具加一个 `fresh` 开关 | 模型可写的脚本 API 要保持通用、provider 中立；Ralph 的固定报告协议与停止策略应该有一个可评审的消费者 |
| 用 `subagent_fork` 换取重放方便 | 理由最硬：继承来的已完成轮次是隐式的、只会变大的交接状态，直接违反 fresh-context 契约 |
| 从工具里直接调 subagent 缝 | workflow 引擎已经拥有前台编排、结构化 child、取消传播、worker 终止、事件和静默 dispose，复用它是在演示插件组合，而不是造第二个 loop runtime |

代价很实在：`tool-ralph` 自己不拥有任何独立事件流，所以它的 invariant 伴生插件（每个包各自注册的运行时不变量校验器，[25 章](./25-调试手册与常见坑.md)）是空的——run 和 child 的生命周期由 workflow / subagent 的 owner 去校验[^5]。这个包薄到几乎只剩策略。

## 模型只能填两个字段

那模型发起一次 Ralph loop 时，能控制多少东西？答案少得惊人：调用面一共就两个字段[^6]。

| 参数 | 必填 | 含义 |
|---|---|---|
| `objective` | 是 | 每一轮 fresh child 共用的不可变完成目标 |
| `maxRounds` | 否 | 正安全整数轮次上限，被部署天花板压住 |

provider 选择、报告 schema、交接上限、脚本本体、编排行为，**全部是部署方拥有的，不出现在调用 schema 里**。调用是同步的：工具会一直等到整轮 run 出了结果才返回[^7]。

起跑前有四道前置检查，串成一条，任何一道不过就直接报错，**不会产生 run**[^8]：

| # | 检查什么 | 不过会怎样 |
|---|---|---|
| 1 | 调用方 agent 必须存在 | Ralph 需要一个调用方 agent 当所有 child 的 parent |
| 2 | `objective` 去掉首尾空白后必须非空 | 空目标直接打回 |
| 3 | `maxRounds` 是正安全整数且不超部署天花板 | `1.5`、`0`、`NaN`、超天花板全打回 |
| 4 | provider 三连：**已注册** → **支持结构化输出** → **不继承父上下文** | 三条各报各的错 |

四道闸门都落在引擎启动之前，所以失败时连 run 都没有：

```mermaid
flowchart TD
    IN["<b>模型发起调用</b><br/>只填 objective 与可选 maxRounds"]
    K1{"exec.agent 存在？"}
    K2{"objective trim 后非空？"}
    K3{"maxRounds 是正安全整数<br/>且不超部署天花板？"}
    K4{"provider 已注册 · 支持 outputSchema<br/>· 不继承父上下文？"}
    OK["<b>engine.start</b><br/>产生一次 run，开始跑固定脚本"]
    NO["<b>直接报错</b><br/>不会产生 run"]
    TIP["spawn 天生合格<br/>fork 天生不合格：它会 seed 父会话已完成轮次"]

    IN --> K1
    K1 -- "否" --> NO
    K1 -- "是" --> K2
    K2 -- "否" --> NO
    K2 -- "是" --> K3
    K3 -- "否" --> NO
    K3 -- "是" --> K4
    K4 -- "否" --> NO
    K4 -- "是" --> OK
    K4 -.- TIP

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class K1,K2,K3,K4,OK main
    class IN entry
    class NO danger
    class TIP note
```

第四道的三条错误信息各有各的话，单测逐条钉住：`is not registered` / `does not support structured output` / `inherits parent context`[^9]。

第四道里藏着一个值得停一下的判断题：直觉上 `fork` 更省事——child 直接带着父会话的记忆开工，还不用重新交代背景。但恰恰因此它**天生不合格**：它会把父会话已完成轮次 seed 给 child，而那正是 Ralph 存在的意义要消灭的东西。`spawn` 才天生合格[^10]。

还有个容易被当成低效的细节：**每次调用都重查 provider**，而不是在插件装载时查一次。理由是 provider 注册是 effect 作用域的，插件生命周期和 HMR（热重载，[08 章](./08-effect与生命周期.md)）都可能让它变[^11]。

### 路由是脚本看不见的那一半

固定脚本看不到也改不了自己走哪条 provider——路由是工具在启动请求里填好的，头两行就是[^12]：

| 字段 | 填的是什么 | 作用 |
|---|---|---|
| `subagentProvider` | 解析后的部署 provider 名 | 这一次 run 里每个 `agent()` 调用都走它 |
| `maxTotalAgents` | 本次解析出的轮次上限 | 让固定循环的轮次预算和引擎的"跑飞 child"兜底对齐 |
| `args` | 目标、轮次上限、交接上限三件数据 | 脚本只拿到数据 |
| `parent` | 调用方 agent 本人 | 每个 child 归属调用方，继承 cwd 与血缘 |
| `signal` | 取消通道 | 取消传播 |

另外两个字段 `script` / `meta` 是固定脚本本体与它的身份块。

`subagentProvider` 与 `maxTotalAgents` 是 seam 上的可选项[^13]，worker-thread 引擎在**发布 run 之前同步**解析它们[^14]：

- provider 名必须规范化且已注册，否则抛 `INVALID_ARGUMENT` / `AGENT_START`
- `maxTotalAgents` 必须是正安全整数且不得超过引擎自己的部署天花板（默认 1000），否则同样按非法参数打回

普通 `workflow` 工具这两个字段都不填，所以它的行为和 provider 策略一点没变[^15]。

单测把这份启动请求整个钉住了：身份块的名字是 ralph-loop、args 三件套、provider 名、agent 总数上限、parent 是调用方本人，一个字段一个字段比过去[^12]。

## 每个 child 到底收到什么

新班组进场，手里到底有几张纸？固定脚本每轮拼一段提示词，六段，用空行连接[^16]：

1. 身份：你是前台 Ralph loop 里的一个 fresh worker，**没有父会话、没有此前 child 的会话**；不要调用 `ralph` 工具，这一轮你就是它的 worker
2. `Immutable objective:` + 去掉首尾空白后的目标原文
3. `Ralph round: <round> of <maxRounds>.`
4. 共享工作区及其当前工作树是**长期记忆和事实源**：动手前先看，保住已有成果，做具体的、在范围内的活儿，改了就验证；把上一轮报告只当作有界交接，**要拿工作区去核对它**
5. `Previous structured handoff:` + 上一轮报告的 JSON，第一轮是 `(none — this is the first round)`
6. 报告要求：`continue` 必须带至少一条 nextSteps；`complete` 只在有具体证据且没有 nextSteps 时用；`blocked` 只在没有人类介入或外部状态变化就无法推进时用；`blocker` 除 blocked 外必须为空

第四段就是工地比喻里"交接单可能写错，工地不会说谎"的官方版本——它明写着报告只是有界交接，事实以工作树为准。六段里有一半是脚本常量、每轮一字不差，真正随轮次变的只有轮号和上一轮那份报告：

```mermaid
flowchart LR
    S1["<b>脚本常量</b><br/>每轮一字不变"]
    S2["<b>args</b><br/>objective / maxRounds"]
    S3["<b>上一轮报告</b><br/>唯一跨轮变量"]

    subgraph PR["拼给 child 的提示词，空行连接"]
        A1["1 身份：fresh worker，别调 ralph"]
        A2["2 Immutable objective"]
        A3["3 Ralph round N of M"]
        A4["4 工作区是长期记忆，先看再动"]
        A5["5 Previous structured handoff"]
        A6["6 报告要求：三种 status 的条件"]
    end

    S1 --> A1
    S1 --> A4
    S1 --> A6
    S2 --> A2
    S2 --> A3
    S3 --> A5

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    class A1,A2,A3,A4,A5,A6 main
    class S1,S2 entry
    class S3 data
```

child 自己的 system prompt 照常由它那棵插件树装配（[15 章](./15-系统提示词与上下文装配.md)），但**父会话的内容一个字都不进来**。

这一条不是口头承诺，有落盘证据。shipped headless 回放快照跑完后逐条检查磁盘上的会话日志，一共三份：一份 parent（delegationDepth 为 0），两份 child——delegationDepth 为 1，parentSession 都指向 parent 的 id，cwd 与 parent 相同，**seedLength**（会话被预置的历史长度，[16 章](./16-会话日志与分叉.md)）**都缺席**，两个 id 互不相同[^17]。

内容上：child 1 的首条 `user/message` 含 `Ralph round: 1 of 2.` 和 `(none — this is the first round)`、**不含** `ROUND_ONE_HANDOFF`；child 2 含 `Ralph round: 2 of 2.` 和 `ROUND_ONE_HANDOFF`；两个 child 的 prompt 都含 objective 原文，**都不含人类那句原话**[^17]。

真实栈的集成测试用同一组断言再验一遍，并额外断言 child 的请求里既没有父会话 prompt 标记也没有父会话历史标记[^18]。

child 侧唯一多出来的东西是结构化输出捕获契约：回放快照断言每个 child 的工具调用**只有一次** `structured_output`[^17]。

## 交接报告是一张不许撕的交接单

`agent()` 的 schema 参数就写在脚本顶部，五个字段全部必填、不许有多余属性[^19]：

| 字段 | 类型 | 要求 |
|---|---|---|
| `status` | enum | `continue` / `complete` / `blocked` |
| `summary` | string | 非空且**已规范化**（首尾没有空白） |
| `evidence` | string[] | 每项都非空且已规范化 |
| `nextSteps` | string[] | 同上 |
| `blocker` | string | 已规范化（可以是空串） |

三种状态各自还有语义约束[^19]：

| status | 必须有 | 必须没有 |
|---|---|---|
| `continue` | 至少一条 `nextSteps` | `blocker` 必须是空串 |
| `complete` | 至少一条 `evidence` | `nextSteps` 为空、`blocker` 为空串 |
| `blocked` | 一条具体的 `blocker` | — |

最后是大小闸门：整份报告序列化后超过交接上限，不截断、不打折，直接抛错，整个 workflow 失败[^19]。

同一套规则会被跑两遍。一遍在 workflow 脚本里，也就是上面这些；另一遍在工具消费端，跨过 workflow 缝之后重新解码一次。消费端还额外要求键集合**精确等于**那五个字段，多一个键都算 malformed[^20]。

源码把这一遍称作"跨 provider 边界的防御性解码"，README 则把"脚本内 + 消费端各校验一次"直接定为契约。单测把 18 种畸形终值逐个跑了一遍[^20]。

一份报告从 child 手里到工具返回值，要过两道内容一样的关，中间隔着 provider 边界；任何一道不过，都是整个 workflow 失败：

```mermaid
flowchart LR
    CH["<b>child</b><br/>一次 structured_output"]
    V1["<b>脚本内 validateReport</b><br/>字段规范化 + status 语义 + 大小闸门"]
    SEAM["<b>workflow 缝</b><br/>跨 provider 边界"]
    V2["<b>消费端 readReport</b><br/>再来一遍，且键集合必须精确等于五个"]
    OUT["<b>result 里的权威值</b><br/>不被 maxResultChars 裁"]
    BAD["<b>失败</b><br/>非法 / 缺失 / 超长都算失败<br/>绝不当成轮次用光"]

    CH --> V1 --> SEAM --> V2 --> OUT
    V1 -- "不过" --> BAD
    V2 -- "不过" --> BAD

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class V1,V2,SEAM main
    class CH entry
    class OUT data
    class BAD danger
```

这里有一道验收题：报告超长，为什么是让整个 workflow 失败，而不是截断留个尾巴？截断听起来明明更宽容。

想象把交接单撕掉后半张：留下来的前半张**仍然长得像一张完整的交接单**，下一班照着它开工，却不知道被撕掉的正是关键的证据或 next steps。Agent Note 的原话就是这个意思：截断可能刚好切掉状态证据或 next steps，而剩下的东西看起来仍然像一份权威交接；生产者必须在配额内产出一份合法报告[^4]。

同一条逻辑贯穿到底——报告非法、缺失、超长都是**失败**，绝不会被误当成"轮次用光"[^20]。

## 停不停，是 child 自己在报告里说的

谁来决定循环继续还是收工？不是脚本，不是引擎——**是每一轮 child 自己在报告里声明的，脚本只负责照做。** 固定脚本的主循环用人话复述就四句[^21]：从第 1 轮数到轮次上限，每轮把拼好的六段提示词连同报告 schema 交给一个全新 child；child 没能交出结构化报告，立即以"这一轮失败"收场并附上最后一次成功交接，**不重试这一轮**；交出来了就先过上一节那套校验，不过就整个 workflow 失败；报 complete 或 blocked 就立即带着该轮报告返回，报 continue 就把这份报告揣进兜里开下一轮。循环把预算走完、最后一份还是 continue，就以 budget-limited 收场。

三个成功出口[^21]：

| 终态 | 触发 | `report` 是哪一份 |
|---|---|---|
| `complete` | 某轮报 `complete`，立即返回 | 该轮报告 |
| `blocked` | 某轮报 `blocked`，立即返回 | 该轮报告 |
| `budget-limited` | 最后一轮仍是 `continue`，循环走完 | 最后一份 `continue` 报告 |

把这三个出口和后面那节的 `round-failed` 摆在一起看，一轮结束后的分岔一共只有四条，其中只有 `continue` 会回到循环里：

```mermaid
flowchart TD
    R["<b>第 N 轮 child</b>"]
    Q0{"拿到结构化报告<br/>且通过校验？"}
    F["<b>round-failed</b><br/>报错并附上一份成功交接<br/>不重试这一轮"]
    Q1{"status 是哪个"}
    CP["<b>complete</b><br/>立即返回该轮报告"]
    BL["<b>blocked</b><br/>立即返回该轮报告"]
    NX{"还有轮次预算？"}
    BU["<b>budget-limited</b><br/>返回最后一份 continue 报告"]

    R --> Q0
    Q0 -- "否" --> F
    Q0 -- "是" --> Q1
    Q1 -- "complete" --> CP
    Q1 -- "blocked" --> BL
    Q1 -- "continue" --> NX
    NX -- "有，换一个全新 child" --> R
    NX -- "用光了" --> BU

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class Q0,Q1,NX main
    class R entry
    class CP,BL,BU data
    class F danger
```

工具的返回信封只有三个字段[^22]：runId（这次 run 的身份）、agentsStarted（真正启动过的 child 数）、result（权威报告 JSON）。其中 agentsStarted 来自引擎的结算值——正常结算时它是脚本侧计数，被强制终止时退化为宿主观测值[^22]。

渲染文本走的是另一条路，挂在工具的渲染口上[^23]，三句话的措辞是刻意的：

- `Ralph worker reported completion after N rounds.`
- `Ralph worker reported a blocker after N rounds.`
- `Ralph reached its N rounds limit; the worker reported work remaining.`

"**worker reported**"是设计要求，不是行文习惯。这几个字是本章的靶心：完成和阻塞都是 worker 的自我声明，不是独立认证——**dsh 里没有任何独立评估者去判定目标是否真的完成**，这一项被明确列为已推迟工作[^23]。

`maxResultChars` **只裁这段渲染文本**，包含信封和截断标记 `\n… [truncated]` 在内，不动 result 里那份已校验的权威值，也不动跨轮交接[^23]。

单测钉得很死：把渲染上限设成 160 时，文本长度**恰好** 160 且以 `… [truncated]` 结尾；上限比标记本身（14 字符）还短、比如给 5 时，输出就是 `'\n… [t'`[^24]。

父会话里最终落下的是什么？shipped headless 快照的 `tool/result` 事件原文[^25]：

```
Ralph worker reported completion after 2 rounds.
Final report:
{
  "status": "complete",
  "summary": "The Ralph snapshot objective is complete.",
  "evidence": [
    "Two fresh rounds completed through the shipped app."
  ],
  "nextSteps": [],
  "blocker": ""
}
```

中间轮次的 child 消息、中间报告，**一条都不进父对话**[^25]。

## 失败与取消：没有一种半成品算成功

普通 child 失败——模型跑到 token 上限，或者 child 正常结束但状态不是 completed——在 workflow 语言里映射成 `agent()` 返回空值[^26]。

固定脚本在校验报告**之前**就拦下它，返回 round-failed 和最后一次成功交接，工具再把它变成一个错误结果[^27]。

第 1 轮就挂是 `Ralph round 1 child failed before producing a structured report.` 加一句 `No previous handoff was available.`；第 N 轮挂则是同样的抬头，后面接 `Last successful handoff:` 和上一份报告。**Ralph 不重试那一轮**[^27]。

致命失败与取消永远不算成功，判定只看停止理由，三句话判完[^28]：只有 completed 才继续解码终值；cancelled 报 "Ralph workflow was cancelled" 并附上取消原因；error 报 "Ralph workflow failed" 并附上错误本体。

provider 启动、传输、worker、workflow 层的致命故障仍然是普通 workflow 错误，而且**可能在固定脚本来得及返回交接之前就结算**[^27]。

取消走两条通道，是刻意的冗余[^29]：启动请求里带上取消信号交给引擎，这是通道一；工具同时自己在信号上挂一个监听，一旦 abort 就直接喊 run 取消，这是通道二。挂完监听还要补查一次"信号是不是已经 abort 了"——这不是多余的：如果 abort 恰好落在启动执行期间，那个监听器不会再触发，只能靠这一次补查兜住。README 说这么写是为了"实现独立性"，不依赖某个引擎一定接信号[^29]。

两个单测分别覆盖飞行中取消和启动期间取消，都断言引擎收到的取消理由是 "parent step aborted"、且 run 恰好被 dispose 一次[^29]。至于"调用之前信号就已经 abort"，根本到不了执行体：工具运行时先返回 `TOOL_ABORTED_BEFORE_DISPATCH`[^29]。

无论从哪条路径退出，工具最后都无条件等一次 run 的 dispose[^30]。这不是礼貌，是必需：run 是 holder 拥有的，持有者必须在每条路径上 dispose[^30]。

worker-thread 引擎的 dispose 幂等，会取消 run、在 `disposeGraceMs`（默认 5000ms）内等结果与 child 静默、然后无条件终止 worker 并做一次幸存者清扫[^30]。所以一次被取消的父步骤会**等到引擎有界终止、child 静默之后才返回**——它不会立刻甩手就走。

## 它装在哪、怎么发起、怎么逐轮看

四个部署参数[^31]：

| Key | 默认 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 每一轮用的 fresh 结构化输出 provider |
| `maxRounds` | `256` | 一次 run 的默认轮次上限，**同时是**调用方 `maxRounds` 的天花板 |
| `maxHandoffChars` | `16384` | 单份报告序列化后的字符上限 |
| `maxResultChars` | `16384` | 成功时父侧渲染文本的字符上限（含截断标记） |

这四个值在插件装载时就规范化并校验，**包括绕过 Loader schema 直接调用 apply 的情况**[^31]。

它已经装在这些地方[^32]：

| 位置 | 配置 |
|---|---|
| base bundle | provider 用 spawn，轮次上限压到 64 |
| `standard` agent preset | 与 base 相同 |
| `code` / `cordis` agent preset | 与 standard 一模一样 |
| `minimal` agent preset | 不装 |
| web-app 层 | 一行开关直接禁用 |
| 两个 example | 不带 config，走全部默认值 |

web-app 那一行是 host plane 关掉，由 agent preset 决定自己的 agent 看得见哪些委派工具[^32]。

出厂 Web 组合有一张"模型可见工具清单"的断言表，`ralph` 名列其中——所以默认组合里模型是**看得见**它的[^33]。

改配置按 [03 章](./03-配置的四层结构.md)的 patch 规则加一行，模板照抄[附录 A](#a-改一行-ralph-配置的-patch-模板)。注意 **patch 会整块替换目标行的 config**，所以这一行拥有的每个 key 都得重写一遍[^34]。想彻底关掉，就在同一个 id 下只放一行禁用开关，形状同 web-app 那一行[^32]。

### 怎么发起一次

模型被明确要求：**只在直接的人类明确要求 Ralph loop 或 fresh-agent 迭代时才调用它**——这是一段挂在 order 116 上的路由指引[^35]。所以你得把话说明白。

shipped 快照里的那句人话长这样[^36]：

```
Run a two-round fresh-agent Ralph loop to prove the shipped headless integration.
```

模型据此发出的调用，落在快照的 `tool/call` 事件里[^36]：

```json
{"objective":"Prove two fresh Ralph rounds through the shipped headless app.","maxRounds":2}
```

读包 README 时注意一处笔误：它抄录这段指引时把结尾的服务名写成了 workflowEngine，源码里是 workflows——以源码为准[^35]。

### 怎么逐轮跟踪

运行时看 `workflow/*` 事件。它们是只读的，只带 run 的 id 和身份块，拿不到 run 控制权[^37]。

Ralph 只用一个 phase，叫 "Fresh-agent rounds"；每轮的 `agent()` 调用都带着 "Ralph round N" 的标签[^38]。

[附录 B](#b-逐轮跟踪插件-ralph-tracer) 是一个二十来行的监听插件，改编自集成测试的写法[^39]。挂上之后，一次 2 轮的 run 应当打出 1 行 phase，外加 2 对 agent-start / agent-end。

事后就翻会话日志（[16 章](./16-会话日志与分叉.md)）。判据是快照测试用的那套[^40]：parentSession 等于父会话 id 的就是 Ralph child，delegationDepth 为 1，cwd 与父一致，seedLength 缺席；每个 child 的首条 `user/message` 里能直接读到 `Ralph round: N of M.` 和上一轮交接。

## Ralph 还是 goal：分岔点只有一个

两者都是"朝一个目标反复推进"，真正的分岔点只有一个：**上下文往哪儿放。** 这一个选择往下决定了成本曲线、错误传染、可观测性、能不能 resume。

一边把状态存进对话、由驱动器判停，另一边把状态存进文件、由干活的 child 自己在报告里声明停不停：

```mermaid
flowchart LR
    subgraph G["goal：same-session"]
        GA["<b>执行体</b><br/>同一个 agent 的下一个 turn"]
        GB["<b>状态放对话里</b><br/>历史累积重发，前缀可复用"]
        GC["<b>驱动器判停</b><br/>持久状态，可 pause / resume"]
    end

    subgraph RA["Ralph：fresh-agent"]
        RB["<b>执行体</b><br/>每轮一个全新 child session"]
        RC["<b>状态放文件里</b><br/>工作区 + 一份有上限的报告"]
        RD["<b>child 自己在报告里声明</b><br/>纯前台进程内，无 resume"]
    end

    GA --> GB --> GC
    RB --> RC --> RD

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    class GA,RB main
    class GB,GC,RC,RD data
```

逐维度对下来，每一行都是"上下文放哪"这一个选择的推论——包括开头工地比喻推出的那三条（错误不传染、每轮重付读工作区的钱、拿工作区核对报告）：

| 维度 | goal（same-session） | Ralph |
|---|---|---|
| 每轮的执行体 | 同一个 agent 的**下一个 turn**（一块 goal_round 用户消息）[^41] | 一个**全新的 child session** |
| 上下文 | 累积：保留的轮次一直重发，直到压缩盖掉[^41] | 归零：只有目标 + 工作区 + 一份不超过交接上限（默认 16384 字符）的报告 |
| 错误传染 | 会：错误推理留在同一条对话里 | 不会：上一轮的胡话随 child 一起消失[^42] |
| 跨轮记忆 | 整条会话历史 | **工作区**是唯一长期记忆，报告只是补充[^1] |
| KV cache（复用已发过的请求前缀，省钱省延迟） | 追加式，前缀可复用[^41] | 每个 child 一份**独立**请求缓存[^42] |
| token 成本 | 前缀重发，随轮次线性变贵 | 每轮重付一遍"读工作区"的钱，但不重付历史[^42] |
| 持久性 | 目标是持久状态，有 pause / resume 动词，会话 resume / fork 后仍在[^41] | **纯前台、进程内**：无 job id、无后台收集、无 resume[^42][^4] |
| 可观测性 | 都在同一条会话里，直接读 | 父会话只留一次调用 + 一个终态；细节在 child 会话和 `workflow/*` 事件里 |
| 终态权威 | 模型侧策略判定证据是否充分[^41] | 同样是自我声明，**没有独立评估者**[^42] |
| 预算 | 轮次上限（不是资源预算）[^41] | 只有轮次数；token / 金额 / 时长预算都推迟[^42] |

落到选型上：

- 任务需要积累判断、要跟人来回确认、中途会被追加新要求 → 选 goal
- 任务能被"读工作区 → 干一小块 → 验证 → 写报告"完整描述，且每一步的成果都落在文件里 → 选 Ralph
- 已经吃过"模型记得自己没做过的事"的亏 → 选 Ralph
- 需要暂停、恢复、后台跑、重启后接着跑 → 两个都不选：Ralph 是前台限定，goal 那套 resume 也不是后台调度
- 只是要有界委派或扇出 → 用普通 subagent 或 `workflow` 就够了，这也是那段路由指引里写给模型的建议[^35]

最后一条是踩坑重灾区：**Ralph 的成功不等于目标达成**。返回值里那句 "worker reported" 是字面意思——完成与阻塞都是干活的那个 child 自己说的，dsh 没有任何一方去核实[^42]。要认证就得自己在外面加一层评估，而那正是被推迟的工作。

## 把整章串起来

回到开头那条工地：能不能把全章结论一条条重新推出来，是检验自己真懂了的办法。

- 从"每轮换全新 child"推出：上一轮的胡话随 child 一起消失，错误不传染；代价是每个 child 一份独立的请求缓存、每轮重付一遍"读工作区"的钱——这正是它和 goal 在成本曲线上的分岔。
- 从"工作区是长期记忆，对话不是"推出：报告只是有界交接单，可能写错，工地不会说谎，所以提示词第四段明写着要拿工作区去核对它。
- 从"交接单是一张不许撕的单子"推出：超长不截断、直接整个失败——因为撕掉一半的交接单看起来仍像完整的；也因此报告非法、缺失、超长统统算失败，绝不被误当成"轮次用光"。
- 从"fork 会 seed 父会话已完成轮次"推出：它天生过不了 provider 闸门——继承来的记忆正是 Ralph 要消灭的东西。
- 从"worker reported 是字面意思"推出：Ralph 的成功不等于目标达成，dsh 没有独立评估者，要认证得自己在外面加一层。
- 从"它只是一个普通插件"推出：内核一行没改，Ralph 全部行为都是 workflow + subagent 两条缝上的一个消费者拼出来的。

一句话版本：**goal 把状态留在对话里，Ralph 把状态留在文件里；前者靠上下文续跑，后者靠一份有上限的报告续跑。** 停止判据也跟着分岔：goal 由驱动器在同一条会话里判，Ralph 由每一轮 child 自己在报告里声明 `continue` / `complete` / `blocked`，脚本只负责照做。

[28 章](./28-自己写一个续跑插件.md)自己写续跑插件时，"状态放哪、谁判停"就是你要先想清楚的那两个选择。想知道 Pi / Codex / LangChain 在同一道题上怎么选，见[五个 agent 系统源码解剖](../2026-08_五个agent系统源码解剖/00-总览与阅读指南.md)。

---

## 附录：可以照抄的模板

### A. 改一行 Ralph 配置的 patch 模板

patch 会整块替换目标行的 config，所以四个 key 全部写上，只改你要改的那个值[^34]：

```yaml
- id: tool-ralph
  config:
    subagentProvider: spawn
    maxRounds: 16
    maxHandoffChars: 16384
    maxResultChars: 16384
```

### B. 逐轮跟踪插件 ralph-tracer

改编自集成测试的写法，事件签名与 payload 字段以 workflow 包为准[^39]：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workflow'

export const name = 'ralph-tracer'

export function apply(ctx: Context): void {
  ctx.on('workflow/phase', (run, title) => {
    ctx.logger.info(`${run.meta.name} phase: ${title}`)
  })
  ctx.on('workflow/agent-start', (run, agent) => {
    ctx.logger.info(`${run.id} #${agent.seq} ${agent.label} -> ${agent.childId}`)
  })
  ctx.on('workflow/agent-end', (run, agent) => {
    ctx.logger.info(`${run.id} #${agent.seq} ${agent.outcome}`)
  })
}
```

那个空的 import type 不是笔误，它只为把 workflow 包的事件声明合并进 `Context`，仓库自己也这么写；`ctx.logger` 是 Cordis 自带服务，不用 inject[^39]。

挂载就在 `cordis.yml` 里加一行，本地插件用相对路径引用[^39]：

```yaml
- id: ralph-tracer
  name: './plugins/ralph-tracer.ts'
```

---

## 出处

[^1]: 三个术语的定义：`docs/glossary.md:43-45`；"不是什么"清单在 `:43`；"工作区是唯一长期记忆、报告只是补充"在 `docs/glossary.md:45`。
[^2]: `tool-ralph` 的包位置与四个注入服务：`packages/workflow/tool-ralph/src/index.ts:19-20`。
[^3]: capability seam 的两条记录：`docs/capability-seams.md:465`（workflowEngine 缝上 tool-workflow 与 tool-ralph 是并列 Consumer）、`:458`（subagents 缝的 Consumer 列表，注明 tool-ralph 要求 fresh 结构化输出路由）。
[^4]: Agent Note：`.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md:11`（不做进内核的总理由），四条被否方案在同文件 53-56 行，"截断可能切掉证据或 next steps"在 `:57`，"纯前台、无 resume"在第 70 行。
[^5]: 空的 invariant 伴生插件：`packages/workflow/tool-ralph/src/invariant.ts:18-21`。
[^6]: 调用 schema（objective 与可选 maxRounds）：`packages/workflow/tool-ralph/src/index.ts:415-425`；生成的目录版 `docs/tool-catalog.md:1188-1205`。
[^7]: 其余全部由部署方拥有：`packages/workflow/tool-ralph/README.md:62`；同步等待整轮结果：`packages/workflow/tool-ralph/src/index.ts:461`。
[^8]: 四道前置闸门，全部落在 engine.start 之前：调用方 agent 存在性在 `packages/workflow/tool-ralph/src/index.ts:438-441`，objective 非空在 `:442-443`，maxRounds 校验在 `:208-217` 与 `:444`（单测 `packages/workflow/tool-ralph/tests/tool-ralph.spec.ts:303-305`），provider 三连（已注册、capabilities.outputSchema、inheritsParentContext 必须为 false）在 `:220-232`。
[^9]: 三条 provider 错误信息的单测：`packages/workflow/tool-ralph/tests/tool-ralph.spec.ts:311-324`。
[^10]: fork 会 seed 父会话已完成轮次：`packages/subagent/subagent-fork-in-process/src/index.ts:64`；spawn 的能力声明：`packages/subagent/subagent-spawn-in-process/src/index.ts:42,44`。
[^11]: 每次调用重查 provider 的理由（effect 作用域 + HMR）：`packages/workflow/tool-ralph/README.md:34`。
[^12]: 启动请求的字段：`packages/workflow/tool-ralph/src/index.ts:447-455`；单测钉住整份请求（meta.name 为 ralph-loop、args 三件套、subagentProvider 为 fresh、maxTotalAgents 为 4、parent 是调用方）：`packages/workflow/tool-ralph/tests/tool-ralph.spec.ts:149-155`。
[^13]: subagentProvider 与 maxTotalAgents 是 seam 上的可选项：`packages/workflow/workflow/src/runtime-types.ts:26-29`。
[^14]: worker-thread 引擎发布 run 前的同步解析：provider 名校验在 `packages/workflow/workflow-worker-thread/src/index.ts:77-89`，调用点在 `:146-147`；maxTotalAgents 校验在同文件 92-104 行，天花板默认值 1000 在 118 行。
[^15]: 普通 workflow 工具不填这两个字段：`packages/workflow/workflow-worker-thread/README.md:86`。
[^16]: 六段提示词的拼装：`packages/workflow/tool-ralph/src/index.ts:155-162`。
[^17]: 回放快照对三份会话日志的逐条检查（delegationDepth、parentSession、cwd、seedLength、首条 user/message 的内容断言）：`examples/headless-agent/tests/headless.snapshot.ts:729-772`；每个 child 只有一次 structured_output 的断言在 `:768-772`；该工具名的定义在 `packages/subagent/subagent-in-process-driver/src/structured.ts:19`。
[^18]: 真实栈集成测试的同组断言（含"无父会话 prompt 标记、无父会话历史标记"）：`packages/workflow/tool-ralph/tests/integration.spec.ts:95-113`。
[^19]: 报告 schema（五字段全 required、additionalProperties: false）：`packages/workflow/tool-ralph/src/index.ts:91-102`，传入 agent() 的点在 `:166`；三种 status 的语义约束在 `:125-143`；大小闸门在 `:144-147`。
[^20]: 消费端 readReport：`packages/workflow/tool-ralph/src/index.ts:247-280`，"跨 provider 边界的防御性解码"注释在 `:246`，键集合必须精确等于 blocker,evidence,nextSteps,status,summary；"脚本内 + 消费端各校验一次"与"非法 / 缺失 / 超长都是失败、绝不当成轮次用光"的契约：`packages/workflow/tool-ralph/README.md:11`；18 种畸形终值的单测：`packages/workflow/tool-ralph/tests/tool-ralph.spec.ts:333-366`。
[^21]: 主循环：child 失败时的 round-failed 出口在 `packages/workflow/tool-ralph/src/index.ts:168-170`，三个成功出口在 `:172-176`。
[^22]: 返回信封（runId / agentsStarted / result）：`packages/workflow/tool-ralph/src/index.ts:379-383`；agentsStarted 取自引擎结算值在 `:466-470`；正常结算与强制终止的两种语义：`packages/workflow/workflow/src/types.ts:80-86`。
[^23]: 渲染文本：`packages/workflow/tool-ralph/src/index.ts:361-376`，挂在工具输出渲染口在 `:432-435`；maxResultChars 只裁渲染文本（含截断标记）、不动权威值与交接在 `:351-358`；独立评估者缺席、列为已推迟工作：`packages/workflow/tool-ralph/README.md:13,88`。
[^24]: 截断单测（160 恰好、上限 5 时输出 '\n… [t'）：`packages/workflow/tool-ralph/tests/tool-ralph.spec.ts:206-208`，极端例在同文件 218 行。
[^25]: 父会话 tool/result 事件原文：`examples/headless-agent/tests/snapshots/ralph-loop/stream-json.expected.jsonl:16`；中间轮次不进父对话：`packages/workflow/tool-ralph/README.md:76`。
[^26]: child 失败映射成 agent() 返回 null：`packages/workflow/workflow/README.md:43`。
[^27]: round-failed 路径：脚本侧拦截在 `packages/workflow/tool-ralph/src/index.ts:168-170`，工具转成错误结果在 `:465`，渲染在 `:386-392`；真实栈复现：`packages/workflow/tool-ralph/tests/integration.spec.ts:126-129,146-148`；"不重试那一轮"与"provider 级致命故障可能先于交接结算"都在 `packages/workflow/tool-ralph/README.md` 第 15 行。
[^28]: 停止理由三分支（completed / cancelled / error）：`packages/workflow/tool-ralph/src/index.ts:336-349`。
[^29]: 取消双通道与补查：`packages/workflow/tool-ralph/src/index.ts:454-458`；"实现独立性"的理由在 `packages/workflow/tool-ralph/README.md` 第 19 行；飞行中与启动期取消的两个单测：`packages/workflow/tool-ralph/tests/tool-ralph.spec.ts:269-297`；调用前已 abort 返回 TOOL_ABORTED_BEFORE_DISPATCH 在同文件 277-281 行。
[^30]: finally 无条件 dispose：`packages/workflow/tool-ralph/src/index.ts:471-474`；"holder 必须在每条路径上 dispose"：`packages/workflow/workflow/README.md:15`；worker-thread 引擎 dispose 的幂等与有界终止：`packages/workflow/workflow-worker-thread/README.md:65,84`。
[^31]: 四个部署参数：`packages/workflow/tool-ralph/src/index.ts:35-40`，规范化与校验函数在 `:187-205`；目录版 `docs/config-catalog.md:2520-2538`；绕过 Loader 直接 apply 也校验的单测：`packages/workflow/tool-ralph/tests/tool-ralph.spec.ts:326-331`。
[^32]: 装机位置：base bundle `packages/bundle/base/cordis.patch.yml:378-382`；standard preset `apps/cli/config/agent-presets/standard/agent.cordis.yml:229-233`，code preset 在同目录 code 的 230-234 行、cordis 的 217-221 行；web-app 禁用行 `packages/bundle/web-app/cordis.patch.yml:398-399`，host plane 关掉的说明在同文件 372 行；两个 example：`examples/headless-agent/cordis.yml:145-146`、`examples/acp-agent/cordis.yml:147-148`。
[^33]: 出厂 Web 组合的模型可见工具清单断言表：`apps/web/tests/shipped-composition.e2e.ts:35-59`，ralph 在第 47 行，断言在 `:91`。
[^34]: patch 整块替换目标行 config 的规则：`packages/bundle/web-app/cordis.patch.yml:5-6`。
[^35]: 路由指引（system prompt section tool:ralph，order 116，"只在人类明确要求时调用"、委派/扇出走 subagent 或 workflow）：`packages/workflow/tool-ralph/src/index.ts:407-411`，建议那句在 `:410`；README 抄录笔误（workflowEngine 应为 workflows）：`packages/workflow/tool-ralph/README.md:47`。
[^36]: 快照里的人类原话：`examples/headless-agent/tests/snapshots/ralph-loop/input.json:5`；模型发出的 tool/call 事件在同目录 `stream-json.expected.jsonl:15`。
[^37]: workflow 事件只读、只带 WorkflowRunInfo：`packages/workflow/workflow/README.md:23`。
[^38]: 唯一 phase 与每轮 label：`packages/workflow/tool-ralph/src/index.ts:83,152`，label 在 `:164`。
[^39]: 监听插件的原型：`packages/workflow/tool-ralph/tests/integration.spec.ts:78-83,251`；三个事件的签名：`packages/workflow/workflow/src/index.ts:51,68,79`；payload 字段：`packages/workflow/workflow/src/types.ts:98-116`；空导入的仓库先例：`packages/workflow/tool-ralph/src/index.ts:17`；ctx.logger 免注入：`vendor/cordis/src/context.ts:28`；本地插件相对路径挂载的形状：`examples/acp-agent/child-question.cordis.yml:13-14`。
[^40]: 事后翻会话日志的判据：`examples/headless-agent/tests/headless.snapshot.ts:734-763`。
[^41]: goal 侧对比出处：goal_round 用户消息在 `packages/goal/goal-round-driver/README.md:48`，历史累积重发在 `:52`，前缀可复用在第 56 行，模型侧判定证据在第 60 行，轮次上限不是资源预算在第 63 行；持久状态与 pause / resume：`packages/goal/goal/README.md:20,28`。
[^42]: Ralph 侧对比出处，都在 `packages/workflow/tool-ralph/README.md`：每轮重付读工作区在第 80 行，独立请求缓存在第 84 行，无独立评估者在第 88 行，纯前台进程内在第 89 行，错误不传染在第 90 行，token / 金额 / 时长预算推迟在第 93 行。
