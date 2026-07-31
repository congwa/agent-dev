# Codex 记忆系统调研报告

调研对象：OpenAI 开源 Codex（`github.com/openai/codex`，CLI / 桌面应用 / 云端 Agent，官方文档 `developers.openai.com/codex`）中的 **Memories（记忆）** 功能。

> 说明：Memories 是 2025 年底~2026 年初逐步推出的功能，**目前仍处于渐进发布/部分实验阶段**（如 Chronicle 子功能标注为 "research preview"）。以下内容以官方文档（`developers.openai.com/codex/memories`）和官方仓库（`codex-rs/memories/README.md`）为主要依据；部分第三方技术博客给出的更细节的实现参数（如具体的空闲小时数阈值、`/m_update` 等命令名）**未能在官方一手资料中交叉确认**，已在文中单独标注为"第三方来源、未经官方确认"，请谨慎采信。

---

## 一、总体架构：两层记忆模型

Codex 实际上是"静态规则文件 + 动态生成记忆"的两层设计：

| 层 | 载体 | 生成方式 | 存储/共享 | 定位 |
|---|---|---|---|---|
| 第一层 | `AGENTS.md`（及 `AGENTS.override.md`） | 人工编写 | 项目内、可提交到版本控制、团队共享 | **权威规则来源**，必须遵守的指令 |
| 第二层 | `Memories`（`~/.codex/memories/` 下的文件） | Codex 自动后台生成 | 本地机器，默认不同步、不共享 | **辅助性的"本地回忆层"**，帮助 Codex 记住偏好、技术栈、以往上下文 |

官方文档明确要求：必须遵循的团队规范应放在 `AGENTS.md` 或已入库的文档中，"把 memories 当作有用的本地回忆层，而不是唯一的规则来源"（AGENTS.md 优先于记忆）。

---

## 二、记忆是如何写入的

### 1. 触发条件（Codex 仓库 `codex-rs/memories/README.md` 描述的实现）

写入采用**两阶段流水线**：

- **Phase 1（单会话/thread 提取）**：在满足以下条件时才会对某个历史会话（rollout）进行提取：
  - 记忆功能已在配置中开启（`features.memories = true`）；
  - 当前会话为非临时会话、非子代理会话；
  - 状态数据库可用；
  - 该会话已"陈旧"（自上次提取后有更新）且**已空闲足够长时间**（避免总结仍在进行中的工作）；
  - 未被其他 Phase-1 worker 同时占用（通过状态库的 lease/claim 机制防止重复处理）；
  - 未超出速率限制阈值——**当 API 配额接近限制时会跳过后台生成**，避免抢占用户的正常请求配额。
  
  Phase 1 用轻量模型并行处理原始会话记录，产出结构化的 `raw_memory`（详细记录）与 `rollout_summary`（紧凑摘要）。

- **Phase 2（全局合并）**：周期性地把各会话的 Phase-1 输出合并进全局记忆文件，通过数据库锁保证**同一 `codex_home` 下同一时间只有一个合并任务**在跑；合并时会按 `usage_count`（记忆被引用/使用的次数）和最近使用时间排序，优先保留常用、丢弃长期未被引用的内容。

### 2. 写入前的处理：秘密脱敏

在记忆写入磁盘之前，Codex 会对生成的记忆字段执行**内置清理**，自动从中删除 API key、token、密码等明显的秘密信息（例如可以保留"项目使用 AWS"这类事实性描述，但不落盘具体密钥）。官方文档同时提醒用户：在把 Codex 主目录（`~/.codex`）共享给他人前，应自行审查记忆文件。

### 3. Chronicle 扩展（研究预览）

`Chronicle` 是 Memories 的一个扩展子功能，会基于**实时屏幕内容**自动生成记忆（减少用户重复描述上下文的负担），截图临时存放在 `$TMPDIR/chronicle/screen_recording/`，生成结果存放在 `~/.codex/memories_extensions/chronicle/`，以未加密 Markdown 文件形式保存。**官方明确提示该功能存在 prompt injection 风险**——因为屏幕内容可能被恶意页面/文本注入指令，进而被"记住"。

### 4. 存储位置与文件

记忆统一存储在 `~/.codex/memories/`（或 `CODEX_HOME` 指向的目录），关键文件/目录包括：

- `MEMORY.md`：可搜索的聚合事实/见解注册表；
- `memory_summary.md`：注入到每次对话开头的高层摘要（有 token 上限）；
- `raw_memories.md`：Phase-1 输出的临时合并文本；
- `rollout_summaries/`：按会话保存的摘要与支撑证据；
- `skills/`：可复用的操作/脚本片段；
- 该目录本身以 Git 作为本地基线（`.git`），便于差异对比与追踪变更（`phase2_workspace_diff.md` 即为一次合并产生的类 git diff）。

---

## 三、写入/使用策略要点

- **默认关闭**：Memories 默认关闭，需要在 Codex 应用设置里手动开启，或在 `~/.codex/config.toml` 的 `[features]` 表中设置 `memories = true`。
- **地域限制**：官方声明在**欧洲经济区（EEA）、英国、瑞士**暂不提供该功能。
- **工作目录感知**：记忆文件会带有工作目录上下文，Codex 启动时会结合当前工作目录挑选相关记忆，天然实现了一定程度的"项目隔离"（但并非严格的多项目沙箱）。
- **CI/自动化场景**：`codex exec` 默认也会加载记忆；如果需要确定性、可复现的行为（比如 CI 流水线），可用类似 `--no-project-doc` 的参数跳过记忆/项目文档加载。
- **社区提出但尚未实现的策略**（来自 GitHub Discussion，属于设计讨论/Feature Request，非已上线功能）：分层作用域（账户级/项目级/会话级）、访问频率衰减、语义向量+BM25混合检索、显式引用溯源、"符号级"记忆（跟踪具体函数/变量）等，这些目前更多是路线图层面的构想，需要留意与"已实现"功能区分。

---

## 四、如何使用（读取）这个记忆

- **上下文注入**：每次会话启动时，Codex 会把 `memory_summary.md` 之类的摘要读入模型的开发者指令（developer instructions）中，通常有 token 数量上限，超出会做截断处理。
- **按需检索**：当摘要信息不足以回答具体问题时，代理可以对更详细的 `MEMORY.md`（及相关文件）做进一步检索/grep，而不是把全部记忆都塞进上下文。
- **`/memories` 斜杠命令**：用于在当前会话中控制记忆行为——是否使用已有记忆、是否为本次会话生成新记忆。
- **使用统计回流**：读路径会做"citation parsing"和"read-usage telemetry classification"，即记录某条记忆在回答中是否被引用/使用，这个使用频率数据会反过来影响 Phase-2 合并时对记忆的保留/淘汰排序。

---

## 五、正确性保证与防止"记忆污染"的机制

### 官方已实现/明确说明的机制

1. **权威来源分层**：`AGENTS.md`/已入库文档 > 自动生成的 Memories。官方与社区回复（GitHub Discussion #24717）都强调："如果记忆与代码库文档冲突，已检入的源码/文档应该优先"，关键行为规范不应依赖记忆存储。
2. **秘密脱敏**：写入前对生成内容做敏感信息清理，降低泄露风险（但官方文档未公开具体的正则/启发式规则，属于"黑盒"过滤）。
3. **空闲/非活跃触发**：只在会话空闲足够久之后才提取，避免把"进行中、尚未定论"的推理过程当作事实记住，减少污染源头。
4. **速率限制感知**：配额紧张时跳过后台生成，防止资源竞争引发的异常/半成品写入。
5. **本地可审查、可编辑**：记忆以明文 Markdown 存放在本地文件系统，用户可以直接打开、修改、删除这些文件；`~/.codex/memories` 甚至有本地 Git 基线，理论上可以做版本回溯。
6. **全局/单会话开关**：可以通过配置整体关闭记忆使用（如社区提到的 `use_memories = false`），或用 `/memories` 命令针对单个会话临时禁用，相当于提供了"干净会话"模式来规避已污染的记忆。
7. **Chronicle 的显式风险提示**：官方针对"读屏幕生成记忆"这种更容易被注入的场景，明确标注了 prompt injection 风险，并限定为研究预览、建议用户只读/删除、不要手动往里加内容。

### 目前的缺口与已知问题

1. **没有官方的"单条记忆"管理面板**：无法在 UI 中像管理聊天记忆一样，逐条勾选删除/修正某条记忆，目前推荐做法是"最后手段"——直接手动编辑或删除本地 Markdown 文件。
2. **不可跨机器同步、不可团队共享**：意味着记忆的"污染"或"过时"只影响单机，但也无法团队协同纠错，纠错责任完全落在用户自己身上。
3. **行为不稳定的已知 issue**：例如有用户报告"代理会忽略已有记忆，除非显式要求它去读"（GitHub issue #18738），也有环境相关的 bug，如 Windows 远程连接场景下记忆未被正确注入（issue #22187），说明当前实现在**可靠性和可预期性**上还不成熟。
4. **秘密过滤规则不透明**：官方只说"会脱敏"，没有公开具体规则，用户难以自行评估其覆盖率，仍建议在共享 `~/.codex` 目录前人工复查。
5. **地域/功能仍在演进**：EEA/UK/瑞士暂不可用，云端 Codex（非本地 CLI）的记忆机制细节官方尚未完整公开，说明该系统本身仍在快速迭代中，当前文档描述的行为未来可能变化。

### 第三方博客提到、但未经官方一手资料确认的"更细"机制（谨慎参考）

部分技术博客（如 mem0.ai、"Codex CLI Memory Internals"等第三方文章）给出了更具体的说法，例如：默认 6 小时空闲阈值才会触发合并；未使用 30 天的记忆会被回收剪除；存在 `/m_update`、`/m_drop`、`codex debug clear-memories` 等专用命令；差异化的"智能遗忘"（新事实覆盖旧事实）逻辑等。这些描述与仓库 README 中"按 `max_unused_days`、`usage_count` 裁剪"的机制大方向一致，但具体参数、命令名并未在官方文档或仓库 README 中被直接确认，建议以实际安装的 Codex 版本行为为准，不要直接当作官方承诺的功能。

---

## 六、结论与实用建议

1. **把 Memories 当"锦上添花"，不要当"唯一真相"**：真正需要严格遵守的项目规则，一律写进 `AGENTS.md` 并纳入版本控制；Memories 更适合用来记住用户偏好、常用工作流、技术栈这类"软信息"。
2. **定期人工审查 `~/.codex/memories/` 目录**：目前没有成熟的自动纠错/审核 UI，发现错误或过时记忆时，最直接的办法就是手动编辑或删除对应 Markdown 文件（必要时可整体关闭功能或按会话临时禁用）。
3. **共享/协作场景要格外小心**：不要在未审查的情况下把 `~/.codex` 目录整体分享给他人或提交到仓库，秘密脱敏机制目前不透明，不能完全依赖它做安全兜底。
4. **CI / 自动化流水线建议关闭记忆注入**（如加 `--no-project-doc` 之类参数），以保证行为的确定性、可复现性，避免"记忆"这种非确定性上下文影响构建结果。
5. **关注版本更新**：这是一个仍在快速演进、部分地区未开放、部分子功能（Chronicle）仍属研究预览的年轻系统，建议以官方文档 `developers.openai.com/codex/memories` 和仓库 `codex-rs/memories/README.md` 的最新版本为准，第三方文章仅作补充参考。

---

## 参考来源

- [Memories | Codex 官方文档](https://developers.openai.com/codex/memories)
- [Configuration Reference | Codex 官方文档](https://developers.openai.com/codex/config-reference)
- [Chronicle | Codex 官方文档](https://learn.chatgpt.com/docs/customization/chronicle)
- [codex-rs/memories/README.md · openai/codex](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)
- [Memories in Codex · Discussion #12567 · openai/codex](https://github.com/openai/codex/discussions/12567)
- [what is the recommended way to handle outdated or incorrect memories · Discussion #24717 · openai/codex](https://github.com/openai/codex/discussions/24717)
- [Add Memory bank feature similar to cline memory bank · Issue #4655 · openai/codex](https://github.com/openai/codex/issues/4655)
- [Long-term Memory · Issue #8368 · openai/codex](https://github.com/openai/codex/issues/8368)
- [Memory apparently ignored by Codex until specifically asked to read it · Issue #18738 · openai/codex](https://github.com/openai/codex/issues/18738)
- [Codex Windows App via Remote Connections does not inject memories · Issue #22187 · openai/codex](https://github.com/openai/codex/issues/22187)
- [Codex CLI Memory: How It Works + What Mem0 Adds (第三方，部分细节未经官方确认)](https://mem0.ai/blog/how-memory-works-in-codex-cli)
- [Codex CLI Memory Internals: Pipelines, Secret Sanitisation and Intelligent Forgetting (第三方，部分细节未经官方确认)](https://codex.danielvaughan.com/2026/04/08/codex-cli-memory-internals/)
