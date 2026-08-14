# 内置插件参考

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。教程正文入口见 [00 · harness 思想模型](../00-harness思想模型.md)。

这一区回答同一个问题：**`dsh --profile web --dump-config` 打出来的那一行，到底是什么？**

每篇的固定结构：它在树上那行 YAML 原文 → 它注册了什么（服务 / 事件监听并标出派发模式 / 工具 / prompt 段 / 命令）→ 配置项表 → 模型看得见什么 → 什么时候你会想换掉它 → 坑与边界。

当前进度：**59 / 130 篇已成稿**，71 篇待补。

## 计数为什么是 130

三个出厂 bundle 的 patch 文件里 `- id:` 行数是 **78 + 78 + 6 = 162**，但这不等于插件数：同一个包可以占多行（`dsh-tool-subagent` 同时挂在 `tool-subagent` 与 `tool-subagent-fork` 两个 id 上；`code-runtime` 在 `web-app` 与 `headless` 各一行），而两个不同的插件说明符也可能来自同一个包目录（`dsh-web-app` 与 `dsh-web-app/startup` 是同一个包的两个入口）。**按不重复的插件说明符（含子路径入口）去重后是 130 个**，本区因此是 130 篇。

## 状态标记

| 标记 | 含义 |
|---|---|
| ✅ | 已成稿并通过对抗式引用核验：逐条打开源码比对行号、字段名、默认值、英文引文 |
| ⚠️ | 已成稿但**未过核验那一遍**（会话额度中断），文件顶部有同样的提示；行号与字段名请以源码为准 |
| ⏳ | 待补 |

## Cordis 基础设施与运行时骨架 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/cordis-plugin-timer`](./cordis-plugin-timer.md) | `timer` | `base` | 把 `setTimeout` / `setInterval` 换成挂在当前 fiber 上的可回收版本，插件卸载时它创建的定时器自动被清掉 |
| [`@deepseek-ai/cordis-plugin-hmr`](./cordis-plugin-hmr.md) | `hmr` | `base` | 监听源文件与配置文件，只重载受影响的那几个 loader 插件条目；碰到框架层文件就整进程退出重来 |
| [`@deepseek-ai/dsh-typert-registry`](./dsh-typert-registry.md) | `typert` | `base` | 一张进程内的表，存放构建期生成的包反射、Zod schema、Remote 调用描述符，以及 lookup / Context 提供者——所有登记都是 Cordis effect，随调用方 fiber 一起撤销 |
| [`@deepseek-ai/dsh-typert-loader`](./dsh-typert-loader.md) | `typert-loader` | `base` | 扫描 loader 条目，把导出了 `./typert` 的包的生成产物 import 进来、校验完再塞进 [`ctx.typert`](./dsh-typert-registry.md)，条目卸载就撤回 |
| [`@deepseek-ai/dsh-api-gateway`](./dsh-api-gateway.md) | `typert-gateway` | `base` | 把一次 `<namespace>/<method>` 调用落到活着的 Cordis 服务方法上——解析描述符、校验参数、把 id 换成 Host 对象、调用、再校验返回值；传输、相关性、信封全归 Connection |

## 模型层 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-llm`](./dsh-llm.md) | `llm` | `base` | provider 中立的 LLM 词汇表加抽象服务——一个 adapter 注册表 + 一个可被 waterfall 拦截的流式调用 API，本组其余四个插件全都围着它转 |
| [`@deepseek-ai/dsh-llm-deepseek`](./dsh-llm-deepseek.md) | `llm-deepseek` | `base` | 原生 DeepSeek adapter，用裸 `fetch` + `eventsource-parser` 解 SSE，独占 `deepseek-official` 这一条 provider 路由——也就是 [agent-default-model](./dsh-agent-default-model.md) 出厂默认指向的那一条 |
| [`@deepseek-ai/dsh-llm-pi-ai`](./dsh-llm-pi-ai.md) | `llm-pi-ai` | `base` | 基于 `@earendil-works/pi-ai` 的通用多 provider adapter，出厂**休眠挂载**（零路由），一旦 settings 里出现 `llm-pi-ai:` profiles 就把那些路由注册上去；它是 [llm-deepseek](./dsh-llm-deepseek.md) 的「另一半双胞胎」 |
| [`@deepseek-ai/dsh-llm-retry`](./dsh-llm-retry.md) | `llm-retry` | `base` | 把每条 provider 路由自带的 retry policy 真正**执行**出来的那个插件——它挂在 agent loop 的 `agent/request-error` waterfall 上，而**不是**去包 `ctx.llm.stream()` |
| [`@deepseek-ai/dsh-agent-default-model`](./dsh-agent-default-model.md) | `agent-default-model` | `base` | 回答「新建一个没有会话级模型选择的 Agent 时用哪个 provider/model」——一个与传输层无关的进程级默认值，出厂指向 [llm-deepseek](./dsh-llm-deepseek.md) 的 `deepseek-official` 路由 |

## Agent 核心与提示词 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-agent`](./dsh-agent.md) | `agent` | `base` | Agent 句柄接口、注册表、进程内 initiator scope 和整套 `agent/*` 事件词表；它自己一行循环逻辑都没有，所以具体循环（[agent-loop](./dsh-agent-loop.md)）是可换的 |
| [`@deepseek-ai/dsh-agent-loop`](./dsh-agent-loop.md) | `agent-loop` | `base` | 整个 harness 里**唯一**含具体循环逻辑的包——它实现 [agent](./dsh-agent.md) 定义的 `Agent` 接口，驱动 session/turn/step 生命周期，并把自己注册成 `ctx.agents` 的工厂 |
| [`@deepseek-ai/dsh-agent-instructions`](./dsh-agent-instructions.md) | `agent-instructions` | `base` | 按 session 加载 `AGENTS.md` 兼容文件——先把"用户全局 + 项目"的基线指令注入持久历史，之后跟着成功的文件系统工具调用发现更深目录的嵌套文件，并在变更/消失时补发通知 |
| [`@deepseek-ai/dsh-system-prompt`](./dsh-system-prompt.md) | `system-prompt` | `base` | system prompt 的装配注册表——插件往里塞有序 section、工具 schema 和具名变量，[agent-loop](./dsh-agent-loop.md) 每个 step 装配一次并渲染成完整 prompt；它自己拥有固定的 harness 身份句和全局部署 persona |
| [`@deepseek-ai/dsh-token-meter`](./dsh-token-meter.md) | `token-meter` | `base` | 可重放的 token 计量服务 `ctx.tokenMeter`——按 session 独立地从持久日志折叠出"当前请求压力 + 逐节点表面定价"，让 compaction 之类的压力敏感插件共享同一套账，而不必依赖 `CompactionEngine`（`README.md:5`） |

## 会话与持久化 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-session`](./dsh-session.md) | `session` | `base` | 事件溯源的会话日志与内存 store（`ctx.sessions`），append-only 的 `SessionEvent` 序列是整段交互史的唯一事实源，发给模型的 message 历史是从它**派生**出来的，而不是它本身 |
| [`@deepseek-ai/dsh-session-persistence-jsonl`](./dsh-session-persistence-jsonl.md) | `session-persistence-jsonl` | `base` | 默认的耐久落盘后端，把 [session](./dsh-session.md) 的事件日志按会话写成一份 append-only 的逻辑 JSONL，默认物理编码是带校验和的 Zstandard 帧串（`.jsonl.zstd`） |
| [`@deepseek-ai/dsh-session-projection`](./dsh-session-projection.md) | `session-projection` | `base` | 会话投影的 Service Definition 与驱动注册表（`ctx.sessionProjections`）——各领域插件注册**纯数学**（`init`/`apply`/`view` 三个同步函数），框架负责订阅 `session/event` 并把每条已提交事件喂给每个单元，最后把完成的整值交给 carrier |
| [`@deepseek-ai/dsh-session-projection-cache`](./dsh-session-projection-cache.md) | `session-projection-cache` | `web-app` | 给 [session-projection](./dsh-session-projection.md) 的投影值做耐久检查点（`ctx.sessionProjectionCache`），一个会话一条记录，让会话列表能零 I/O 读到投影值、冷读会话不必整份加载日志 |
| [`@deepseek-ai/dsh-session-query-sqlite`](./dsh-session-query-sqlite.md) | `session-query-sqlite` | `base` | `ctx.sessionQuery` 的具体实现，用 SQLite FTS5 给会话语料做全文检索——但**默认是关的**（`openAt: never`），只有精确读、过滤和血缘追踪在跑 |
| [`@deepseek-ai/dsh-session-checkpoint-policy`](./dsh-session-checkpoint-policy.md) | `session-checkpoint-policy` | `base` | 纯拦截型的"语义耐久策略"——在模型 adapter 收到请求之前、顶层工具体可能产生外部副作用之前、以及每个 `agent/pre-step` 边界上，各插一次 `ctx.sessions.flush()`，把"什么时候必须落盘"这个决定从持久化后端里拆出来单独持有 |

## 会话周边：标题、导出、统计、遥测 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-session-title`](./dsh-session-title.md) | `session-title` | `base` | 会话标题是日志里的 `session/title` 事件流，最新一条即当前标题；插件先落一个确定性的"取首条人类消息前几个词"兜底标题，再把**唯一一个**异步 provider 槽位留给模型生成器 |
| [`@deepseek-ai/dsh-session-title-first-prompt-llm`](./dsh-session-title-first-prompt-llm.md) | `session-title-llm` | `base` | 往 [session-title](./dsh-session-title.md) 的唯一 provider 槽位里插一个模型生成器——只拿**第一条**人类消息去问模型要一个标题，一次会话最多自动跑一次 |
| [`@deepseek-ai/dsh-session-telemetry-otel`](./dsh-session-telemetry-otel.md) | `session-telemetry-otel` | `base` | 会话日志的 OTLP 上报后端，**默认 `DISABLED`、什么都不发**；一旦开成 `FULL`，它把会话事件的 `event.data` 原样映射成 OTel log record 发出去——而 dsh 自己**一条脱敏规则都没带** |
| [`@deepseek-ai/dsh-session-log-export`](./dsh-session-log-export.md) | `session-log-download` | `web-app` | Web 端的"把这个会话打包下载"控件——宿主侧只注册一个 `/export` 命令，浏览器侧提供 Session Header 上的按钮、一个下载控制器和一个共享弹窗；ZIP 本身由 `dsh-host-apiproxy` 的下载端点流式产出 |
| [`@deepseek-ai/dsh-session-stats`](./dsh-session-stats.md) | `session-stats` | `web-app` | 往会话投影注册表里加一个 `sessionStats` 单元，从整条日志折出轮次/步数与 LLM、工具、首 token、解码四类墙钟时间——**翻页和压缩都改不动这些数字** |

## 工具框架与全局工具中间件 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-tools`](./dsh-tools.md) | `tools` | `base` | 工具注册表兼执行管线本体——每个 `tool-*` 插件把 schema 和 executor 注册进它，每个拦截型插件挂在它开出的 waterfall 上，本组另外两篇都是它的下游 |
| [`@deepseek-ai/dsh-tool-call-timeout-policy`](./dsh-tool-call-timeout-policy.md) | `timeout-policy` | `base` | 一个 `tools/execute` 环绕拦截器，给自己声明了 `timeoutMs` 的工具装上协作式截止时间，超时就把结果整个换成结构化的 `TOOL_TIMEOUT` |
| [`@deepseek-ai/dsh-repeat-tool-reminder`](./dsh-repeat-tool-reminder.md) | `repeat-tool-reminder` | `base` | 数每个 agent 连续调用同一工具、同一参数的次数，撞到配置的阈值就往结果后面塞一条劝退提醒——只劝不拦，既不否决也不改写调用 |

## 文件系统工具与文件中间件 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-tool-fs`](./dsh-tool-fs.md) | `tool-fs` | `base` | 模型面前的 `read` / `read_image` / `write` / `edit` 四个文件工具连同它们的执行器——工具名、schema、参数校验、读窗口、结果渲染都归它，真正的 IO 走 `ctx.fs`，而"读过才准写"的策略由 [fs-observation-policy](./dsh-fs-observation-policy.md) 通过事件旁挂 |
| [`@deepseek-ai/dsh-tool-fs-search`](./dsh-tool-fs-search.md) | `tool-fs-search` | `base` | 模型面前的 `glob` / `grep` 两个发现类工具，底座是**随包发布的 ripgrep 二进制**（`@vscode/ripgrep`），经 `ctx.subprocess` 起进程，**不走 `ctx.fs`**，所以文件系统 provider 不必长出一套搜索 API |
| [`@deepseek-ai/dsh-tool-str-replace-editor`](./dsh-tool-str-replace-editor.md) | `tool-str-replace-editor` | `base` | 把 `view` / `create` / `str_replace` / `insert` 四个命令塞进**一个**名叫 `str_replace_editor` 的工具，跑在 `ctx.fs` 之上——与 [tool-fs](./dsh-tool-fs.md) 的四工具方案并行存在的另一套模型接口，共用同一套 `fs/*` 事件与沙箱策略 |
| [`@deepseek-ai/dsh-fs-observation-policy`](./dsh-fs-observation-policy.md) | `fs-observation-policy` | `base` | 纯中间件插件——它**不注册任何 service**，只挂三个 `fs/*` 监听器，把"这个 session 读过没读过这个文件"记在 `WeakMap` 里，据此给写/改操作生成 provider 级守卫，实现"读过才准写、读过才准改" |
| [`@deepseek-ai/dsh-fs-sandbox`](./dsh-fs-sandbox.md) | `fs-sandbox` | `base` | 会拦截的 `ctx.fs` 实现——它继承 `LocalFileSystem` 的全部文本存储机制，只在 `writeText` / `editText` 上加一道按调用解析的模式围栏；读永远放行，因为每种模式都允许读 |

## Shell 与子进程 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-tool-bash`](./dsh-tool-bash.md) | `tool-bash` | `base` | 把 `ctx.shell` 执行器封装成模型可见的 `bash` 工具——负责参数校验、workdir 归属、沙箱升权审批、结果文本渲染，并把后台进程句柄适配进通用 `ctx.jobs` 运行时 |
| [`@deepseek-ai/dsh-tool-pwsh`](./dsh-tool-pwsh.md) | `tool-pwsh` | `base` | [tool-bash](./dsh-tool-bash.md) 的 PowerShell 方言孪生体——同一个 `ctx.shell` 接缝、同一套参数与渲染，只是命令走 `pwsh -Command`、路径用 `C:\...`、环境变量用 `$env:NAME` |
| [`@deepseek-ai/dsh-bash-sandbox`](./dsh-bash-sandbox.md) | `bash-sandbox` | `base` | 默认组合里 `ctx.shell` 的真正提供者——它继承本地 bash 执行器的全部进程机制，把每条命令的 `['bash', '-c', command]` argv 交给 `ctx.sandbox` 包一层限制再 spawn，并把「用了哪个模式、有没有被拒、限制是否完整」当作结果事实盖回去 |
| [`@deepseek-ai/dsh-pwsh-sandbox`](./dsh-pwsh-sandbox.md) | `pwsh-sandbox` | `base` | [bash-sandbox](./dsh-bash-sandbox.md) 的 PowerShell 孪生体——Windows 上 `ctx.shell` 的提供者，把 `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` 的整条 argv 交给 `ctx.sandbox` 包住再 spawn |
| [`@deepseek-ai/dsh-shell-env`](./dsh-shell-env.md) | `shell-env` | `base` | `ctx.shellEnv` 注册表——每次 shell 工具调用现场收集一份可信的 `DSH_*` 环境快照，内置事实归它自己所有，其他插件按声明注册键，重复占用或返回未声明键都当场炸 |
| [`@deepseek-ai/dsh-subprocess-local`](./dsh-subprocess-local.md) | `subprocess` | `base` | `ctx.subprocess` 的本地实现——这棵树上所有子进程（shell 命令、ripgrep、LSP server、PTY 会话）最终都从这里 spawn；它负责分离进程树、平台正确的整树终止、有界输出收集与 spill、凭据擦洗，以及退出时的兜底清理 |

## 沙箱与审批 ✅

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-sandbox-local`](./dsh-sandbox-local.md) | `sandbox` | `base` | `ctx.sandbox` 的本机实现——把调用方即将 spawn 的 argv 包一层平台 runner（Linux `bwrap`/Landlock、macOS Seatbelt、Windows ACL 受限令牌），选不出可用 runner 就抛 `SANDBOX_UNAVAILABLE` 失败关闭，绝不把未受限的原 argv 放回去 |
| [`@deepseek-ai/dsh-sandbox-policy`](./dsh-sandbox-policy.md) | `sandbox-policy` | `base` | 沙箱策略的唯一归属地（`ctx.sandboxPolicy`）——把「部署默认 mode + 兜底 workspaceRoot」和「会话级 `sandbox/mode` 覆盖 + 会话不可变 cwd」合成每次调用一份完整策略，顺带在每个请求前把当前策略讲给模型听 |
| [`@deepseek-ai/dsh-user-approval`](./dsh-user-approval.md) | `approval` | `base` | 与渠道无关的一次性审批 seam（`ctx.approval`）——`request()` 只会返回 `allowed-once` / `rejected` / `cancelled` / `unavailable` 四种结果，没有 answerer 或 answerer 抛错一律算失败关闭，授权只对这一次被问的动作生效 |
| [`@deepseek-ai/dsh-permission-presets`](./dsh-permission-presets.md) | `permission` | `base` | 把两个各自独立的执行旋钮——[sandbox-policy](./dsh-sandbox-policy.md) 的 `sandbox/mode` 与 [user-approval](./dsh-user-approval.md) 的 `approval/policy`——打包成用户能一次选好的命名档位，自己**不做任何强制**，只记录意图再通过两个旋钮各自的写路径落下去 |

## 子 agent ⚠️

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-subagent`](./dsh-subagent.md) | `subagent` | `base` | 子 agent 能力缝本体——按名字注册的 provider registry，加上一次性子 agent 的 `start()`、可续子 agent 的 continuation manager、写进子会话日志的持久 descriptor，以及不依赖任何 query 服务的子/后代枚举 |
| [`@deepseek-ai/dsh-subagent-spawn-in-process`](./dsh-subagent-spawn-in-process.md) | `subagent-spawn-in-process` | `base` | 往 `ctx.subagents` 上注册名为 `spawn` 的 provider——在当前进程里开一个**全新**子 Agent，自己的 session、零父对话历史，复用宿主的 agent factory 与 LLM/工具服务 |
| [`@deepseek-ai/dsh-subagent-fork-in-process`](./dsh-subagent-fork-in-process.md) | `subagent-fork-in-process` | `base` | 往 `ctx.subagents` 上注册名为 `fork` 的 provider——同样在本进程开子 Agent，但用父会话「到最后一个 `turn/end` 为止」的完整前缀做种子，所以子看得见父**已完成**的对话 |
| [`@deepseek-ai/dsh-tool-subagent`](./dsh-tool-subagent.md) | `tool-subagent` / `tool-subagent-fork` | `base` | 模型可见的委派工具，一个插件实例绑定一个 `ctx.subagents` provider 和一个工具名；换 provider 只换传输，不换执行契约 |
| [`@deepseek-ai/dsh-tool-subagent-control`](./dsh-tool-subagent-control.md) | `tool-subagent-control` | `base` | 全局唯一的 `send_message` 和 `interrupt_agent` 两个工具，是 `ctx.subagents.followup()` / `interrupt()` 的薄适配层——父到子的方向；`list_agents` 在同包的[子路径插件](./dsh-tool-subagent-control--list-agents.md)里单独加载 |
| [`@deepseek-ai/dsh-tool-subagent-control/list-agents`](./dsh-tool-subagent-control--list-agents.md) | `tool-subagent-list-agents` | `base` | 唯一的 `list_agents` 工具——把 `ctx.subagents` 的持久子目录投影成「只含可续子」的列表，并用在线 Agent registry 把状态细化成 `running` / `idle` / `ready` |
| [`@deepseek-ai/dsh-tool-subagent-report`](./dsh-tool-subagent-report.md) | `tool-subagent-report` | `base` | 给每个**可续的进程内子** agent 装上作用域局部的 `report` 工具和配套 prompt 段——子到父的返回通道，`ctx.subagents.reportFrom()` 的薄适配层 |

## 工作流与代码运行时 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-workflow-worker-thread` | `workflow-worker-thread` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-tool-workflow` | `tool-workflow` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-code-runtime-worker-thread` | `code-runtime` / `code-runtime` | `headless` + `web-app` | 待补 |

## 压缩与溢出 ⚠️

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-compaction-basic`](./dsh-compaction-basic.md) | `compaction-basic` | `base` | dsh 默认的压缩后端——它是 `ctx.compaction` 这个 capability seam 的 Service Provider，用 `ctx.tokenMeter` 在每个 step 边界测压，超过阈值就把最老的一段 surface 换成一条带 `<compacted-summary>` 框的检查点消息 |
| [`@deepseek-ai/dsh-compaction-tool-result-pruner`](./dsh-compaction-tool-result-pruner.md) | `tool-result-pruner` | `base` | 不调模型的确定性剪枝服务——把 surface 上超预算的 `tool/result` 节点重写成「头部 + 固定省略标记 + 尾部」，原始事件仍完整留在 append-only 会话日志里 |
| [`@deepseek-ai/dsh-command-compact`](./dsh-command-compact.md) | `command-compact` | `base` | 把 `/compact` 这个人类命令接到 `ctx.compaction.compactNow()` 上——在自动阈值之下也强制做一次有用的压缩，不占用一次模型 turn |
| [`@deepseek-ai/dsh-spill-local`](./dsh-spill-local.md) | `spill-local` | `base` | spill 存储 seam 的本地文件系统实现——把工具的超大文本写进一个私有的、按 session 分目录的文件，返回文件路径作为 locator 和一句 `read`/`grep` 的取回提示 |
| [`@deepseek-ai/dsh-spill-policy`](./dsh-spill-policy.md) | `spill-policy` | `base` | 工具结果外溢策略——一个 `tools/post-execute` 的 waterfall 变换器，把超过 `maxInlineBytes` 的纯文本结果全文存进 `ctx.spillStore`，模型侧只留一段有界的头尾预览加一行「存在哪、怎么取」的告示 |

## 技能 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-skill` | `skill` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-skill-filesystem` | `skill-filesystem` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-skill-badge` | `skill-badge` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-tool-skill` | `tool-skill` | `base` | 待补 |

## 命令、目标与反馈 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-commands` | `commands` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-command-feedback` | `command-feedback` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-goal` | `goal` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-goal-round-driver` | `goal-round-driver` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-command-goal` | `command-goal` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-tool-goal` | `tool-goal` | `base` | 待补 |

## 计划、待办与 Ralph ⚠️

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| [`@deepseek-ai/dsh-plan-mode`](./dsh-plan-mode.md) | `plan-mode` | `base` | 把「计划模式」做成一条从会话日志折叠出来的 per-agent 状态——开着时往系统提示插一段部署方写死的 guidance，靠 `exit_plan_mode` 走人工审批退出；它只劝导，不强制 |
| [`@deepseek-ai/dsh-tool-todo`](./dsh-tool-todo.md) | `tool-todo` | `base` | 一个只有 `todo_write` 一件事的插件——模型每次把**整张任务清单**重发一遍，插件把快照原样 append 成一条 `todo/write` 会话事件，UI 从事件流里自己渲染 |
| [`@deepseek-ai/dsh-tool-ralph`](./dsh-tool-ralph.md) | `tool-ralph` | `base` | 一个 `ralph` 工具，前台跑一段**编译期写死的 workflow 脚本**，把同一个不可变 objective 交给一串全新的 child agent，一轮一个，轮间只传一份有大小上限的结构化 handoff |

## 联网与搜索 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-web` | `web` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-web-search-deepseek` | `web-search-deepseek` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-tool-web` | `tool-web` | `base` | 待补 |

## 后台任务与用户提问 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-jobs-local` | `jobs` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-tool-jobs` | `tool-jobs` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-user-questions` | `user-questions` | `base` | 待补 |

## 设置、凭据与附件 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-settings-file` | `settings` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-credentials-local` | `credentials` | `base` | 待补 |
| ⏳ `@deepseek-ai/dsh-attachment-local` | `attachment-local` | `base` | 待补 |

## 存储、工作区与消息反馈 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-storage` | `storage` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-storage-json` | `storage-json` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-storage-domain` | `storage-domain` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-workspace` | `workspace` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-message-feedback` | `message-feedback` | `web-app` | 待补 |

## Host 进程与 Web 服务端 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-host-webserver` | `webserver` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-host-apiproxy` | `api-gateway` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-host-directory-picker-auto` | `directory-picker` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-host-plugin-inventory` | `plugin-inventory` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-cordis-host-runner` | `cordis-host-runner` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-web-app` | `web-runtime` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-web-app/startup` | `web-startup` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-api-remotes` | `api-remotes` | `web-app` | 待补 |

## 浏览器侧运行时 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-client-hmr` | `client-hmr` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-modules` | `modules` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-connection` | `connection` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-runtime` | `client-runtime` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-cordis-client-runner` | `cordis-client-runner` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-theme` | `ui-theme` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-locale` | `locale` | `web-app` | 待补 |

## Web UI：外壳与设置面板 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-client-ui-layout` | `ui-layout` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-sidebar` | `ui-sidebar` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-settings` | `ui-settings` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-settings-general` | `ui-settings-general` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-settings-models` | `ui-settings-models` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` | `ui-settings-plugin-inventory` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-settings-plugins` | `ui-settings-plugins` | `web-app` | 待补 |

## Web UI：会话与工具视图 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-client-ui-conversation` | `ui-conversation` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-tool` | `ui-tool` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-cordis` | `ui-cordis` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-trajectory` | `ui-trajectory` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-message-feedback` | `ui-message-feedback` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-user-questions` | `ui-user-questions` | `web-app` | 待补 |

## Web UI：工作区、技能与命令 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-client-ui-workspace` | `ui-workspace` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-input-trigger` | `ui-input-trigger` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-commands` | `ui-commands` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-skill` | `ui-skill` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-deliverables` | `ui-deliverables` | `web-app` | 待补 |

## Web UI：子 agent、工作流与计划 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-client-ui-subagent` | `ui-subagent` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-workflow-run` | `ui-workflow-run` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-jobs` | `ui-jobs` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-goal` | `ui-goal` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-plan` | `ui-plan` | `web-app` | 待补 |

## Web UI：模型与权限选择 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-client-ui-model-selection` | `ui-model-selection` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-permission-presets` | `ui-permission` | `web-app` | 待补 |
| ⏳ `@deepseek-ai/dsh-client-ui-agent-preset` | `ui-agent-preset` | `web-app` | 待补 |

## Headless 与 agent 预设 ⏳

| 插件 | 配置树 id | bundle | 一句话 |
|---|---|---|---|
| ⏳ `@deepseek-ai/dsh-headless` | `headless-runner` | `headless` | 待补 |
| ⏳ `@deepseek-ai/dsh-headless/startup` | `headless-startup` | `headless` | 待补 |
| ⏳ `@deepseek-ai/dsh-agent-presets` | `agent-presets` | `web-app` | 待补 |

