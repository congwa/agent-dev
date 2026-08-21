# fs-sandbox

> `@deepseek-ai/dsh-fs-sandbox` · bundle：`base` · 配置树 id：`fs-sandbox` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对，出处收在文末脚注。

**一句话**：会拦截的 `ctx.fs` 实现——它继承 `LocalFileSystem` 的全部文本存储机制，只在 `writeText` / `editText` 上加一道按调用解析的模式围栏；读永远放行，因为每种模式都允许读。

## 它在树上长什么样

配置树上就两行：

```yaml
# The sandboxed filesystem provider. `cwd` defaults to `process.cwd()`; an
# overlay can pin another workspace.
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
```

没有 `config`，所以 `cwd` 与 `diffBasisMaxBytes` 全取 fs-local 的默认值；行内也没有 `inject`，依赖是写在类上的 `static inject = ['sandboxPolicy']`[^1]。

三个 bundle 里只有 base 有这一行[^2]，web-app 与 headless 都没有覆盖它。

它与 base 里的 `sandbox-policy` 行配套：`mode` 取 `DSH_PERMISSION_MODE`，环境变量未设时落到 `'workspace-write'`；`workspaceRoot` 取 `process.cwd()`[^3]。

**装它而不是 `dsh-fs-local`，再配一个 `ctx.sandboxPolicy`，整个替换就完成了**——模型侧工具一行不用改。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.fs` | `SandboxedFileSystem extends LocalFileSystem`[^4] |
| 覆写方法 | `writeText` | 先过围栏再委托继承的原子写；**policy 不再往下传**，围栏只在本层[^5] |
| 覆写方法 | `editText` | 同上[^6] |
| 覆写属性 | `sandboxMode` | 暴露部署默认模式（构造时从 `ctx.sandboxPolicy.defaultMode` 取[^7]）；这是工具层判断"要不要广告升级参数"的能力事实[^8] |

没有事件监听，没有工具，没有 prompt 段。

它与 [fs-observation-policy](./dsh-fs-observation-policy.md) 正交：一个管"能不能写到这个位置"，一个管"读过没读过"，两者叠加生效。

### 围栏本身

围栏本体是 `checkedTarget`。一次写调用从模式来源到最终放行/拒绝的路径画出来是这样：

```mermaid
flowchart TD
    A["<b>sandboxPolicy.defaultMode</b><br/>构造时读取,暴露为 sandboxMode"]
    B["<b>writeText / editText</b><br/>模型发起的写入调用"]
    C["<b>checkedTarget(mode)</b><br/>按当前会话模式判定"]
    D["<b>danger-full-access</b><br/>原样返回 target,不设防"]
    E["<b>read-only</b><br/>抛 FS_SANDBOX_DENIED"]
    F["<b>workspace-write</b><br/>重新 canonicalize 路径"]
    G["<b>writableRoots(policy)</b><br/>与 Seatbelt profile 共用"]
    H["<b>不在可写根之下</b><br/>抛 FS_SANDBOX_DENIED"]
    I["<b>放行新 target</b><br/>交给下游原子写"]

    A --> C
    B --> C
    C -- "danger-full-access" --> D
    C -- "read-only" --> E
    C -- "workspace-write" --> F
    F --> G
    G -- "命中可写根" --> I
    G -- "未命中" --> H

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class A,B entry
    class C,F main
    class D,G,I data
    class E,H danger
```

写成伪代码只有三个分支：

```
函数 checkedTarget(target, mode):
    若 mode == danger-full-access:  返回 target            // 原样返回，不设防
    若 mode == read-only:           抛 FS_SANDBOX_DENIED
    // 剩下的就是 workspace-write
    新 target = canonicalize(target)                       // 临写前当场重解析
    若 新 target 落在 writableRoots(policy) 的某个根之下:
        返回 新 target                                     // 下游用的是这个新的
    否则:                            抛 FS_SANDBOX_DENIED
```

注意最后一步：**返回的是重新解析出来的 target，下游变更用的就是它**，避免"检查这个、写那个"的错位[^9]。

| 模式 | 行为 |
|---|---|
| `danger-full-access` | 原样返回 target，不设防 |
| `read-only` | 一切变更抛 `FS_SANDBOX_DENIED`，消息 `cannot write "<path>": file access denied under read-only mode` |
| `workspace-write` | **当场重新 canonicalize**，要求落在某个可写根之下，并把这个新鲜 target 交给下游变更；不满足则抛同样 code、消息 `… under workspace-write mode` |

可写根来自 `writableRoots(policy)`：`workspace-write` 时是 workspace 根加 `/tmp` 加 `os.tmpdir()` 去重后的规范化列表——**与 Seatbelt profile 用的是同一个函数**，所以 fs 围栏和 bash runner 不会漂移[^10]。

包含判定 `isPathUnder` 先走词法快路径，再退回基于 inode 身份的祖先回退，认得 Windows 长名/8.3 名这类别名等价根[^11]。

## 配置项

配置就是 fs-local 的配置原样照搬：`export type Config = LocalConfig`[^12]。

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `cwd` | string | `process.cwd()` | 相对路径解析基准，**不是**围栏边界[^13] |
| `diffBasisMaxBytes` | number | `10485760`（10 MiB） | 覆写场景可选 contextual diff 基准的每侧字节上限[^14] |

沙箱默认值（模式 + `workspace-write` 的兜底根）**不在这里**——每次调用由 `ctx.sandboxPolicy` 按 session 解析[^15]。

## 模型看得见什么

它自己不产生模型可见文本。

README 的 Model Experience 一节说得很明确：策略持有方贡献能力中立的 `sandbox:policy` 上下文；间接地，[tool-fs](./dsh-tool-fs.md) 把本后端抛出的 `FS_SANDBOX_DENIED` 渲染成 `[sandbox: file access denied under <mode> mode]` marker 加同轮升级提示。

拒绝之所以是结构化 `FsError` 而不是靠 stderr 文本推断（bash 的内核拒绝要那么干），是因为进程内围栏清楚知道自己拒了什么。

[tool-str-replace-editor](./dsh-tool-str-replace-editor.md) 走的是同一条路：它的 `MutationPolicy` 在 `ctx.fs.sandboxMode !== undefined` 时必须拿到 `ctx.sandboxPolicy`，否则装载即报错。

## 什么时候你会想换掉它 / 怎么换

想要完全不设防的本地文件系统（比如某个 preset 内部自建 realm），用 `fs-local` 顶替。minimal preset 就是这么做的：开一个 `isolate: { fs: true }` 的 group，在里面挂裸 `fs-local` 遮蔽 host 的这一份[^16]。

```yaml
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-local'
```

要改的是**这一行的 name**，不要另外再插一行 `fs-local`——两个 provider 会重复注册 `ctx.fs` 并让加载失败[^17]。

其余两种换法：

| 你想要 | 怎么做 |
|---|---|
| 换工作区根 | 改 `sandbox-policy` 行的 `workspaceRoot`，**不要**改这里的 `cwd`（那只是解析默认值） |
| 把文件状态挪到远端执行世界 | 换 `@deepseek-ai/dsh-fs-e2b`[^18] |

## 坑与边界

**这是策略围栏，不是内核边界。** 检查发生在受信代码里、针对模型可控的路径。resolve 到 syscall 之间的残余 TOCTOU 被"临写前重新 canonicalize"收窄但没有消除，敌意宿主进程不在威胁模型内。不可信**代码**的内核级隔离仍归 `ctx.shell`（`dsh-bash-sandbox`）。

**围栏与 runner 的一致性靠单一来源。** 可写集合来自 `writableRoots`，与 Seatbelt profile 共享；哪天有个 runner profile 自己另定义可写集，两边就会漂移。

**`ctx.sandboxPolicy` 是硬依赖，而且比 README 说的还硬。** README 的说法是"没有它组合进来，本后端不会限制任何东西"[^19]；源码更强一层——`static inject = ['sandboxPolicy']` 加构造函数直接读 `ctx.sandboxPolicy.defaultMode`[^1][^7]，缺了它这个插件根本不会 apply，`ctx.fs` 也就没人注册。

---

## 出处

[^1]: 类上的 `static inject = ['sandboxPolicy']`：`packages/fs/fs-sandbox/src/index.ts:60`。
[^2]: 配置树行：`packages/bundle/base/cordis.patch.yml:441-444`。
[^3]: `sandbox-policy` 行，同文件 `:172-176`。
[^4]: `SandboxedFileSystem extends LocalFileSystem`：`packages/fs/fs-sandbox/src/index.ts:59`。
[^5]: `writeText` 覆写：`packages/fs/fs-sandbox/src/index.ts:84-92`。
[^6]: `editText` 覆写：`packages/fs/fs-sandbox/src/index.ts:105-113`。
[^7]: `sandboxMode` 构造时从 `ctx.sandboxPolicy.defaultMode` 取：`packages/fs/fs-sandbox/src/index.ts:65`。
[^8]: 能力事实的判断依据：`packages/fs/fs-sandbox/src/index.ts:69-71`。
[^9]: `checkedTarget` 实现：`packages/fs/fs-sandbox/src/index.ts:126-148`，返回新 target 那段是 `:136-147`。
[^10]: 可写根 `writableRoots()`：`packages/sandbox/sandbox/src/roots.ts:52-55`。
[^11]: 包含判定 `isPathUnder`：`packages/fs/fs-sandbox/src/containment.ts:58-76`。
[^12]: `Config` 类型别名：`packages/fs/fs-sandbox/src/index.ts:49`。
[^13]: `cwd` 字段：`packages/fs/fs-local/src/index.ts:42-43`、`:66`、`:59-62`。
[^14]: `diffBasisMaxBytes` 字段：`packages/fs/fs-local/src/index.ts:48`、`:52`。
[^15]: 沙箱默认值每次调用按 session 解析：`packages/fs/fs-sandbox/src/index.ts:43-48`、`:127`。
[^16]: minimal preset 的 `isolate: { fs: true }` group：`apps/cli/config/agent-presets/minimal/agent.cordis.yml:48-57`。
[^17]: 重复注册 `ctx.fs` 会让加载失败：`packages/bundle/base/README.md:7`。
[^18]: `@deepseek-ai/dsh-fs-e2b`：`packages/fs/README.md:11`。
[^19]: "没有它组合进来，本后端不会限制任何东西"：`packages/fs/fs-sandbox/README.md:45`。
