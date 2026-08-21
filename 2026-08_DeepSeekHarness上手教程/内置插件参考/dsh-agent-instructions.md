# agent-instructions

> `@deepseek-ai/dsh-agent-instructions` · bundle：`base` · 配置树 id：`agent-instructions` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对。出处收在文末脚注。

容易把这类"加载 AGENTS.md"的包想象成一个常驻服务——起来之后自己盯着目录树，文件一变就自动感知。不是的：它注册进 cordis 之后不占一个心跳、不起一个循环，从头到尾只是三个平时睡着的事件监听器，得等别人把它们叫醒。

**一句话**：按 session 加载 `AGENTS.md` 兼容文件——先把"用户全局 + 项目"的基线指令注入持久历史，之后跟着成功的文件系统工具调用发现更深目录的嵌套文件，并在变更/消失时补发通知。

## 它在树上长什么样

base bundle 里就是一行带一个配置[^1]：

```yaml
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
```

web profile 不一样，顶层这一行被明确关掉[^2]：

```yaml
- id: agent-instructions
  disabled: true
```

关掉不等于不用，它被下放进 preset 的子组合里，配置值不变[^3]：

| preset | 挂了它吗 |
|---|---|
| `standard` | 挂了 |
| `code` | 挂了 |
| `cordis` | 挂了 |
| `minimal` | 没挂 |

也就是说，web 下"哪个 agent 读 AGENTS.md"是 preset 决定的，不是全局开关。

YAML 里没有 `inject` 字段，包也没有 `static inject`：它是运行时按需去要一份可选的 `ctx.fs`，要不到就什么都不做，等某个 provider 出现再说[^4]。README 把这层用意说清楚了[^5]：

```text
The plugin does not statically inject `fs`, so providerless product trees still boot and instruction loading becomes a no-op until a provider is present.
```

## 它注册了什么

不提供任何 service，不注册工具、不注册 prompt 段——这整个包只有一个入口函数[^6]。它整个就是三个监听器：

| 类型 | 名字 | 说明 |
|---|---|---|
| 事件监听（**waterfall**） | `agent/pre-step` | 先等下游把这一步定下来，再把 workspace context 折进最终批次[^7] |
| 事件监听（emit） | `tools/result` | 只认成功的第一方 `read` / `write` / `edit`，从调用参数里取路径[^8] |
| 事件监听（emit） | `session/event` | 跟踪 `step/start` / `step/end` / `turn/end`，把 step 内产生的 touch 攒到 `step/end` 之后再投影[^9] |
| 可选伴生 | `@deepseek-ai/dsh-agent-instructions/invariant` | 包 exports 里的独立入口，base bundle 没挂[^10] |

三个里只有 waterfall 那个值得停下来看，另两个基本是"收集事件、攒起来、到点投影"的模板。

waterfall 的处理讲究在于：基线指令并不是抢着插进去的，而是等下游先定，再看有没有位置塞。

```
on agent/pre-step (waterfall):
    decision = await next()               // 先让下游把这一步定下来
    if decision 是 reject:
        基线留在 next-step inbox，等下次唤醒再说
    elif 这是第一个 step 且批次为空:
        同上，也留着不发
    else:
        移除 pending 副本
        把消息插在"最后一条被 claim 的消息之后"
```

于是最终一批消息的顺序固定成这样：直接 prompt 在前、基线在中、[agent-loop](./dsh-agent-loop.md) 追加的 runtime context 在后[^7]。

```mermaid
flowchart LR
    A["<b>claimed 批次</b><br/>直接 prompt"]
    B["<b>基线指令</b><br/>用户全局 + 项目 AGENTS.md"]
    C["<b>新增/更新/移除通知</b><br/>插在最后一条被 claim 的消息之后"]
    D["<b>runtime context 快照</b><br/>agent-loop 追加"]

    A --> B --> C --> D

    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    class A entry
    class B,C main
    class D data
```

`tools/result` 那条则是个很窄的漏斗，绝大多数工具调用都被它挡在外面：

```
on tools/result(call):
    if call.tool 不在 {read, write, edit} 里:  return   // 且必须是第一方的这三个
    if call 没成功:                             return
    把 call 参数里的 file_path 攒进本 step 的 touch 集合
```

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `maxBytes` | `number` | 必填[^11]（bundle 给 `65536`） | 一次渲染（基线或动态批）的 UTF-8 字节上限；非正或非有限值直接关掉加载 |
| `maxSourceBytes` | `number`（正整数） | `1048576`（1 MiB） | 单个指令文件读取上限，超了直接忽略该文件 |
| `dshHome` | `string` | `$DSH_HOME`，否则 `~/.dsh` | 用户全局 `AGENTS.md` 所在目录 |
| `projectRootMarkers` | `string[]` | `['.git']` | 从 session cwd 向上找项目根的标志目录项 |
| `instructionFileCandidates` | `string[]` | `['AGENTS.md', 'CLAUDE.md']` | 每个目录的基础候选，按序全部加载 |
| `localInstructionFileCandidates` | `string[]` | `['AGENTS.local.md', 'CLAUDE.local.md']` | 本地覆盖层，排在基础文件之后；空数组即禁用 |

两个候选列表不是照单全收，中间还有过滤和去重[^13]：

```
for dir in 要加载的目录:
    候选 = instructionFileCandidates + localInstructionFileCandidates   // 本地覆盖层排在后面
    for name in 候选:
        if name 是空串 / '.' / '..' / 含 '/' 或 '\':   丢掉，必须是同目录文件名
        if 文件超过 maxSourceBytes:                    忽略这个文件
        if 去掉首尾空白后与同目录中更早的候选逐字节相同: 塌缩到最早那个，不再渲染一遍
```

最后一条的实际效果是：内容重复的 `CLAUDE.md` 不会和 `AGENTS.md` 各渲染一遍。

`maxBytes` 被设计成必填，README 给出的理由是"让每个部署显式做出自己的 prompt 预算选择"[^12]。

## 模型看得见什么

这个插件产出的**全部**是模型可见文本，且它自己拥有完整的 `<system-reminder>` 框[^14]。基线模板长这样[^15]：

```markdown
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: ~/.dsh/AGENTS.md

<user-global-instructions>

Instructions from: AGENTS.md

<project-instructions>
</system-reminder>
```

一份指令文件在会话里经历的状态迁移，全部由成功的 fs 工具调用驱动：

```mermaid
stateDiagram-v2
    [*] --> Discovered: 成功的read/write/edit命中新目录
    Discovered --> Loaded: 首次渲染进批次
    Loaded --> Updated: 内容变化后再次touch
    Updated --> Loaded: 更新通知发出
    Loaded --> Removed: 文件消失或塌缩为重复项
    Removed --> [*]
```

迁移到哪一格，模型收到的文本就不一样：

| 情形 | 发出的文本 |
|---|---|
| 新发现更深目录的文件 | `Additional instructions from: <path>` |
| 同一文件内容改了 | `Updated instructions from: <path>` |
| 文件消失，或变成同目录内更早候选的重复项 | `Instructions removed: <path>`，完整块见下[^16] |

移除通知的完整样子：

```markdown
<system-reminder>
Instructions removed: packages/app/AGENTS.md

The previously loaded instructions from this file no longer apply.
</system-reminder>
```

指令内容里出现的字面 `</system-reminder>` 会被转义，仓库里的文本关不掉这个框[^17]。

模型可见文本中**没有**隐藏状态标记：状态放在消息的 `agent-instructions` 结构化 source 里，字段有 action、scope、path，外加一个可选的 digest，再加上基线自己的 `baselineIdentity`[^18]。

token 上也没有反复开销：基线只追加一次并一直留到 compaction，新增内容都是 append-only，不打断已有 KV cache[^19]。

## 什么时候你会想换掉它 / 怎么换

- 想调预算 → patch `maxBytes`；想彻底关掉加载，给它一个非正数，或者标记 `disabled: true`。
- 想换文件名约定 → 改 `instructionFileCandidates`；比如只认 `AGENTS.md`，候选列表就只写这一项。
- 想按 agent 决定谁读指令 → 照 web profile 的做法：顶层关掉，挂进 preset 组合。

它没有替代 provider 的概念——不提供 service，别的插件也不依赖它。

## 坑与边界

以下六条边界，源头是同一份 README 的已知限制小节[^20]：

- **发现依赖结构化 fs 工具，不认 shell 导航**——`bash` 里 `cd` 到子目录不会触发嵌套指令发现，因为每次 bash 调用都是新 shell，解析任意 shell 语法不可靠。
- **刷新是 touch 驱动的**——没有文件监听器；外部改动要等下一次成功的 `read`/`write`/`edit`、resume 时的基线对账，或者某次 pre-step 恢复被 compaction 遮蔽的基线。
- **候选语义刻意做小**——小写文件名、`.claude/rules/`、`@path` 导入都不解释；用户全局 `$DSH_HOME` 那一层还没有 local 覆盖层。
- **同目录去重是按内容的**——只有去掉首尾空白后逐字节相同才塌缩；已经漂移的真实副本会和 `AGENTS.md` 一起完整加载。
- **符号链接会被跟随，跨越信任边界**——候选文件最后一段是符号链接时会解析并加载目标内容，克隆来的仓库能借此把仓外文件当作低权限 workspace 指引暴露出来（它永远不覆盖 system / developer / 直接用户指令）。加载不可信仓库时应当用文件系统策略网关或 OS 沙箱约束 `ctx.fs`。
- **内容是被截断的，不是被摘要的**——超预算的宽泛文件整份丢弃，最具体的那份可能被截断，插件绝不叫模型去压缩指令散文。

## 把这些串起来

回头看，整篇的骨架就三层：

- 它**不是常驻服务**——三个监听器平时都在睡觉，是成功的 `read`/`write`/`edit` 把它们叫醒的，这也是为什么 `bash` 里 `cd` 到子目录不会触发任何发现；
- 它**只加基线一次，之后全靠增量**——waterfall 把基线塞进最外层批次一次，后面的新增/更新/移除都是单独的 `<system-reminder>` 块，token 不会因为会话变长而重复膨胀；
- 它**宁可整份丢弃，也不摘要**——`maxBytes` 和 `maxSourceBytes` 卡的是硬上限，超了就砍文件，不会让模型替你去压缩指令原文。

真要收紧或放开它，回到「配置项」那张表——六个字段管的就是这三层各自的边界。

---

## 出处

[^1]: `packages/bundle/base/cordis.patch.yml:232`。
[^2]: `packages/bundle/web-app/cordis.patch.yml:401`。
[^3]: `apps/cli/config/agent-presets/standard/agent.cordis.yml:30`（standard）、`:37`（code）、`:31`（cordis）。
[^4]: 具体调用是 `ctx.get('fs')`，见 `src/index.ts:116`。
[^5]: `README.md:13`。
[^6]: 这个入口函数就是 `export function apply`，见 `src/index.ts:80`。
[^7]: 声明在 `src/index.ts:322`；整段处理逻辑在 `:326`–`:347`，其中第一个 step 且批次为空的分支在 `:333`，移除 pending 副本在 `:339`，插入位置在 `:345`–`:346`。
[^8]: 声明在 `src/index.ts:350`；只认第一方 `read` / `write` / `edit` 的判定在 `:70`；从 `file_path` 参数取路径在 `:75`–`:76`。
[^9]: 声明在 `src/index.ts:305`；跟踪 `step/start` / `step/end` / `turn/end` 三个类型分别在 `:306`、`:310`、`:314`。
[^10]: `package.json` 的 `exports` 字段。
[^11]: schema 里写的是 `z.number().required()`，在 `src/config.ts:42`；默认值 `65536` 见文首配置块。
[^12]: `README.md:70`。
[^13]: 默认值在 `src/config.ts:11`–`:14`；schema 定义在 `:39`–`:46`；三个被过滤的保留段定义为 `RESERVED_PATH_SEGMENTS = 空串、'.'、'..'`，在 `:15`；过滤与去重逻辑在 `:119`–`:123`。
[^14]: `README.md:47`。
[^15]: `README.md:91`–`:101`。
[^16]: `README.md:147`–`:151`。
[^17]: `README.md:45`。
[^18]: `README.md:51`。
[^19]: `README.md:106`、`:136`。
[^20]: `README.md:164`–`:169`。
