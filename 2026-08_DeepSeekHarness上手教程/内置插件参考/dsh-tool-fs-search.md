# tool-fs-search

> `@deepseek-ai/dsh-tool-fs-search` · bundle：`base` · 配置树 id：`tool-fs-search` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对，出处收在文末脚注。

**一句话**：模型面前的 `glob` / `grep` 两个发现类工具，底座是**随包发布的 ripgrep 二进制**（`@vscode/ripgrep`），经 `ctx.subprocess` 起进程，**不走 `ctx.fs`**，所以文件系统 provider 不必长出一套搜索 API。

## 它在树上长什么样

配置树上是这样一段[^1]：

```yaml
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false
```

只有一个字段，而且是**必填、没有默认值**的布尔字段——`z.boolean().required()`[^2]。也就是说部署时必须显式表态：超额的 `glob` 页要怎么排。base 选了 `false`。

行内没有 `inject`，依赖只来自包自身导出的三项：`tools`、`systemPrompt`、`subprocess`——注意这里**刻意不含 `fs`**[^3]。而 `ctx.spillStore` 是机会性读取的，因为 spill 本身可选，没有也得能跑[^4]。

web profile 把这一行关掉了，改由各 agent preset 重新挂载，且三处传的字段值同样是 `false`[^5]。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 工具 | `glob` | argv 是 `--files --glob=<pattern> --sort=modified --no-ignore --hidden` 加 VCS 元目录排除，只返回文件路径[^6] |
| 工具 | `grep` | argv 是 `--json --regexp=<pattern>`（可选 `--glob=<include>`、`-- <path>`），逐行解析后按文件分组输出 `Line N: <preview>`[^7] |
| prompt 段 | `tool:glob` order 103 | 文案随 `sampleOverCapGlobResults` 二选一[^8] |
| prompt 段 | `tool:grep` order 104 | 固定文案，不随配置切换[^9] |
| 事件监听 | `tools/post-execute`（**waterfall**） | 每个工具各挂一个：先放行拿到结果，再在超额时把完整结果存进 spill 并**改写**结果内容[^10] |

没有 service，也不派发 `fs/*`。

这里有个容易想当然的地方：它和 [fs-observation-policy](./dsh-fs-observation-policy.md) 的观察记录**完全无关**。`grep` 出来的路径不算读过，想编辑仍然要先用 [tool-fs](./dsh-tool-fs.md) 的 `read` 走一遍。

那两个 `tools/post-execute` 监听器也不是见调用就动手，只对本工具、非嵌套、已 accept 且非错误的调用生效[^11]。

超额结果怎么处理，靠的正是这个 `tools/post-execute` 环节：

```mermaid
flowchart TD
    G["<b>glob / grep 调用</b><br/>ripgrep 子进程返回结果"]
    W["<b>tools/post-execute waterfall</b><br/>先 await next()"]
    CAP["<b>是否超过展示上限</b><br/>globMaxResults / grepMaxMatches"]
    SPILL["<b>存入 spill 后端</b><br/>改写结果内容，附取回提示"]
    RET["<b>原样返回</b><br/>内联展示完整结果"]

    G --> W
    W --> CAP
    CAP -- "超额" --> SPILL
    CAP -- "未超额" --> RET

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    class G entry
    class W,CAP main
    class SPILL,RET data
```

写成伪代码就是这么一段，注意先放行、后接管——它是 waterfall，先让下游把结果算完，自己再在回程上改写：

```
on tools/post-execute (waterfall):
    if 不是本工具 or 是嵌套调用 or 未 accept or 是错误:
        return next()                  // 四道闸门，任一不满足就不管
    结果 = await next()                 // 先放行，拿到完整结果
    if 结果条数 > 上限:
        存进 spill 后端
        改写结果内容：截断 + 省略计数 + 定位符 + 取回提示
    return 结果
```

两个工具都声明了 `timeoutMs`，由 `@deepseek-ai/dsh-tool-call-timeout-policy` 经 `exec.signal` 协作式执行；subprocess seam 的 terminate 升级才是硬杀[^12]。

这与 tool-fs 的"文件 IO 不设超时"形成对照——进程型工作才有可强制中断的截止时间。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `sampleOverCapGlobResults` | boolean | **必填**（base 给 `false`） | `true`=超额页按顶层条目抽样；`false`=保留按 mtime 排序的头部 |
| `globMaxResults` | number | `100` | 单次 `glob` 内联展示的路径上限[^13] |
| `grepMaxMatches` | number | `250` | 单次 `grep` 内联保留的扁平匹配上限[^14] |
| `grepMaxLineBytes` | number | `2000` | 单条匹配行预览的字节上限，切口保 UTF-8 边界[^15] |
| `searchMetaMaxBytes` | number | `65536` | 单次搜索序列化 `presentationMeta` 的字节上限[^16] |
| `rawOutputMaxBytes` | number | `20000000` | 会去解析的 `rg` 原始 stdout 上限，超了报 `SEARCH_RAW_OUTPUT_OVERFLOW`[^17] |
| `graceMs` | number | `3000` | 交给 subprocess seam 的 terminate 宽限，受 `MAX_TIMER_DELAY_MS` 约束[^18] |
| `stderrMaxBytes` | number | `65536` | `rg` stderr 诊断尾巴预算[^19] |
| `timeoutMs` | number | `30000` | 两个工具的协作式调用预算[^20] |

那个必填布尔值值得单独看一眼：两种取值下超额页的排序契约完全不同，模型看到的尾句提示也跟着换。

```mermaid
flowchart LR
    subgraph SF["sampleOverCapGlobResults: false"]
        F1["<b>保留 mtime 头部</b><br/>base 的选择，聚焦最近改动"]
    end
    subgraph ST["sampleOverCapGlobResults: true"]
        T1["<b>跨目录抽样</b><br/>按顶层条目分组，覆盖整棵树而非只盯一个子树"]
    end

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    class F1 data
    class T1 main
```

除必填项外，其余字段全部在 `apply` 装配阶段断言正整数[^21]。

## 模型看得见什么

两段 guidance 每次请求都在。`grep` 那段逐字为——

> Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.

出处见[^9]。`glob` 那段随配置切换尾句：`sampleOverCapGlobResults: false` 时结尾是 `while a larger one keeps the modification-time-ordered head.`；`true` 时是 `while a larger one is sampled across top-level entries, so it spans the tree instead of one subtree.`[^22]

结果侧长这样：

| 场景 | 模型收到的东西 |
|---|---|
| `glob` 有结果 | 一行一路径 |
| `grep` 有结果 | 按文件分组，`Line <line>: <preview>`[^23] |
| `glob` 空结果 | `No files found`[^24] |
| `grep` 空结果 | `No matches found`[^25] |
| 超额 | 尾部带省略计数、spill 定位符与取回提示，或明说完整结果没能保存 |
| 失败 | 结构化 code：`SEARCH_INVALID_PATTERN` / `SEARCH_FAILED` / `SEARCH_RAW_OUTPUT_OVERFLOW` / `SEARCH_ABORTED`[^26] |

超额这一行有个反直觉点：它**从不**变成 `isError`。截断只是展示策略，不是出错。

ripgrep 的退出码语义也由工具自己重新解释了一遍，不能照搬 shell 里的直觉[^27]：

```
rg 退出码 == 0  → 有结果，成功
rg 退出码 == 1  → 空结果，仍然算成功      // 不是失败
rg 其它退出码    → 才算失败
```

## 什么时候你会想换掉它 / 怎么换

换掉整包基本没必要——二进制随包发，注册也是无条件的。常见改法是切换超额排序契约或放宽上限：

```yaml
- id: tool-fs-search
  config:
    sampleOverCapGlobResults: true
    grepMaxMatches: 500
```

这里有个坑：patch 会**整体替换**该行的 `config`，官方文档原话是"A patch replaces whole row configs … there is no deep-merge layer"[^28]。所以 `sampleOverCapGlobResults` 必须重新写上，漏了就是 schema 校验直接失败。

想让超额结果可完整取回，就再挂一个 spill 后端——base 已经挂了一个 `spill-local`[^29]。

## 坑与边界

**搜索与文件访问没有共享工作区证明。** 返回路径显示为相对 workdir（有 session 时取其 cwd，否则回退到 `process.cwd()`）[^30]，只有 workdir 与 `ctx.fs` 根指向同一工作区时，才能用 `read` 跟读。包内不做任何跨服务运行时校验，远程 / 虚拟文件系统场景下这条会静默失效。

**二进制版本被依赖锁死。** `@vscode/ripgrep` 覆盖 macOS/Linux/Windows 的 x64/arm64；不支持的平台或安装损坏，调用一律 `SEARCH_FAILED`。

**schema 只暴露一页。** 没有 offset 分页、没有大小写开关、没有其他输出模式；完整超额输出依赖 spill 后端。

**抽样只按搜索根下第一层路径段分组。** 结果集中在更深的某个忙目录时，那一层以下仍然不均衡，递归平衡没做。

读源码另注：`--no-config` 被前置进 argv[^31]，防止宿主的 `RIPGREP_CONFIG_PATH` 往非受限 spawn 里塞 `--pre` 预处理器；模型可控值都是普通 argv 元素，没有 shell 层，所以不存在引号转义问题。

## 出处

[^1]: 配置树条目：`packages/bundle/base/cordis.patch.yml:227-230`。
[^2]: 必填、无默认值的布尔字段校验：`packages/fs/tool-fs-search/src/index.ts:98`。
[^3]: inject 声明（`tools`、`systemPrompt`、`subprocess`，不含 `fs`）：`src/index.ts:70`。
[^4]: `ctx.spillStore` 机会性读取：`src/search-core.ts:382`。
[^5]: web profile 关闭该条目：`packages/bundle/web-app/cordis.patch.yml:315-316`；三个 agent preset 各自的重新挂载点：code `apps/cli/config/agent-presets/code/agent.cordis.yml:66-69`，standard `:59-62`，cordis `:60-63`。
[^6]: `glob` 的 argv 构造：`src/glob.ts:90-108`；注册：`src/glob.ts:359`。
[^7]: `grep` 的 argv 构造与逐行解析：`src/grep.ts:112-117`；注册：`src/grep.ts:339`。
[^8]: `tool:glob` prompt 段：`src/glob.ts:301`。
[^9]: `tool:grep` prompt 段（含 guidance 原文）：`src/grep.ts:276`。
[^10]: 两个 `tools/post-execute` waterfall 监听器：`src/glob.ts:361-373`、`src/grep.ts:341-364`；事件模式定义见 `docs/event-producer-consumer.md:57`。
[^11]: 四道生效条件（本工具、非嵌套、已 accept、非错误）：`src/direct-call.ts:23-26`。
[^12]: `timeoutMs` 声明：`src/glob.ts:326`、`src/grep.ts:292`。
[^13]: `globMaxResults` 默认值：`src/glob.ts:26`。
[^14]: `grepMaxMatches` 默认值：`src/grep.ts:30`。
[^15]: `grepMaxLineBytes` 默认值：`src/grep.ts:36`。
[^16]: `searchMetaMaxBytes` 默认值：`src/search-core.ts:64`。
[^17]: `rawOutputMaxBytes` 默认值与 `SEARCH_RAW_OUTPUT_OVERFLOW`：`src/search-core.ts:35`。
[^18]: `graceMs` 默认值：`src/search-core.ts:52`；`MAX_TIMER_DELAY_MS` 校验：`src/index.ts:137-139`。
[^19]: `stderrMaxBytes` 默认值：`src/search-core.ts:49`。
[^20]: `timeoutMs` 默认值：`src/search-core.ts:42`。
[^21]: 正整数断言：`src/index.ts:131-141`。
[^22]: `glob` guidance 随配置切换的尾句：`src/glob.ts:298-305`。
[^23]: `grep` 结果分组格式：`src/grep.ts:201`。
[^24]: `glob` 空结果文案：`src/glob.ts:233`。
[^25]: `grep` 空结果文案：`src/grep.ts:230`。
[^26]: 失败 code 列表：`src/search-core.ts:78-81`。
[^27]: 退出码语义实现：`src/search-core.ts:270-274`。
[^28]: patch 整体替换 config 的说明：`packages/bundle/base/README.md:21`。
[^29]: `spill-local` 已挂载：`packages/bundle/base/cordis.patch.yml:346-347`。
[^30]: 返回路径相对规则：`src/search-core.ts:223-224`。
[^31]: `--no-config` 前置进 argv：`src/search-core.ts:228`。
