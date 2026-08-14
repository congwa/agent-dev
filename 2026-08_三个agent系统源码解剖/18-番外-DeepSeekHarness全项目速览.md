# 18 · 番外：DeepSeek Harness 全项目速览——第五个样本

> **一句话导读**：DeepSeek 在 2026-08-13 开源的 `dsh` 是本系列里第一个**把 harness 本身当产品发布**的样本——不是"某公司自用 coding agent 顺手开源"，而是"我们做了一个可组合的 agent 运行时，欢迎你在上面造你自己的产品"。它的口号"Everything is a Plugin"这次不是市场语言：**agent loop 是启动配置里的一行 YAML**（`packages/bundle/base/cordis.patch.yml:436`），219 个包里对循环实现有运行期依赖的只有 1 个，而且这条纪律是 `peerDependencies` 图上机器可查的。代价同样明码标价：插件就是普通 npm 包，装进来直接拿到完整 `ctx`，**零签名、零权限声明、零隔离**。
>
> 调研时间：**2026-08-14**。仓库 `deepseek-ai/deepseek-harness`，读的是当日 HEAD（commit `47f9438`，2026-08-13 19:38，`Merge pull request #2519 … feat/npm-public`），版本 `0.1.0-rc.5`（npm 上 `@deepseek-ai/dsh` 已到 `0.1.0-rc.6`）。调研方式：仓库 clone 到本地，**15 路并行按维度读源码 + 逐条对抗式核验引用**（共核验 973 处 file:line 与英文引文，修正 269 处）。文中所有行号、计数为当日实测。
>
> **本章定位**：番外，也是 DeepSeek Harness 的总入口。第 01–15 章各在章末有「第五个样本：DeepSeek Harness」小节按各自维度展开，16 章总表已扩入 dsh 列；本章负责全项目视图、工程形态与总判断。前四个样本的既有结论不受影响——但第 06 章那条"最硬的结论"被逼到了一个更精确的位置，见第 4 节。

---

## 0. 背景：一天涨五万 star 的东西是什么

- **发布**：2026-08-13，developer preview，MIT。GitHub 仓库 `deepseek-ai/deepseek-harness` 的 `created_at` 就是 2026-08-13T11:56:32Z。据媒体报道它与 DeepSeek-V4-Pro 同日发布，被定位为 Claude Code 的开源对手（VentureBeat、The New Stack，**第三方来源，未经官方逐条确认**）。
- **热度**：2026-08-14 实测 **54,107 star / 4,387 fork**；同日约两小时后复测 **59,012 star / 4,865 fork**。这个速度在本系列四个前样本里没有对应物（Grok Build 开源三周 24k+）。
- **形态**：`npx @deepseek-ai/dsh web` 起一个 **Web UI**（默认 `127.0.0.1:3080`）。**这是四个前样本都没有的默认形态**——Pi/Codex/Grok 都是 TUI 优先。仓库里有过 TUI（`.agents/notes/archived/` 下留着 `2026-07-22-tui-interactive-extension-service`、`2026-07-27-tui-chat-channel-module-split` 两篇归档笔记），现在 `packages/` 下已无 TUI 包。
- **开放姿态**：不收外部 PR，但措辞与 Grok Build 是两个极端。Grok 的 CONTRIBUTING 是"This repository does **not** accept external pull requests or unsolicited patches."；dsh 的原话是：

  > "We are sorry that we cannot accept external pull requests at the moment."
  > "DeepSeek Harness is designed to be deeply customizable. **We do not believe that packages in the official repository are inherently more important than packages created by the community.** You may consider this repository an idea, an official showcase, and a source of inspiration, but not a mandate from us."

  同一条限制，一个是"别想改我"，一个是"别等我"。这不只是文案：出厂 profile 装的工具**远少于**工具目录里列的（默认 root agent 模型可见约 25 个工具名，而生成的 `docs/tool-catalog.md` 有 52 个工具小节）——官方组合本来就只是众多组合之一。

- **公共仓库的形态**：Issues **关闭**（GitHub API `has_issues: false`），反馈走 Discussions；公开仓库里 PR 数为 0，但 git 历史里全是 `Merge pull request #2519 from deepseek-harness/...` 这类记录——**代码历史是完整导入的，协作记录不是**。

**四个前样本 + dsh 的"开源性质"四分**：

| | 历史 | 外部 PR | 议题 |
|---|---|---|---|
| Pi | 完整公开 | 收 | 开 |
| Codex | 内部 monorepo 周期镜像 | 收（有限） | 开 |
| Grok Build | **无 git 历史**（单快照） | 不收 | — |
| **dsh** | **完整公开**（12,293 commit，回溯到 2026-06-10 第一个 commit） | 不收 | **关**（走 Discussions） |

历史完整这一条比看起来重要得多：第 15 章那节能写出"遥测默认值是开源前 3 天才从开翻到关的"，靠的就是 `git log -S`。**评估一个 agent 的数据边界，只 grep 当前 HEAD 是不够的。**

---

## 1. 规模与工程形态：测试比源码多，文档几乎和源码一样密

| 指标 | 数值 | 口径 |
|---|---|---|
| workspace 包 | **219 个**（`packages/<组>/<包>/`，另有 apps/vendor/native/website） | 目录计数 |
| 源码 | **227,637 行 / 1,324 文件** | `packages/*/*/src` 下 .ts/.tsx/.vue |
| 测试 | **268,040 行 / 854 文件** | `packages/*/*/tests`，**是源码的 1.18 倍** |
| 包 README | **268 篇 / 13,818 行** | 几乎一包一篇，且是规格书而非简介 |
| 文档 | **215 篇 md**（110 英文 / 105 中文镜像），英文侧 27,598 行 | `docs/`，含 46 篇子系统文档 + 4 篇事故复盘 |
| Agent Note | **684 篇** | `.agents/notes/`：implemented 506 / archived 142 / proposed 25 / rejected 11 |
| 仓库门禁脚本 | 145 个 | `scripts/` |
| 提交 | **12,293 个 / 37 位作者 / 65 天**（2026-06-10 起，7 月单月 8,273 个） | `git rev-list --count` |
| 最大的包组 | `packages/client/*`（Web 前端）71,896 行，占 src 的 31.6% | — |
| 核心组 | `packages/core/*` 仅 13,462 行，其中 `agent-loop` **1,643 行** | — |

三个数字放在一起就是这个项目的性格：**引擎 1,643 行，前端 7.2 万行，测试 26.8 万行**。

**CI 的覆盖率门禁是 per-file 100%**（`packages/*/*/src`，`pnpm run test:coverage`），`vitest.config.ts` 里还专门写了一个自定义 reporter，在文件没达标时打印每一条未覆盖语句的 `path:line:col`——因为内置阈值报错只报文件名。豁免是逐条具名的（Windows 专属包在 Linux 通道排除、需要真 pwsh 的套件在无 pwsh 主机豁免），每条都带理由注释。

**这个仓库自己是 agent 造的，而且留下了痕迹**：984 个 PR 合并里，分支名前缀 `worktree/` 210 个、`codex/` 203 个、`claude/` 3 个（`codex/<slug>` 是 Codex 自动生成的分支命名）。`AGENTS.md` 有一条硬规定："**Non-trivial changes MUST include an Agent Note in the same PR**"——684 篇 Agent Note 就是这么攒出来的，每篇记录一个设计决策**以及被否掉的备选方案**。`.agents/skills/` 下还有 11 个仓库专用 skill（`dsh-code-review`、`dsh-prose-standard`、`dsh-pre-push-checks`、`dsh-translate-docs`、`dsh-trim-cot-leakage`……），`.claude/skills` 是它的镜像。

**它还公开了 4 篇事故复盘**（`docs/postmortem/`），这是五个样本里独一份。复盘的判据写得很清楚：只有**subtle + systemic + costly to rediscover** 的 bug 才写，重点是"为什么我们的流程放它过去了"而不是那一行修复。其中 0003 是一篇**agent 在开发 dsh 自己的 Web GUI 时把自己绕晕**的复盘：模型改了主题、起了一个裸 Vite 拿到 HTTP 200 就宣布成功（实际白屏，因为 `window.__DSH_BOOT__` 只有完整 host 会注入），又在另一个端口起了个替身服务器去验证，而用户原来那个页面早就刷出新主题了。复盘里逐条引用了真实会话事件日志的 seq 号。**用自己的产品开发自己的产品，然后把翻车过程写成公开档案——这件事本身比任何架构图都能说明这个团队怎么工作。**

---

## 2. 架构：第五种答案是"把内核删掉"

### 2.1 底座 Cordis：不是 DeepSeek 发明的

`dsh` 的框架层是 **vendored 的 Cordis**——`cordiverse/cordis`，2022-05-17 就存在的社区 meta-framework（调研日 1,910 star，MIT，作者 Shigma），自称 "A Meta-Framework of Spatiotemporal Composability"，设计写成了论文 _A Programming Paradigm for Spatiotemporal Composability_。核心只有 **2,693 行 / 9 个 .ts 文件**。

DeepSeek 做的是**把整个 Cordis 生态 fork 下来源码内联**：`vendor/` 下 9 个包全部改名到 `@deepseek-ai/*` 域重新发布，理由写在 `vendor/README.md` 里——发布 harness 就等于发布这一层框架，用上游名字发布会占坑（squat）。除 cordis core 仍指向 `cordiverse/cordis` 外，其余六个插件包的上游已经是 `github.com/deepseek-harness/*` 的 fork。有意思的反向影响：**Cordis 仓库的 homepage 字段现在指向 dsh 的文档站**（`deepseek-harness.github.io/deepseek-harness/reference/cordis-primer`）。

`vendor/README.md` 的"Local modifications"一节要求逐条穷尽记录，配一个 pre-commit 门禁（改了 `vendor/*/src` 而没改 README 直接拒绝提交）。其中第 6 条是**给上游 Cordis 的 fiber 生命周期打的补丁**：修了三处可重入卸载的空洞（setup 期间开始卸载、同步 setup 失败的回滚、`UNLOADING` 期间拒绝新建 effect）。一个 agent 产品把上游 DI 框架的并发销毁语义修了一遍——这是"一切皆插件"这个赌注的真实成本。

Cordis 给的四个原语，正好解释了后面所有维度上 dsh 为什么长这样：

| 原语 | 是什么 | 后果 |
|---|---|---|
| `ctx`（Context） | 一个 Proxy；`extend`/`isolate`/`intercept` 全走原型链再套一层，**从不改父 context** | 每个 agent 能有自己的一棵能力树 |
| Service | 构造函数里直接 `ctx.reflect.provide(name, self, ...)` | **声明服务即注册**，随 fiber 卸载自动注销 |
| `ctx.effect()` | 收集 disposer，卸载时**逆序**执行；`ctx.on()` 本身就是 effect | 装/卸一个中间件不用重启 agent（HMR 直接可用） |
| 事件总线 5 种派发模式 | `emit / parallel / serial / bail / **waterfall**` | **洋葱是框架原语，不是 dsh 自己发明的**（见第 4 节） |

### 2.2 "一切皆插件"的证据

官方文档的原话（`docs/architecture.md:11`）：

> "Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and **the agent loop itself**, so every part is replaceable from configuration."

这句话可以被代码验证，而且验证方式是可量化的：

```yaml
# packages/bundle/base/cordis.patch.yml:436-439 —— agent loop 就是第 N 行配置
    - id: agent-loop
      name: '@deepseek-ai/dsh-agent-loop'
      config:
        agents: []
```

- 启动 = 一棵按层组合的插件树：**bundle 按序 → profile 自己的 `cordis.patch.yml` → home 级 → `--patch` 覆盖层**，叠在一个空 root 上。patch 按 `id` 命中后**整体替换**该行 config（不深合并）。`dsh --profile web --dump-config` 打印实际启动的树。
- 规模：`dsh-base` 78 行插件行（每个 profile 的第一层），`dsh-web-app` 再叠 78 行，`dsh-headless` 只有 6 行。headless bundle 就是用同一个 `id` 把 `hmr` 那行整个 `disabled` 掉的。
- **依赖图上的硬证据**：219 个包按 `peerDependencies` 统计，对 `dsh-agent-loop` 有运行期依赖的只有 **1 个**（还是 `packages/examples/agent-spine-demo`，即那个"负责组装骨架"的组合包）；作为对照，`dsh-session` 有 80 个、`dsh-llm` 78 个、`dsh-agent` 58 个、`dsh-tools` 43 个，`@deepseek-ai/cordis` 是 219/219。**大家依赖接口，没人依赖循环。**
- 第 01 章记过 Codex 的铁律：TUI 源码里 `codex_core::` 引用数为 0。dsh 把同一件事做到了另一个方向：**没有人依赖循环的实现**。而且 UI 侧也跑一棵 cordis 树——浏览器里自己 `new Context()` 再 `ctx.plugin(Loader)`，UI 组件是 `extends Service` 的 cordis 服务；host 面和 client 面是**两个互斥的 TS program**，因为两侧对同一个 `Context` 做同名 key 的 declaration merging，合并了就编不过。打包器层还有一个 `dsh-client-bundle-purity` 插件，跨插件的值导入直接 throw。

### 2.3 capability seam：换一个 provider，整个执行世界搬家

`docs/architecture.md:100` 定义的 seam 是三角形：**Service Definition（接口）+ Service Provider（实现）+ Consumer（用它的人，通常是模型可见的工具）**，缺一不成 seam。这个约束的实际收益写在 `:102`：

> "Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks."

`packages/e2b/` 就是这句话的兑现：换上 `fs-e2b` + `subprocess-e2b` 两个 provider，bash / 持久终端 / LSP 一起搬到远端沙箱，工具本身一行不改。

---

## 3. 逐维度速览：dsh 在五家坐标系里的位置

| 维度（对应章） | dsh 的答案 | 最接近谁 |
|---|---|---|
| 分层 [01] | 循环是配置树里的一行 YAML；边界靠依赖图机器可查 | Codex（但更极端） |
| 循环形状 [02] | 三层手写 loop，**循环体合计 192 行**（`agent.ts:210-401`）；历史不在循环里（每次从日志投影）；停止由 inbox 里的**数据**决定而非钩子返回值 | Codex/Grok 同族 |
| 上下文 [03] | system prompt 是注册表不是模板（28 个源码文件按 `order` 认领段落），实测 0.75–45KB **全由配置决定**；动态事实不进 prompt，走日志化的 user 快照 | Pi 的极化版 |
| 压缩 [04] | append-only 日志上的"**区间替换**"：头锚定、两端靠 tool-call 括号计数判平衡；摘要请求**刻意做成会话真前缀以复用 KV cache** | 结构像 Pi，方向像 LangChain |
| 工具与执行 [05] | 三条 waterfall + 单调 guard；并行是"策略串行 / 执行重叠 / 结果按模型序提交"；**写冲突锁下沉到 fs provider**（per-realpath FIFO + 乐观版本号） | Codex |
| Code Mode [05] | **有，但是可选 overlay**：`run_code`（TS/Python，Node worker_thread），三态 native/code/both | Codex（但解耦） |
| 中间件 [06] | 真洋葱（`(payload, next)`），13 个 waterfall 拦截点；但 `next()` **只能走一遍** | LangChain 的形 |
| 钩子 [06] | Claude Code / Codex 两套 hook 协议桥，且**被定位成兼容层而非一等公民** | 权力关系与 Codex/Grok 相反 |
| 插件分发 [07] | 插件 = 普通 npm 包（manifest 加 `dsh.bundle.patch` 一行）；`dsh plugin` 只是 pnpm 的转发器；**零签名零沙箱** | LangChain（外包给包管理器） |
| MCP [08] | 一个 929 行插件，**只桥 tools**：零 OAuth、零按需加载、不当 MCP server；但重连监管器是五家最强 | LangChain 的定位 + Codex 的实现 |
| 记忆 [09] | **不做**，且是撤回过厂商直连后的刻意决定；只留 AGENTS.md + 对原始会话日志的 FTS5 全文检索（默认还关着） | Pi（但理由完全不同） |
| 持久化 [10] | 单条 append-only 事件日志（44 种事件，词汇由插件声明合并扩展）+ 投影出模型历史；fork = 前缀复制；**无 rewind、无删除** | Pi 的范式 + Grok 的物理形态 |
| 状态同步 [14] | **不限制谁能写**（19 个包 48 处直接 append），改为把"什么算合法变更"编码成运行时不变式 | 第五种答案 |
| 沙箱 [11] | 三平台内核沙箱（bwrap/Landlock + 自写 298 行 C launcher、Seatbelt、Win32 受限令牌），但语义**只覆盖"文件写效果"** | Codex（工程量约五分之一） |
| 模型抽象 [12] | 一份 `StreamChunk` 契约上并排跑两个内部实现完全不同的适配器（自写 DeepSeek 直连 + **把 Pi 的 `@earendil-works/pi-ai` 当 npm 依赖**） | Pi + LangChain 的叠加 |
| 子 agent [13] | 隔离机制本身是 seam：**6 个 provider 并存**，含把一整个 turn 委派给真的 Claude Code / 真的 Codex 进程 | Grok（编排）+ 超过 Codex v2（actor 化） |
| 遥测 [15] | 一条通道、一个明文一方端点、**默认 DISABLED**、零第三方 SDK、包 README 逐项披露"什么会离开这台机器" | Grok（但没有远程开关） |

---

## 4. 五个最值得记住的发现

### 4.1 洋葱进了产品，但"重试"仍然没进洋葱

第 06 章那条最硬的结论是：三种拦截范式里，**只有洋葱包裹能重试或替换一次模型调用**，因为只有它把 `handler` 交到了拦截器手里。dsh 看起来正是那个反例——它是第一个把 Koa 式 `(payload, next)` 洋葱搬进 agent 主链路的**产品**，`agent/request`、`llm/stream`、三个 `tools/*` 都是 waterfall。

读完 vendored cordis 的实现（`vendor/cordis/src/events.ts:234-243`）才知道不是：waterfall 的 `next()` **不接受参数**（请求不向内传），而且 `cbs.shift()` 的游标是共享的——**同一个监听器第二次调 `next()` 不会重入，只会把内层链路的兄弟监听器整条跳过**。所以能 wrap、能 veto、能替换结果，但不能把内层重放一遍。

真正的 `ModelFallbackMiddleware` 等价物在 dsh 里是这么做的：重试循环留在 loop 自己的 `while (true)` 里，失败时 loop 把**是否再来一次**这一个 bit 通过 `agent/request-error` waterfall 投票出去，插件投 `{ kind: 'retry' }` 就 `continue`，然后重走完整的 `agent/request` 链路换模型。仓库里已经有现成实现（`packages/llm/llm-retry`），而且它最漂亮的一点是：**重试计数不在闭包里，在 session log 里**——`agent.session.append('llm/retry', ...)` 先落盘再等待，下次靠 `findLast` 从事件流里算出已重试次数。

所以第 06 章的结论不用改，但边界要收窄一格：**真正必须的不是 `handler` 回调，而是"谁拥有那个重跑的循环"。** LangChain 把循环给了中间件；dsh 把循环留在 loop、只开放一个 bit。后者换来两个前者没有的性质：重试次数是**持久的**（可跨进程 resume），且重试必然走完整链路不会跳过兄弟监听器。代价是插件做不了"跑 3 次取多数"这种控制流。

顺带一处**文档与代码的张力**（值得每个读者自己去验）：`llm/stream` 的 JSDoc 把自己描述成 "Waterfall around every streaming model call (**retry**, replay, routing)"，`tools/execute` 写 "Around-dispatch waterfall for timeout, **retry**, or metrics"——但按上面的游标语义，真靠二次 `next()` 重试的插件会静默跳过同一 waterfall 上的兄弟监听器。全仓 376 处 `next()` 里没有任何一处这么用。**文档承诺的语义在代码里没有安全实现路径。**

### 4.2 "Model-visible ⟺ logged" 是一条会在运行时 throw 的等式

`AGENTS.md` 里那条规矩——"anything that reaches a model request must be reconstructable from the session log"——在别家是评审纪律，在 dsh 是**每次模型请求前都会跑的断言**：invariant 插件以 `{ global: true, prepend: true }` 挂在 `llm/stream` waterfall 的最前面（prepend 是为了防止某个短路的 replay 监听器把检查静音掉），把**实际要发出去的 messages** 与**从日志重新投影出来的 messages** 做 JSON 逐字节比对，不一致就 fail。

这条断言把好几件事一次性钉死了：中间件不能偷偷往 payload 里塞话（`agent/request` 的文档直接写 "this waterfall cannot mutate messages"，`llm/stream` 拿到的请求是 deep-frozen 的）；任何新的模型可见输入必须先扩展 `SessionEventMap` 加一个事件类型；压缩不能"重建历史"，只能在日志上做区间替换。第 10 章说 Pi 的"日志 + 投影"是最干净的范式，dsh 把它从范式变成了可执行的等式。

配套的是三处 **fail-closed 语义检查点**（模型调用前、顶层工具执行前、pre-step）——本质是 agent 版的 write-ahead logging：副作用发生之前，先确保它已经落盘。

### 4.3 竞品是它的 provider，而且样本 1 是它的 npm 依赖

- `packages/llm/llm-pi-ai` 的实现方式是**把 `@earendil-works/pi-ai`（^0.82.1）整包 import 进来**当多厂商适配器——那正是本系列第一个样本 Pi 的模型抽象包。**dsh 是本系列里唯一一个把另一个样本当依赖的样本。** 而且这不是省事：仓库里同时有一个自己手写 fetch 的 `llm-deepseek`（1,216 行），两者作为"设计验证 twin"并排跑同一份 `StreamChunk` 契约，验收规则写在 Agent Note 里——**任一实现表达不了的东西，就是核心词汇的 bug**。
- `packages/subagent/` 下 6 个 provider 里有 `subagent-claude-code`（走 Claude Agent SDK）和 `subagent-codex`（走 `codex app-server --stdio`，手写 wire 协议）——**把一次委派整个交给真的竞品进程**。跨进程 provider 一律声明 `NO_START_CAPABILITIES`，父侧要求它做不到的事（结构化输出、深度限制、工具过滤）时直接 `UNSUPPORTED_CAPABILITY` 拒绝，而不是接受后忽略。
- 反向佐证一条本系列的旧疑点：第 08 章曾指出 Codex 的 `codex_mcp_interface.md` 声称 `codex mcp-server` 暴露 `thread/*` / `turn/*`，但代码里对不上。dsh 是一个完全独立的第三方实现，它对着 `codex app-server` 发 `thread/start` / `turn/start`——**没有人对着 `codex mcp-server` 实现这套方法**。原来的"存疑"可以升级为结论。

### 4.4 它的 workflow 引擎自陈"modeled on Claude Code's dynamic workflows"

`packages/workflow/` 是模型可写 JavaScript 编排脚本、由引擎执行的多 agent 编排能力。它的血统写在 commit `1d43ea3cd5`（2026-07-05）的正文里，逐字：

> "A new capability family at packages/workflow/ in the bash seam shape, **modeled on Claude Code's dynamic workflows**: the model writes a JavaScript orchestration script (export const meta = {...} + plain-JS body), a runtime executes it, and the script — not the conversation — holds the loop, the branching, and the intermediate results."

host 全局是 `agent / parallel / pipeline / phase / log` 五个函数加一个 `args`；护栏是 `maxConcurrentAgents` 默认 `min(16, cores-2)`、`maxTotalAgents` 1000、单次 `parallel/pipeline` 最多 4096 项；`Date.now` / `Math.random` / 无参 `new Date` 被禁（为将来的 resume 留门）。同一个引擎上还挂了第二个消费者 `tool-ralph`——脚本是编译期常量的 Ralph 循环（每轮开全新子 agent，只有一份有界的结构化 handoff 跨轮，"共享工作区就是长期记忆"）。

第 07 章讲过后发者的生态冷启动难题，Grok Build 的答案是**寄生**（原生识别 CLAUDE.md / `.claude/skills` / hooks.json 全家桶）。dsh 的答案不一样：**抄机制，但收敛到中立命名**——skill 发现的五个根目录是 `.dsh/skills` / `.agents/skills` / 自定义 / `$DSH_HOME/skills` / `~/.agents/skills`，**没有任何 `.claude/skills` 或 `.cursor/skills` 的发现路径**；指令文件候选是 `AGENTS.md` / `CLAUDE.md`（含 `.local.md` 覆盖层）。它对 Claude Code 生态的兼容集中在两个地方：hook 协议桥（明确定位成"桥"），以及把 Claude Code 本身当 subagent provider。

**结论修正**：第 17 章说"Claude Code 的配置格式正在成为 coding agent 领域的 POSIX"。加上第五个样本后，更准确的说法是——**收敛在发生，但收敛点正在从 `.claude/` 挪向中立的 `AGENTS.md` / `.agents/`**。dsh 投的是中立那一票。

### 4.5 "不做"也可以是有档案的决定

第 09 章的框架下，dsh 是第二个**没有长期记忆子系统**的样本（219 个包 / 51 个工具名 / 24 个事件族 / 46 篇子系统文档，全部零命中；全仓没有任何向量能力）。但它和 Pi 的"从没做过"不是一回事：`.agents/notes/implemented/feature/2026-07-31-third-party-memory-mcp-examples.md` 记录了这个决定和它否掉的备选：

> "A direct vendor integration made one provider's API, configuration, health behavior, and tool semantics part of DSH. That was too much product surface for a capability already expressible through MCP, and it would require repeating the same adaptation for every memory system."

连"做一个记忆 provider 预设注册表"都被明确否掉，理由是**注册表会让第三方实现看起来像官方支持的产品面**。取而代之的是 `examples/mcp-memory/` 下三个**默认关闭**的 MCP overlay 示例。内核里只剩两样东西：一份 64 KiB 硬预算、SHA-1 去重、随 `read`/`write`/`edit` 工具调用热更新的 AGENTS.md（注入形态是 durable 的 user 消息而不是 system prompt），和一套对**原始会话日志**的 SQLite FTS5 全文检索（跨会话授权是 cwd 字符串精确相等的代码级检查，索引默认 `:memory:` + `openAt: 'never'`，模型侧工具默认根本不挂）。

同一份档案纪律在遥测上给出了本系列最有价值的一条时间线：`git log -S"DSH_TELEMETRY_MODE"` 只有一个提交——**2026-08-10 的 "feat(telemetry): require explicit opt-in"**，比开源早 3 天。它删掉的注释原文是"Session telemetry, on for every dsh mode … No telemetry/record redaction rule is mounted yet, so exports are the raw captured copy."，同提交的 Agent Note 里明确否掉了"保持 opt-out、改进披露"这个方案：

> "**Keep opt-out defaults and improve disclosure.** Rejected because disclosure does not make a missing configuration a positive authorization to send data…"

**"披露不构成同意"**——这句话正好是第 15 章批评 Codex "默认开 + 零披露"的反面命题，而且它是从这家公司自己的决策记录里长出来的。

---

## 5. 账单：一切皆插件的代价

写完上面这些，必须把代价一次性列清楚，否则这一章就成了广告。

1. **插件信任模型是零。** bundle 就是 npm 包，和内置插件同级 import 进主进程，拿完整 `ctx`，无权限声明、无审批、无隔离、无签名、无校验和、无企业白名单。`dsh plugin` 只是 `spawnSync('pnpm', ...)` 的转发器，生成的 profile workspace 里连 `minimumReleaseAge` 都没有（仓库自己的 workspace 反倒是 lifecycle script deny-by-default 的完整白名单）。对照 Pi 那套 `min-release-age=2` + `--ignore-scripts` + shrinkwrap + 可复现构建的供应链加固，这是五家里最薄的一档。
2. **而且模型能自己写插件挂进正在跑的运行时。** `packages/extensions/tool-cordis` 给模型 7 个工具（`cordis_define` / `cordis_run` / `cordis_stop` / …），动态包直接求值挂载，**host 半边不经任何人批准**，能拿哪些服务只由它自己在 `inject` 里声明。仓库对此的态度是坦率的（`cordis-host-runner/README.md:32`）：node:vm 沙箱"isolates globals but is not a security boundary"，**要求把它当 bash 权限对待**。它不在任何出厂树里，是显式 opt-in——但这是"第五种答案"和"第五种风险"的同一个东西。
3. **沙箱只管文件写效果。** 三平台内核后端都真做了（还自写了 298 行 C 的 Landlock launcher），但语义显式砍到只剩"文件写"：零网络管控、零 deny-read、没有 Codex 那种 `.git/hooks` 保护子路径、没有命令危险分类器。工程量约是 Codex 的五分之一，砍掉的正是 Codex 的网络代理与 execpolicy。审批只有 `allowed-once`，**没有"总是允许"**。
4. **能力目录 ≠ 出厂配置。** `docs/tool-catalog.md` 有 52 个工具小节，但默认 profile 里模型可见的约 25 个；`terminal_*`、`lsp`、`session_*`、`schedule_*`、`cordis_*` 全都不在任何出厂 profile 里。读一篇它的文档很容易高估你 `npx` 出来的那个东西。
5. **组合的复杂度转嫁给了用户。** 想知道自己跑的是什么，得读懂 `dsh-base` 78 行 + `dsh-web-app` 78 行的 patch 层叠加。四层 patch、按 id 整体替换而非深合并——灵活性的另一面是"配置即代码"的全部维护成本。
6. **没有企业治理层。** 没有 admin policy、没有强制锁、没有远程配置。好处是没有 Grok 那种"服务端可远程打开遥测"的暗门；坏处是企业想统一管控也无从下手。
7. **它自己说了不稳定。** `AGENTS.md` 有一节 "Pre-release stance: foundation over blast radius"，明说没有外部消费者、可以随便重命名重打包、**后端拒绝旧磁盘格式**、`SESSION_FORMAT_VERSION` 停在 `0` 且**无任何兼容承诺**。README 全大写写着 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES."

---

## 6. 三条总判断

**1. "一切皆插件"这次是真的，而且它的成本比收益更值得看。**

前四个样本里，Pi 说"内件全可换"、Codex 说"一个引擎六种形态"，都需要你相信一段描述。dsh 把这件事做成了可以用 `grep` 检验的形态：循环是一行 YAML，依赖图里没人依赖它的实现，UI 跑在另一棵 cordis 树上，注册全是可回滚的 effect。**但它同时展示了这条路的账单**——为了让插件真的可插拔，它得去修上游 DI 框架的可重入销毁语义、得把 265,000 行测试压在 per-file 100% 的门禁下、得接受"任何插件都是完整信任"的安全模型。**可组合性不是免费的，它是用别的地方的严格换来的。**

**2. 后发者的生态策略出现了第二条路线：不寄生，改投中立命名。**

Grok Build 的答案是把竞品的文件约定当事实标准全盘实现（第 17 章）。dsh 的答案是：机制照抄（hook 协议桥、dynamic workflows 的 API 形状、skill 的 frontmatter 字段名），但**发现路径收敛到 `AGENTS.md` 和 `.agents/skills`**，不认 `.claude/`。同时它做了一件比兼容更彻底的事——**把竞品做成自己的 provider**（Claude Code 与 Codex 是它的 subagent 后端，Pi 的 AI 包是它的 npm 依赖）。第 17 章那句"Claude Code 的配置格式正在成为 coding agent 领域的 POSIX"要打个折：收敛确实在发生，但**收敛点正在往中立命名迁移**，而 dsh 投了关键的一票。

**3. 在"开源到底给了你什么"这个问题上，它是目前可审计性最高的一个。**

对照第 17 章给 Grok Build 拉的那份 checklist：dsh 的遥测端点**明文写在 npm 包会带上的 yml 里**（不是构建期注入）、prompt 不混淆、发行二进制不加固、git 历史完整到能看见默认值翻转的那一次提交、事故复盘公开、被否掉的方案也留档。它保留的控制权只有一样——**不收你的 PR**，而 CONTRIBUTING 对此的回应是"那就去做你自己的包，官方包并不更重要"。

但"可审计"不等于"安全"，这两件事在 dsh 身上分得特别开：**它让你能看清一切，同时不替你挡任何东西**。插件零信任门、沙箱只管文件写、模型能自己挂插件——这些都写在文档里，明明白白。**它把选择权和责任一起给了你**，这在 developer preview 阶段是诚实的，在有人拿它上生产的时候就是每个团队自己的功课了。

---

## 7. 未确认与边界说明

- **没有实跑过。** 全部结论来自静态阅读（仓库只读、未 `pnpm install`、未执行测试套件、未抓包）。"默认零外发（除模型请求）"是静态审计结论，未在运行时验证；`dsh --profile web --dump-config` 的实际输出未取得。
- **发布背景来自媒体报道**（VentureBeat、The New Stack），与 V4-Pro 同日发布、定位对标 Claude Code 等表述**属第三方来源**，未经官方逐条确认。star 数是 GitHub API 两次实测（54,107 → 59,012，均在 2026-08-14）。
- **219 个包没有逐包读完。** 15 路调查各自覆盖了自己维度的主干包与 `vendor/` 全部，其余按生成文档（`module-graph.md`、`tool-catalog.md`、`persistence-catalog.md`、`event-producer-consumer.md`）取数。这些生成物由真实 boot 产出而非 AST 静态扫描，但**未独立验证生成器是否漏收**。
- **口径说明**：事件计数有两套 taxonomy——cordis 总线事件（生成表 56 个 harness 事件，13 个 waterfall）与落日志的 session 事件（44 种，其中只有 3 种进模型可见面）。文中出现的"事件数"请对照上下文，两者不可混用。
- **各章末尾的「本节未确认」共约 60 条**，是比本节更细的边界清单，涉及具体机制的读者应当去看对应章节。
- 仓库处于 developer preview 且迭代极快（65 天 12,293 个 commit）。**本文档反映的是 2026-08-14 这一天的 `47f9438`**，npm 上当日已有更新的 `0.1.0-rc.6`，其差异未核对。

**参考来源**（发布背景，第三方）：
[VentureBeat](https://venturebeat.com/technology/deepseek-harness-launches-as-open-source-rival-to-claude-code-alongside-v4-pro-on-api-with-higher-prices) ·
[The New Stack](https://thenewstack.io/deepseek-harness-open-source-plugins/)
