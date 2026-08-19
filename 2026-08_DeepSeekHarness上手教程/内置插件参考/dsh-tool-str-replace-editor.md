# tool-str-replace-editor

> `@deepseek-ai/dsh-tool-str-replace-editor` · bundle：`base` · 配置树 id：`tool-str-replace-editor` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：把 `view` / `create` / `str_replace` / `insert` 四个命令塞进**一个**名叫 `str_replace_editor` 的工具，跑在 `ctx.fs` 之上——与 [tool-fs](./dsh-tool-fs.md) 的四工具方案并行存在的另一套模型接口，共用同一套 `fs/*` 事件与沙箱策略。

换句话说，这不是 tool-fs 的替代升级版，是同一件事的另一种摆法：一个工具四个命令，还是四个工具各一个职责。

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:384-387`：

```yaml
- id: tool-str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
  config:
    maxOutputChars: 16000
```

行内无 `inject`；包自身导出 `inject = ['tools', 'fs']`。注意这里**没有 `systemPrompt`**——它不贡献任何 prompt 段。出处 `packages/fs/tool-str-replace-editor/src/index.ts:494`。

谁挂它、谁不挂它：

| 位置 | 状态 | 说明 |
|---|---|---|
| base bundle | 挂着 | 与 tool-fs 并存 |
| web profile | 关掉 | `packages/bundle/web-app/cordis.patch.yml:318-319` |
| minimal preset | 真正用起来的地方 | 开一个 `isolate: { fs: true }` 的 group，用裸 `fs-local` 遮蔽 host 的沙箱 provider，再在同一 realm 里挂这个编辑器（`apps/cli/config/agent-presets/minimal/agent.cordis.yml:48-62`） |
| code / standard / cordis preset | 都不挂 | 改用 tool-fs |

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 工具 | `str_replace_editor` | 单工具四命令，路径必须绝对（`src/index.ts:422`、`src/index.ts:94-96`） |
| 事件派发 | `fs/write-intent`（**waterfall**） | 只在 `create` 分支，默认 thunk 返回 `{ kind: 'createIfAbsent' }`（`src/index.ts:252-257`） |
| 事件派发 | `fs/edit-intent`（**waterfall**） | `str_replace` 与 `insert` 各一次，默认 thunk 返回 `undefined`（`src/index.ts:284`、`src/index.ts:337`） |
| 事件派发 | `fs/observed`（emit） | `view`/`str_replace`/`insert` 命中缺失都记 `{ kind: 'absent' }`（共用 `statExisting`，`src/index.ts:100-113`，emit 在 `:108`），读到/改完记 `{ kind: 'present', version }`（`src/index.ts:235`、`:270`、`:321`、`:363`） |

无 service，无 prompt 段。这两个 waterfall 的唯一决策者是 [fs-observation-policy](./dsh-fs-observation-policy.md)；策略不在时落到默认 thunk。

### 写路径为什么没挂策略也仍然是 CAS

与 tool-fs 的一个实现差异值得记：`str_replace` / `insert` 拿到 intent 后并不调 `ctx.fs.editText`，而是自己读全文、算好新内容再调 `writeText`。

```
version_now = stat(path).version        // 顺手记下刚看到的版本
intent      = 派发 fs/edit-intent       // 有策略插件就由它给，没有就是 undefined
old         = readText(path)
new         = 在 old 上做替换/插入
writeText(path, new, guard = intent?.version ?? version_now)
```

一句话点破：guard 用 intent 里的 version，**intent 为 undefined 时退回刚 stat 到的 version**——也就是说即使没挂策略插件，它仍然做一次 CAS。出处 `src/index.ts:312-314`、`:354-356`。

`create` / `str_replace` / `insert` 三条写路径都要先过一次 waterfall，`fs-observation-policy` 插件在不在场直接决定 intent 是谁给的：

```mermaid
flowchart TD
    A["<b>write/edit 命令进来</b><br/>create、str_replace 或 insert"]
    B{"<b>派发 fs/write-intent 或 fs/edit-intent</b><br/>waterfall 事件"}
    C["<b>fs-observation-policy 已挂载</b><br/>策略插件决定 intent 内容"]
    D["<b>没有策略插件</b><br/>落到默认 thunk"]
    E["<b>create 默认 intent</b><br/>createIfAbsent"]
    F["<b>str_replace / insert 默认 intent</b><br/>undefined"]
    G["<b>CAS 写入</b><br/>guard 用 intent 里的 version"]
    H["<b>intent 为 undefined 时</b><br/>guard 退回刚 stat 到的 version"]

    A --> B
    B -- "有策略" --> C --> G
    B -- "无策略" --> D
    D -- "create" --> E --> G
    D -- "str_replace/insert" --> F --> H --> G

    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    class A entry
    class B,C,D main
    class E,F,G,H data
```

### 沙箱侧

沙箱由内部 `MutationPolicy` 处理，构造时就有一道硬检查：

```
if ctx.fs.sandboxMode !== undefined 且 拿不到 ctx.sandboxPolicy:
    throw 'tool-str-replace-editor: the mounted filesystem confines but ctx.sandboxPolicy is missing'
```

拒绝错误被映射成 `sandboxDenialMarker(mode)`。注意它**不追加**升级提示，也**不注册** `sandbox_permissions` 参数——这点与 tool-fs 不同。出处 `src/index.ts:70-72`（构造检查）、`src/index.ts:81-85`（拒绝映射）。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `maxOutputChars` | number | `16000` | 文件视图与目录视图保留的前缀字符数，超出追加固定 clipping 提示（`src/index.ts:506`、提示文本在 `src/index.ts:17`） |
| `description` | string | 内置编辑器指南 | 模型可见的工具描述（`src/index.ts:19-30`、`src/index.ts:507`） |

`apply` 校验 `maxOutputChars` 为正安全整数、`description` 非空（`src/index.ts:516-521`）。base 显式写了 `16000`，与默认值相同。

## 模型看得见什么

README 的 Model Experience 一节写明：模型只看到生成的 `str_replace_editor` schema（含配置里的 `description`），**插件不贡献独立的 system-prompt 段**（`packages/fs/tool-str-replace-editor/README.md:24`）；源码侧也确实没有任何 `ctx.systemPrompt.section` 调用。

默认 description 开头逐字为：

> Custom editing tool for viewing, creating and editing files

四个命令各自的返回与调用卡片：

| 命令 | 返回 | 调用卡片 |
|---|---|---|
| `view`（文件） | 带 6 位右对齐行号的文本（`:180`） | generic read |
| `view`（目录） | 两层深的目录清单，过滤掉 `.` 开头项、`node_modules`、`__pycache__`（`:194-197`） | generic read |
| `create` | `New file created successfully at: <path>`（`:271`） | diff |
| `str_replace` | `The file <path> has been edited successfully.`（`:322`） | diff |
| `insert` | 同上（`:364`） | generic edit |

超长视图保留前缀并追加 `<response clipped>` 提示。卡片类型的出处是 `src/index.ts:372-417`。

## 什么时候你会想换掉它 / 怎么换

它与 tool-fs 是**互斥的风格选择**，不是层级关系：想要单工具多命令的编辑器就留它、关 tool-fs；想要 `read`/`write`/`edit` 分开的接口就反过来。base 两个都挂着，取舍留给 profile 与 preset。

只想改文案或视图长度：

```yaml
- id: tool-str-replace-editor
  config:
    maxOutputChars: 32000
    description: |
      <你自己的编辑器指南>
```

这里有个坑：patch 会整体替换该行 `config`，两个字段要一起写全（`packages/bundle/base/README.md:21`）。

关掉它：

```yaml
- id: tool-str-replace-editor
  disabled: true
```

## 坑与边界

只处理 UTF-8 文本，二进制不支持。

`str_replace` 故意拒绝零匹配与多匹配，且**没有** `replace_all` 参数。多匹配时报错里会列出所有命中行号（`src/index.ts:300-306`）：

```
hits = 在全文中找 old_str 的所有出现
if len(hits) == 0:  报错「没找到」
if len(hits) > 1:   报错，并把每一处的行号都列出来
否则               替换这唯一的一处
```

路径必须绝对，相对路径直接被拒并提示 `Maybe you meant /<path>?`（`src/index.ts:94-96`）。

每次变更都过 `fs/write-intent` 或 `fs/edit-intent`，解析当前 session 的沙箱策略，把强制执行委托给挂载的 filesystem 与策略插件——本包自己不判权限。

`view` 的目录分支用 `ctx.fs.listDir` 逐目录递归两层（`src/index.ts:185-214`）：

```
list(dir, depth):
    entries = ctx.fs.listDir(dir)     // 一个目录一次 provider 调用，串行
    for e in entries:
        收进清单
        if e 是目录 且 depth < 2:
            list(e, depth + 1)
```

没有条目数上限，只有输出字符上限；工具定义未声明 `timeoutMs`，取消只靠传下去的 `exec.signal`。目录多的时候这条串行链是唯一的等待来源。

## 未确认

- ⚠️ `create` 分支先 `stat` 判存在再走 `fs/write-intent`（`src/index.ts:249`），与 tool-fs 的"零 stat"路径不同；这多出的一次 stat 与后续 `createIfAbsent` 之间的窗口如何表现，未实机验证，只能从代码推断由 provider 的 no-replace 发布兜底。
