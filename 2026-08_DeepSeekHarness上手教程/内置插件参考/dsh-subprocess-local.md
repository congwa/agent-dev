# subprocess-local

> `@deepseek-ai/dsh-subprocess-local` · bundle：`base` · 配置树 id：`subprocess` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：`ctx.subprocess` 的本地实现——这棵树上所有子进程（shell 命令、ripgrep、LSP server、PTY 会话）最终都从这里 spawn；它负责分离进程树、平台正确的整树终止、有界输出收集与 spill、凭据擦洗，以及退出时的兜底清理。

## 它在树上长什么样

```yaml
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
```

`packages/bundle/base/cordis.patch.yml:163-164`。**配置树 id 是 `subprocess`，不是 `subprocess-local`**——`--dump-config` 里看到的就是 `subprocess`。没有 `inject`、没有 `config`，两者都是刻意的：README 原文「It has no config: every disposition, limit, terminal dimension, grace, and directory arrives from the calling capability seams」（README.md:5）。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.subprocess` | `LocalSubprocessRuntime extends SubprocessRuntime`，基类 `super(ctx, 'subprocess')`（`packages/subprocess/subprocess-local/src/index.ts:37`、`packages/subprocess/subprocess/src/index.ts:104`）；一个 context 只允许一个实现，挂第二个会抛（`docs/subsystems/subprocess.md:280`） |
| 进程钩子 | Node `exit` 监听器 | 构造时经 `ctx.effect` 挂 `process.prependListener('exit', …)`，dispose 时先 await 正常清理再摘掉（`src/index.ts:47-60`） |
| 事件监听 | 无 | 不参与 cordis 事件总线 |

三个抽象方法的实现：`resolveExecutable()`（104-135）、`spawn()`（146-157）、`spawnTerminal()`（161-184）。

## 配置项

**无配置项。** 它的行为完全由调用方在 spec 上给：超时、宽限、输出上限、spill 上限、终端行列数、工作目录、stdio disposition，一律来自各能力接缝自己的配置——shell 那侧就是 [bash-sandbox](./dsh-bash-sandbox.md) / [pwsh-sandbox](./dsh-pwsh-sandbox.md) 继承来的 `timeoutMs` / `maxOutputBytes` / `maxSpillBytes` / `graceMs`。`docs/config-catalog.md:3085` 也把它列在「Loadable plugins with no config」那一组（组标题在 3024 行）。

## 关键行为

| 主题 | 事实 |
|---|---|
| 进程树 | POSIX 子进程 `detached`（自己一个进程组），用负 pgid 发信号，失败回落直接子进程；Windows 走 `taskkill /PID <pid> /T /F`（README.md:9） |
| 终止 | `terminate()` 是句柄**唯一**的终止动词：SIGTERM → 等 spec 的 grace → SIGKILL；树已消失时是 no-op。`waitForExit()` 轮询整树存活，所以调用方拆解时确认的是真正的静默（README.md:9） |
| 输出 | `'pipe'` 把原始流原样交给调用方（协议分帧归消费者）；`'inherit'` 透传父描述符；collect 模式保留超出上限的**尾部**（错误和结果都堆在末尾——pi/OpenCode 的理由），完整流在配置了 spill 上限时追加到私有临时文件（README.md:10） |
| spill 文件 | `0600`，随机名，位于惰性创建的 `0700` per-process 目录下；超过 spill 上限的流会丢弃已不完整的 spill 只返回标记为截断的尾部；结算时封 fd，最终 close 失败则**不**给出路径而不是给一个不完整的文件（README.md:10） |
| 环境 | `process.env` 减去凭据形状的名字与**所有** `DSH_*`，再合入 spec 的显式 `env`。凭据判据是 `SENSITIVE_ENV_PATTERN = /KEY\|PASSWORD\|SECRET\|TOKEN/i`（`packages/subprocess/subprocess/src/index.ts:44, 60-66`）；两种擦洗都大小写不敏感，因为 Windows 环境名大小写不敏感 |
| 读取 | collect 模式的读是**基于偏移量**的，服务自己不持游标，所以「调用方持游标的增量读」（bash 后台读路径）与「整流重读」可以并存，结算前后都可以（README.md:12） |
| 可执行查找 | 绝对路径直接校验，裸名走擦洗后的 PATH 加平台扩展名；**含分隔符的相对路径在接缝处直接拒绝**（`src/index.ts:113-117`），因为解析基准未定义，宁可炸也不猜 |
| 终端 | `spawnTerminal` 分配 `node-pty`，桥接 UTF-8 文本，检查并向当前前台进程组发信号，终止时在杀掉顶层 shell 前后各扫一遍后代（README.md:14） |
| 拆解 | 服务保留活句柄，自己 dispose 时对每棵仍在跑的树升级终止并 await 退出（`src/index.ts:79-102`） |
| 宿主退出 | effect 活跃期间挂着的 `exit` 监听器会同步强杀所有还在活集合里的普通树与终端会话：POSIX 发 SIGKILL、Windows 跑 `taskkill /T /F`；**不创建任何 promise 或 timer**，保留宿主的退出码与诊断，逐个目标包住失败，且不声称已静默（README.md:16、`src/index.ts:62-77`） |

## 模型看得见什么

**没有直接可见面。** 它不注册工具、不注册 prompt 段、不产生任何模型可见文本。README 的 Model Experience 一节原文是「Indirectly, through Consumers (today the bash executor family behind `dsh-tool-bash`), which own all model-facing rendering of process output and lifecycle.」（README.md:20），KV cache 也是「No direct invalidation」（README.md:24）。模型看到的截断标记、spill 路径、退出码，全部是 [tool-bash](./dsh-tool-bash.md) / [tool-pwsh](./dsh-tool-pwsh.md) 渲染出来的。

## 什么时候你会想换掉它 / 怎么换

基本不会。它是本地部署下 `ctx.subprocess` 的唯一实现，被 bash 执行器家族、LSP、PTY 后端、ACP subagent 后端共同依赖（`docs/subsystems/subprocess.md:5`），`tool-fs-search` 打包的 ripgrep 也走它（`docs/tool-catalog.md:27`）。真要换只有一种场景：把执行世界搬到远端——那需要一个自己实现 `resolveExecutable` / `spawn` / `spawnTerminal` 的 provider，并且要注意接缝的硬约束「可执行路径与挂载的文件系统 provider 属于同一个执行世界」（`docs/subsystems/subprocess.md:284`）。这一行的 `name` 换掉即可，因为消费者只 `inject: ['subprocess']`。

## 坑与边界

- **Windows 整树支持是尽力而为**：终止走 `taskkill /PID <pid> /T /F` 且所有结果都被包住（树不存在、竞态、二进制缺失），存活性判断回落到直接子进程边界（README.md:28）。
- **终端进程检查只有 Linux/macOS**：没有支持的平台实现时终端原语直接失败；Linux 精确探测覆盖 x64 与 arm64，macOS 用 `ps` 快照（README.md:29）。
- **守护化的终端后代仍可能逃逸**：macOS 上在任何前台快照之前就 reparent 的子进程从 `node-pty` 根不可发现；Linux 上调用 `setsid` 的子进程同时离开进程树和被拥有的终端会话。本地 provider 不加持续的进程表监控（README.md:30）。
- **进程内清理依赖「JavaScript 可观测的退出」**：`process.exit()`、默认的未捕获异常与未处理拒绝会触发 Node 的同步 `exit` 事件；未安装 handler 的 `SIGTERM`/`SIGINT`/`SIGHUP` 走 OS 默认处置，**绕过**该事件。`SIGKILL`、致命 OOM、`process.abort()`、原生崩溃、断电则必须靠外部 supervisor / 容器 init（README.md:31）。
- **凭据擦洗是名字启发式**：只认 `*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*`，`*PASSPHRASE*` 之类会漏；被误擦的变量的白名单是待办（README.md:32）。
- **完成的 spill 文件不删**：有界的完整输出恢复文件（以及那个私有 per-process 目录）会在系统临时目录里堆积，直到外部有人清理；超限的不完整 spill 会立刻尝试删除，但删除失败仍可能留下一个有界文件（README.md:33）。

## 相关

它是 [bash-sandbox](./dsh-bash-sandbox.md) 与 [pwsh-sandbox](./dsh-pwsh-sandbox.md) 的 `inject` 依赖（两者的 `static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']`）；[shell-env](./dsh-shell-env.md) 收集的 `DSH_*` 快照最终由这里的 `childEnv()` 在擦洗之后合入（`src/spawn.ts:37-47`）；模型侧的呈现归 [tool-bash](./dsh-tool-bash.md) / [tool-pwsh](./dsh-tool-pwsh.md)。
