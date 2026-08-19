# tool-bash

> `@deepseek-ai/dsh-tool-bash` · bundle：`base` · 配置树 id：`tool-bash` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：把 `ctx.shell` 执行器封装成模型可见的 `bash` 工具——负责参数校验、workdir 归属、沙箱升权审批、结果文本渲染，并把后台进程句柄适配进通用 `ctx.jobs` 运行时。

## 它在树上长什么样

```yaml
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
```

这一行既没有 `inject` 也没有 `config`。注入清单写在包里：

```ts
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']
```

四个服务全部就绪前，插件保持 pending。Windows 上整行禁用，那一侧由 [tool-pwsh](./dsh-tool-pwsh.md) 顶上。

出处：树上的三行见 `packages/bundle/base/cordis.patch.yml:210-212`，inject 清单见 `packages/shell/tool-bash/src/index.ts:31`。

web 档把它整行关掉，改由每个 session 自己挂 preset：

```yaml
- id: tool-bash
  disabled: true
```

注意这里是 `disabled` 而不是删除。同文件 283-285 行给了理由：base 是共享层，删掉的行会在某天有人重排组合时悄悄复活。出处：`packages/bundle/web-app/cordis.patch.yml:293-294`。

依赖分两档——四个 inject 是硬门槛，另有两个可选依赖不参与这道门槛、只在调用时才去要：

```mermaid
flowchart TD
    T["<b>tools</b><br/>服务就绪"]
    SH["<b>shell</b><br/>ctx.shell 已挂载"]
    SP["<b>systemPrompt</b><br/>服务就绪"]
    SE["<b>shellEnv</b><br/>服务就绪"]
    R["<b>tool-bash 激活</b><br/>四个 inject 全部就绪才注册 bash 工具"]
    J["<b>ctx.get(jobs)</b><br/>调用时才取，不在 inject 里"]
    AP["<b>ctx.get(approval)</b><br/>调用时才取，不在 inject 里"]
    ER["<b>报错</b><br/>background jobs unavailable，load dsh-jobs and dsh-tool-jobs"]

    T --> R
    SH --> R
    SP --> R
    SE --> R
    R -- "run_in_background 调用" --> J
    R -- "sandbox 升权调用" --> AP
    J -- "缺失" --> ER

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class T,SH,SP,SE entry
    class R main
    class J,AP note
    class ER danger
```

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 工具 | `bash` | `ctx.tools.register(defineTool(...))`，`packages/shell/tool-bash/src/index.ts:242-244` |
| prompt 段 | `tool:bash`（order 105） | 正文一句：`Check the [exit code: N] marker on every bash result; investigate failures before moving on.`（`src/index.ts:236-240`） |
| 事件监听 | 无 | 全包没有一处 `ctx.on` / `ctx.waterfall`，`docs/event-producer-consumer.md` 里也没有它的行。逐调用的 allow/deny/ask 由 `tools/pre-execute`（waterfall，生产者是 `tools`，消费者是 hooks 家族与 `tool-jobs`）负责，不在本包（`docs/event-producer-consumer.md:58`） |

模型看到的 schema 不是固定的，两个字段各自挂在不同的条件上：

```
schema = {
    command:      必填
    description:  必填
    timeoutMs:    可选，始终在
    workdir:      可选，始终在
}
if config.enableRunInBackground:
    schema += run_in_background
if ctx.shell.sandboxMode 被执行器报告:
    schema += sandbox_permissions   // 枚举 = ESCALATION_TARGETS
    schema += justification
```

`ESCALATION_TARGETS` 的值是 `['workspace-write', 'danger-full-access']`。

出处：参数定义 `src/index.ts:245-270`，枚举取用 `src/index.ts:193, 259-269`，枚举本身 `packages/sandbox/sandbox/src/escalation.ts:41`。

```mermaid
flowchart TD
    ALW["<b>command / description</b><br/>必填，始终存在"]
    OPT["<b>timeoutMs / workdir</b><br/>可选，始终存在于 schema"]
    BG["<b>run_in_background</b><br/>仅当 enableRunInBackground=true"]
    SB["<b>sandbox_permissions + justification</b><br/>仅当执行器报告 ctx.shell.sandboxMode"]
    SCHEMA["<b>bash 工具 schema</b><br/>模型每次请求看到的参数集合"]

    ALW --> SCHEMA
    OPT --> SCHEMA
    BG -- "config.enableRunInBackground" --> SCHEMA
    SB -- "sandboxMode 非空" --> SCHEMA

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class ALW,OPT entry
    class BG,SB note
    class SCHEMA main
```

两个运行时可选依赖不写在 `inject` 里，而是调用时 `ctx.get`：

| 依赖 | 何时取 | 缺失时 |
|---|---|---|
| `jobs` | 走 `run_in_background` 时 | 报 `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`（`src/index.ts:354-357`） |
| `approval` | 沙箱升权时 | —（`src/index.ts:226`） |

另有一条加载期硬校验，跟上面两条不同，它在加载时就把插件炸掉：执行器会限制但 `ctx.sandboxPolicy` 缺席，直接抛 `tool-bash: the mounted bash executor confines but ctx.sandboxPolicy is missing`（`src/index.ts:195-197`）。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `enableRunInBackground` | boolean | `true` | 关掉后 `run_in_background` 参数从 schema 里消失，且强行传入会在 execute 阶段被拒（`src/index.ts:40-42, 256-258, 351-353`） |

base bundle 没给它写 config，所以线上跑的就是默认值 `true`。

## 模型看得见什么

**系统提示**：上面那句 order 105 的固定文本，每个请求都在。README 明确它「Prefix-stable while the registration scope and prompt text are unchanged」，沙箱模式切换不会改动它（`packages/shell/tool-bash/README.md:73-77`）。

**工具 schema**：`bash` 的定义。`run_in_background` 与 `sandbox_permissions`/`justification` 是条件字段，出现与否会改变前缀。

**前台结果文本**：三段拼起来。

```
text = stdout 尾部
if 有 stderr:                text += "[stderr] 段"
text += 标记行
if 输出为空:                 text = "(no output)"
if exitCode == 0 且无信号:   不产生退出标记
```

标记行原文精确为：

```
[output truncated; full output: <path-or-(unavailable)>]
[sandbox: file access denied under <mode> mode]
[timed out after <timeoutMs>ms]
[killed by signal: <signal>]
[exit code: <exitCode>]
```

出处：`src/render.ts:41-58`、README.md:97。

**后台**：启动返回精确的 `started background job <jobId>`。此后的状态行、完成通知、列表、取消响应都归 `dsh-tool-jobs`（README.md:111）。

**错误**：统一成 `Error: <message>`，稳定串见 README.md:125。

有个容易读反的地方：非零退出**不是** `isError`，它交给模型自己判读；只有 spawn 失败、abort 这类基础设施故障才是（README.md:33）。

## 什么时候你会想换掉它 / 怎么换

- **只想关后台**：`- id: tool-bash` 加 `config: { enableRunInBackground: false }`。
- **想换执行器而不换工具**：不用动这一行。工具是 `ctx.shell` 的消费者，换 provider（[bash-sandbox](./dsh-bash-sandbox.md) ↔ `dsh-bash-local`）即可，沙箱字段随 `sandboxMode` 自动增减。
- **想要持久 shell**：本工具每次都是全新 `bash -c`，无状态。仓库里另有 `@deepseek-ai/dsh-tool-bash-persistent`（`inject = ['tools', 'terminals']`，走 PTY，`packages/shell/tool-bash-persistent/src/index.ts:402`），但它不在任何 bundle 的 patch 里。
- **Windows**：直接用 [tool-pwsh](./dsh-tool-pwsh.md)，两者按 `process.platform` 互斥启用。

## 坑与边界

**回放时退出徽章靠解析文本。** 如果命令输出的最后一行恰好就是 `[exit code: N]` / `[killed by signal: …]`，回放会把它当成标记吃掉，徽章显示错误，而且该行会从卡片正文里消失（README.md:137）。

**`bash` 主动退出 `timeout-policy` 预算。** 它保留执行器自己的超时路径；`timeout-policy` 只对在 `ToolDefinition` 上声明了 `timeoutMs` 的工具生效，而 `bash` 故意不声明（README.md:138、`packages/guard/timeout-policy/README.md:57`）。

**后台进程没有执行器超时**，必须靠 `job_kill`，或等 owner / 服务 dispose（README.md:139）。

**模型拿不到 `stdin` / `env` / `stdoutMaxBytes`。** 这三个是 `ShellExecRequest` 上的可信进程内通道，工具层只按具名字段构造请求，模型多传的键被忽略（README.md:45）。

**README 与源码有两处不一致，以源码为准：**

| 位置 | README 写的 | 源码实际 |
|---|---|---|
| README.md:7 | `['tools', 'bash', 'systemPrompt', 'bashEnv']` | `['tools', 'shell', 'systemPrompt', 'shellEnv']` |
| README.md:125 | `background execution is disabled for this bash tool` | `run_in_background is disabled for this deployment (enableRunInBackground: false)`（`src/index.ts:352`） |

## 相关

[bash-sandbox](./dsh-bash-sandbox.md) 提供它消费的 `ctx.shell`；[shell-env](./dsh-shell-env.md) 提供每次调用注入的 `DSH_*` 快照（`src/index.ts:341`）；真正 spawn 进程的是 [subprocess-local](./dsh-subprocess-local.md)。
