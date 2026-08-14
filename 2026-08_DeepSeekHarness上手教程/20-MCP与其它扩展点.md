# 20 · MCP 与其它扩展点

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章把"工具"和"事件"之外剩下的注册面一次讲完：MCP、`ctx.commands`、`ctx.jobs`、skill、schedule、attachment。

**读完这章你会**：

- 查一张表决定"我想加 X"该注册到哪个 `ctx.*` 上，不用满仓库翻
- 用一段 YAML 把任意外部 MCP server 的工具接进模型，并说清 dsh **不能**反向当 MCP server
- 写一个不花 token、不触发模型 turn 的斜杠命令
- 把长任务交给 `ctx.jobs`，让模型用 `job_*` 收尾
- 在约定目录里放一个 `SKILL.md` 让模型自己发现它
- 判断 schedule / attachment 能不能承担你的需求，以及它们明确不干什么

---

## 1. 先查表：我想加 X，该注册到哪

dsh 官方自己维护着这张表，两处：`docs/architecture.md:108`–`127`（"Where new behavior goes"）和 `docs/cookbook/extension-cookbook.md:101`–`129`（"feature → mechanism map"）。下表是把这两张表按"本教程读者会问的问题"重排后的版本，**本章负责的行加了粗体**。

| 我想要的效果 | 注册到哪 | 模型看得见吗 | 出处 |
|---|---|---|---|
| 模型能主动调用的新能力 | `ctx.tools.register()` | 是，schema 进提示词 | `docs/architecture.md:111` |
| **人敲斜杠命令，不产生模型消息** | **`ctx.commands.register()`** | **否** | `docs/architecture.md:115` |
| **后台跑长任务，跑完通知模型** | **`ctx.jobs.start()`** | 间接：`job_output` / `job_list` / `job_kill` | `docs/architecture.md:116` |
| **一份"要用时才展开"的说明书** | **落一个 `SKILL.md` 文件；或 `ctx.skills.registerProvider()`** | 只看见名字+描述，正文按需加载 | `docs/subsystems/skills.md:231` |
| **定时提醒，到点开一轮新对话** | **装 `@deepseek-ai/dsh-schedule` 插件** | 是：`schedule_create` 等三个工具 | `packages/schedule/schedule/README.md:5`、`:29` |
| **图片二进制不写进会话日志** | **`ctx.attachments`（抽象 seam）** | 消息里只有内容寻址引用 | `docs/subsystems/attachment.md:5` |
| **接外部 MCP server 的工具** | **每个 server 一个 `dsh-mcp-client` 实例** | 是，名字是 `mcp__<server>__<tool>` | `packages/mcp/mcp-client/README.md:5` |
| 拦截/否决一次工具调用 | `tools/*` waterfall（第 13 章） | 取决于你的决策 | `docs/architecture.md:119` |
| 改系统提示词里的一段 | `ctx.systemPrompt.section()`（第 15 章） | 是 | `docs/cookbook/extension-cookbook.md:109` |
| 委派给子 agent | `ctx.subagents` 提供者注册表（第 19 章） | 通过 `dsh-tool-subagent` | `docs/cookbook/extension-cookbook.md:120` |
| 接一个新模型厂商 | `ctx.llm` 上 `registerAdapter`（第 04 章） | 否 | `docs/cookbook/extension-cookbook.md:128` |
| 让模型自己写并运行插件 | `ctx.dynamicCordisRunner` | 间接：模型面工具在 `dsh-tool-cordis` | `docs/subsystems/extensions.md:69`、`packages/extensions/cordis-host-runner/README.md:5` |

判断"要不要新造一个 `ctx.xxx`"的官方口径：一个 **seam** 必须凑齐三个角色——Service Definition（接口）、Service Provider（实现）、Consumer（通常是模型能调的工具），只有一个角色不算 seam（`docs/architecture.md:100`）。本章里 jobs、skill、attachment 都是标准三件套，schedule 故意**不**开放 service，commands 只有注册表没有模型面。

---

## 2. MCP：只有 client 方向

### 2.1 一个 server = 一个插件实例

`@deepseek-ai/dsh-mcp-client` 连一个外部 MCP server，把它 `tools/list` 出来的工具逐个注册到 `ctx.tools`，模型看到的名字是 `mcp__<serverName>__<rawName>`（`packages/mcp/mcp-client/README.md:5`）。要接多个 server 就在 `cordis.yml` 里放多条，每条一个 `id`、一个 `serverName`（`README.md:9`）。

stdio 模板（逐字来自 `examples/mcp-memory/memorix.cordis.yml:3`–`11`，只去掉了文件开头两行注释）：

```yaml
- insert:
    - id: memory-memorix
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memorix
        transport: stdio
        command: memorix
        args: [serve]
        cwd: !!js process.cwd()
```

HTTP 模板（逐字来自 `packages/mcp/mcp-client/README.md:22`–`29`）：

```yaml
- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

**两段的缩进层级不一样，别直接混用**：stdio 那段是完整的 patch 覆盖层（顶层 `- insert:`），可以直接喂给 `--patch`；HTTP 那段是 README 里写在 `cordis.yml` 插件列表中的裸条目，要当覆盖层用得自己套一层 `- insert:` 并整体右缩进四格。

挂上去就是 `dsh web --patch "$PWD/examples/mcp-memory/memorix.cordis.yml"`（`examples/mcp-memory/README.md:28`）；`web` 子命令和可重复的 `--patch <path>` 定义在 `apps/cli/src/args.ts:156`、`:163`。想长期生效，就把这段 `insert` 并进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（单 profile）或 `$DSH_HOME/cordis.patch.yml`（整机），**不要整个文件覆盖过去**，那里可能已有别的用户补丁（`examples/mcp-memory/README.md:33`）。

### 2.2 配置字段（源码为准）

Schema 定义在 `packages/mcp/mcp-client/src/index.ts:107`–`128`，是一个按 `transport` 分支的 union：

| 字段 | 适用 | 默认 | 说明 |
|---|---|---|---|
| `serverName` | 两者 | 必填 | 工具名命名空间，正则 `^[A-Za-z0-9_-]{1,32}$`（`src/index.ts:37`） |
| `command` / `args` / `env` / `cwd` | stdio | 只有 `command` 必填 | `args` 直接传，不过 shell（`src/index.ts:61`–`62`） |
| `url` / `headers` | http | 只有 `url` 必填 | — |
| `toolCallTimeoutMs` | 两者 | `60000`（`src/index.ts:34`） | 单次 `callTool` 超时 |
| `failOnStartupError` | 两者 | `false`（`src/index.ts:116`） | 为 `false` 时，连不上就"加载成功但零工具" |
| `reconnect.*` | 两者 | `enabled: true` / `initialDelayMs: 500` / `maxDelayMs: 30000` / `maxAttempts: 10`（`src/connection.ts:40`–`45`） | 断线重连策略 |

### 2.3 这里最容易踩的三个坑

1. **dsh 不会替你装 server。** 它只负责起进程或连 URL，不下载 server、不建数据库、不迁移数据（`examples/mcp-memory/README.md:11`）。stdio 子进程启动前，dsh 会主动抹掉名字像凭证的环境变量和所有 `DSH_*`，其它环境变量照常继承——需要哪个密钥就显式写进 `config.env`（`examples/mcp-memory/README.md:13`）。
2. **`serverName` 撞车 = 后加载的那个实例直接加载失败**，不是静默覆盖（`packages/mcp/mcp-client/README.md:58`）。工具名是 `(serverName, rawName)` 的纯函数（`README.md:55`），改 `serverName` 等于把这台 server 的所有工具改名一遍。
3. **只桥接了 Tools。** MCP 的 Resources 和 Prompts 没有消费方，明确 deferred（`README.md:111`）。图片、音频、resource 类返回块在模型上下文里会退化成占位符，完整 JSON 只留在执行期的 canonical value 里（`README.md:114`）。

⚠️ 仓库内两处文档对"断线是否自动重连"说法不一致：`packages/mcp/mcp-client/README.md:69` 描述了指数退避的重连 supervisor，`:48` 写明 `reconnect.enabled` 默认 `true`，而 `examples/mcp-memory/README.md:82` 写的是 "the current generic client does not auto-reconnect"。源码侧我确认了 `packages/mcp/mcp-client/src/connection.ts:40`–`45` 的 `RECONNECT_DEFAULTS.enabled = true`、`:192` 的 `scheduleReconnect()`、`:248` 的 `generation.onclose` 钩子，倾向于 example README 是旧文案，但我没跑过验证。

### 2.4 反方向：dsh 当 MCP server —— 不支持

我在全仓库检索 `@modelcontextprotocol/sdk`（含 `native/`、`python/`、`website/`、`apps/`），server 侧的 `McpServer` / `StdioServerTransport` / `StreamableHTTPServerTransport` **只出现在 mcp-client 自己的测试夹具里**（`packages/mcp/mcp-client/tests/fixture-server.ts:8`–`9`、`tests/mcp-client.e2e.ts:18`–`19`），产品代码一处都没有；`packages/mcp/README.md:9` 的包清单里也只有 `mcp-client/` 一行。所以 rc.5 里 **没有"把 dsh 暴露成 MCP server"这个扩展点**，别去找配置项。要让外部程序驱动 dsh，走的是另一条路：ACP（`packages/acp/acp`）或 JSON-RPC（`examples/jsonrpc-agent`），见第 23 章。

---

## 3. `ctx.commands`：人用的命令，不花 token

工具是给模型调的，命令是给人敲的。官方定义就一句：`handler` "Execute against the receiving agent without sending the command to the model"（`docs/subsystems/commands.md:41`）。

| | 工具（`ctx.tools`） | 命令（`ctx.commands`） |
|---|---|---|
| 谁触发 | 模型 | 人在 UI 里敲 `/name` |
| 进模型历史吗 | 进 | **不进**（`packages/interaction/commands/README.md:15`） |
| 花 token 吗 | schema 常驻请求前缀 | 零（`README.md:31`） |
| 会开一轮 turn 吗 | 在 turn 里 | 不会；命令自己可以显式调 `Agent` 再去开（`README.md:15`） |
| 留痕 | 工具调用与结果 | 日志里一对 `command/run` + `command/done`，不被任何 turn 包裹（`docs/subsystems/commands.md:143`–`146`） |

最小完整插件（`packages/session-query/session-log-export/src/index.ts:1`–`26` 全文，26 行，去掉原注释）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'session-log-download'
export const inject = ['commands']

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
}
```

要点：`name` 小写不带斜杠（`packages/interaction/commands/README.md:13`）；`handler` 拿到的 `invocation` 有四个字段 `commandId` / `agent` / `rawInput`（命令名之后的全部字节，含分隔空格）/ `signal`（`docs/subsystems/commands.md:51`–`60`）；返回值两种 kind：`{kind:'success', text?, sourceEventSeq?}` 和 `{kind:'error', text}`（`:65`–`73`），其中 `sourceEventSeq` 只在 success 上可用，指向本会话里一条更早的非命令事件。想加输入提示就补 `input: { hint: '<text>' }`，想让 `command/run` 不重复记录载荷就 `recordInput: false`——`packages/feedback/command-feedback/src/index.ts:104`–`105` 是这两个字段的现成例子。

**坑**：注册了不等于有人分发。`@deepseek-ai/dsh-commands` 在 base bundle 里（`packages/bundle/base/cordis.patch.yml:250`–`251`），Web 客户端会走它；但按 `packages/interaction/commands/README.md:19` 的说法，UI-less 的 demo spine 和 ACP 自动化不提供 command adapter——你在 headless 组合里注册的命令没有入口。

---

## 4. `ctx.jobs`：后台任务的准入与生命周期

三件套（`packages/jobs/README.md:9`–`11`）：`dsh-jobs` 定义抽象注册表 `ctx.jobs`（`packages/jobs/jobs/src/index.ts:62` 的 `abstract class JobRegistry extends Service`），`dsh-jobs-local` 是进程内实现，`dsh-tool-jobs` 是模型面的 `job_output` / `job_list` / `job_kill`（`packages/jobs/tool-jobs/README.md:9`–`11`）。base bundle 里只有后两个各占一行：`packages/bundle/base/cordis.patch.yml:69`–`70`（jobs-local）和 `:218`–`219`（tool-jobs）；`dsh-jobs` 是纯定义包，由实现包 import，不单独挂载。

生产者要交的 `JobStart` 有五个字段（`docs/subsystems/jobs.md:34`–`57`）：必填 `kind`、`label`、`run()`，可选 `owner`、`outputLimitBytes`。真实调用点在 `packages/shell/tool-bash/src/index.ts:365`–`377`：

```ts
const id = jobs.start({
  kind: 'bash',
  label: args.command,
  ...exec.agent ? { owner: exec.agent } : {},
  run: () => {
    const proc = ctx.shell.start(ctx.shell.resolve(request))
    return {
      cancel: () => void proc.kill(),
      done: proc.done.then(() => processOutcome(proc)),
      readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
    }
  },
})
```

`run()` 返回的三个钩子的契约在 `docs/subsystems/jobs.md:63`–`83`：`cancel()` 必须同步、幂等，并最终让 `done` 落定；`done` **不许 reject**（reject 会被运行时转成 `failed`）；有 `readOutput` 表示这是流式任务、每次读走增量，没有则表示只有终态输出。

准入有三道，都会在真正 spawn 之前 fail：

1. **必须先有 controller。** `dsh-tool-jobs` 加载时调 `ctx.jobs.attachController('tool-jobs')`（`packages/jobs/tool-jobs/src/index.ts:260`）；某个 agent 的组合里没有它，`start()` 就报 `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)`（`packages/jobs/jobs-local/README.md:21`）。tool-bash 自己还额外挡了一层：`ctx.get('jobs')` 为空时抛 `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`（`packages/shell/tool-bash/src/index.ts:356`）。
2. **部署可以整个关掉后台 bash。** `enableRunInBackground` 默认 `true`（`packages/shell/tool-bash/src/index.ts:41`），置 `false` 会移除 `run_in_background` 参数并在执行期拒绝强行调用（`:352`，`packages/shell/tool-bash/README.md:37`）。
3. **每个 owner 的并发上限。** `maxConcurrentJobsPerOwner` 默认 `10`（`packages/jobs/jobs-local/src/index.ts:28`），只数该 owner 的 `running` + `stopping`，无主任务共用一个桶（`docs/subsystems/jobs.md:157`）。满了就直接失败，注册表不排队不抢占（`packages/jobs/jobs-local/README.md:11`）。`examples/acp-agent/background-job-admission.cordis.yml:19`–`20` 演示了压到 1 的写法——注意那两行嵌在 `dsh-acp-demo` 的 `config.tasks` 下面，是那个 demo 插件转给注册表的，不是直接写在 jobs-local 那一行上。

新任务种类要做 declaration merging，照抄 `packages/terminal/tool-terminal/src/index.ts:18`–`22`：

```ts
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'pty-send': 'pty-send'
  }
}
```

生命周期三条硬约束：任务属于 owner 和后端、**不属于**启动它的工具 fiber，所以插件热重载不会停掉在跑的任务（`packages/jobs/jobs-local/README.md:15`）；结算 first-wins，一条终态记录、一轮监听器通知（`:19`）；**任务是进程内的**，harness 进程死了记录就没了，要跨重启得自己实现 seam（`:33`）。完成通知的投递策略（busy 就注入下一步收件箱、idle 就唤醒开一轮 turn，`maxConsecutiveWakes` 默认 3）在 `packages/jobs/tool-jobs/README.md:23`–`25` 和 `:31`–`36`，源码默认值在 `packages/jobs/tool-jobs/src/index.ts:52`。

---

## 5. skill：模型的"按需说明书"

skill 是**可选指令**，不是会话事件（`docs/subsystems/skills.md:5`）。它分两段：目录里只放 `name` + 描述常驻上下文，正文只在模型调 `skill({name})` 时才读进来（`docs/subsystems/skills.md:231`、`:235`）。四件套是 `dsh-skill`（定义）/ `dsh-skill-filesystem`（本地 provider）/ `dsh-skill-badge`（打包 provider）/ `dsh-tool-skill`（模型面工具）（`docs/subsystems/skills.md:5`）；其中第一、二、四个在 base bundle 默认开（`packages/bundle/base/cordis.patch.yml:237`、`:240`、`:247`），`skill-badge` 那条带 `disabled: true`（`:243`–`245`）。

### 5.1 从哪几个目录发现

本地 provider 按 rank 扫，**rank 数字小的赢重名**（`packages/skill/skill/src/index.ts:75`，排序在 `:808`）。官方目录表在 `docs/subsystems/skills.md:68`–`75`：

| rank | source | 目录 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | 配置项 `customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills`（跳过 `.system` 子目录） |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | 配置了 `bundledSkillDir`，或 `includeDefaultRoots` 为真时取环境变量 `DSH_BUNDLED_SKILL_DIR` |

前五行的常量在 `packages/skill/skill-filesystem/src/index.ts:36`–`40`，bundled 行在 `:258`，其环境变量兜底在 `:171`–`172`，`BUNDLED_SKILL_RANK = 600` 在 `packages/skill/skill/src/index.ts:27`。表里没有的一档：走 §5.3 代码路径 `ctx.skills.register()` 塞进来的 skill 拿 `RUNTIME_RANK = 250`（`packages/skill/skill/src/index.ts:24`），它没有目录，但参与同一套 rank 比较，所以排在两个 project 目录之后、`custom` 之前。`projectRoot` = 最近的含 `.git` 的祖先目录，找不到就用当前 cwd（`docs/subsystems/skills.md:77`）。

### 5.2 写一个

目录形态 `<name>/SKILL.md`，或扁平文件 `<name>.md`；**只认单层**，嵌套的 `**/SKILL.md` 递归发现是被刻意排除的（`docs/subsystems/skills.md:85`、`packages/skill/skill-filesystem/README.md:55`）。名字必须 kebab-case。frontmatter 是开放 YAML 对象，provider 只认 `name`、`description`（必填）和 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`（`packages/skill/skill-filesystem/README.md:55`）。仓库里现成的例子是 `.agents/skills/dsh-pre-push-checks/SKILL.md:1`–`8`，形状就是（`description` 与正文首段原文都很长，这里用 `…` 截断，不是原文全貌）：

```markdown
---
name: dsh-pre-push-checks
description: Use before pushing, force-pushing, marking ready for review, or claiming checks pass on a deepseek-harness branch, …
---

# DSH Pre-Push Checks

Use this skill to run relevant local evidence once before a `deepseek-harness` push. …
```

`description` 是模型做路由决策的唯一依据（模型侧的会话目录只有 `name` 和 `description`，`docs/subsystems/skills.md:231`），写"什么时候该用我"，不要写"我是什么"。

**坑**：两个 invocation 字段必须写 kebab-case，写成 camelCase 或给了非布尔值，**整条 skill 从发现里丢掉**并打 warning，而不是忽略该字段（`packages/skill/skill-filesystem/README.md:57`）——设计上是 fail closed。另外 `references/`、`scripts/`、`assets/` 下的资源文件改动不算目录变更，不会触发重新发现（`README.md:47`）。

### 5.3 代码路径

不想落盘就走代码：`ctx.skills.registerProvider(create)` 注册一个数据源，`ctx.skills.register(skill)` 直接塞一条运行时 skill（`docs/subsystems/skills.md:263`、`:274`）。最小 provider 全文见 `packages/skill/skill-badge/src/index.ts:36`–`60`，核心就三处——一个 `{ name, list, get }` 对象（`:36`–`50`），`export const inject = ['skills']`（`:55`），`ctx.skills.registerProvider(() => provider)`（`:59`）。

---

## 6. schedule：会话内的定时提醒

默认**不装**：base / headless / web-app 三个 bundle 的 `cordis.patch.yml` 里都没有 `dsh-schedule` 行（它只作为依赖躺在 `apps/cli/package.json:68`）。装法是一个带两条插件条目的覆盖层，`examples/web-schedule/cordis.yml:4`–`9`：

```yaml
- insert:
    - id: time-context
      name: '@deepseek-ai/dsh-time-context'

    - id: schedule
      name: '@deepseek-ai/dsh-schedule'
```

`time-context` 不是 schedule 的依赖（`packages/schedule/schedule/README.md:11`），它只让模型能把"明天下午三点"按浏览器时区理解；schedule 自己永远只收显式时区。跑：`dsh web --patch examples/web-schedule/cordis.yml`（`examples/web-schedule/README.md:8`）。装上后模型多三个工具 `schedule_create` / `schedule_list` / `schedule_delete`（`packages/schedule/schedule/README.md:29`），规则三选一：`after_seconds`（正的 safe integer 延时）、`at`（绝对时刻）、`every_seconds`（固定频率，**下限 300 秒 / 五分钟**）（`README.md:5`、`docs/subsystems/schedule.md:94`）。

边界必须提前知道，否则会用错地方：

- **没有 cron。** 协议里没有日历表达式、没有 Cron、没有重复的时区、没有跨记录的准入闸（`docs/subsystems/schedule.md:94`）。
- **`deliveryMode` 永远是 `session-local`**（类型定义见 `docs/subsystems/schedule.md:164`–`165`）：原会话必须是活的，没有冷会话调度器、没有任何外部通知通道（`:156`；`examples/web-schedule/README.md:19` 明确列出无浏览器/系统/邮件/短信通知）。
- **只对插件加载之后创建的 root agent 生效**：插件只听后来的 `agent/created`，"插件加载时已存在的 agent 和运行时子 agent 拿不到 Schedule"（`packages/schedule/schedule/README.md:9`）。
- 到点不打断当前 turn：等 agent 完全 idle 才排一次 `followup()`，从不 `steer()`（`docs/subsystems/schedule.md:184`）。
- 投递是 **at-least-once**，不是 exactly-once：admission 之后、持久化 dispatch 之前崩溃，恢复后提醒内容可能重复一次（`docs/subsystems/schedule.md:186`）。
- 时区不猜：`at` 要么是带 `Z` 或数字偏移的 RFC 3339 串，要么是 `{date, time, time_zone}` 且 `time_zone` 显式给 `UTC` 或 IANA 名（`packages/schedule/schedule/README.md:23`）。

这个包故意**不导出** service：`packages/schedule/schedule/src/index.ts:33`–`35` 只有 `name` / `inject` / `apply`，全文件没有 `extends Service`，所以没有 `ctx.schedule` 可以调。状态全在会话事件日志的 `schedule/change` 里（`README.md:17`），定时器只是日志的一次投影（`README.md:5`）。所以"扩展 schedule"的正确姿势不是调它的 API，而是自己写一个新的定时插件。

---

## 7. attachment：二进制不进日志

规则一句话：**先落盘，再写事件**。生产者把校验过的字节交给 `ctx.attachments`，服务只在对象持久化之后才发出内容寻址引用；会话事件和模型可见的 `ImageBlock` 里只有这个引用和元数据，**没有** blob URL、临时路径、厂商 URL 或 base64（`docs/subsystems/attachment.md:5`）。落点是 `<DSH_HOME>/attachments/v1`（`docs/subsystems/attachment.md:7`），本地实现的具体路径是 `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>`（`packages/attachment/attachment-local/README.md:5`）。

服务的抽象面是三个方法加一个只读属性：`validateImage()` 只校验不落盘，`saveImage()` 校验并原子提交后返回引用，`readImage()` 校验完整性后返回字节（`docs/subsystems/attachment.md:88`–`112`），外加 `imageLimits`（`packages/attachment/attachment/src/index.ts:35`）。v1 只收四种图片：`image/png` `image/jpeg` `image/webp` `image/gif`（`docs/subsystems/attachment.md:17`）。

扩展点在**换后端**，不在"加附件类型"：`AttachmentStore` 是 `extends Service` 的抽象类（`packages/attachment/attachment/src/index.ts:29`–`32`），实现一个子类当插件加载即可占住 `ctx.attachments`；`LocalAttachmentStore`（`packages/attachment/attachment-local/src/index.ts:38`）就是这么来的，base bundle 在 `packages/bundle/base/cordis.patch.yml:106`–`107` 装它。

⚠️ 对象**永久保留**，引用感知的垃圾回收明确 deferred（`packages/attachment/attachment-local/README.md:19`）——因为 resume 和 fork 出来的会话可能共享同一个对象（`docs/subsystems/attachment.md:72`）。长期跑的部署要自己盯着这个目录的体积。

---

## 8. 默认到底装了什么

装 dsh 之后不改任何配置时的状态（依据 `packages/bundle/base/cordis.patch.yml`）：

| 能力 | 默认 | 行号 |
|---|---|---|
| `ctx.jobs`（jobs-local） | 开 | `:69`–`70` |
| `dsh-tool-jobs`（`job_*` 工具 + controller） | 开 | `:218`–`219` |
| `ctx.attachments`（attachment-local） | 开 | `:106`–`107` |
| `ctx.skills` + 文件系统 provider + `skill` 工具 | 开 | `:237`、`:240`、`:247` |
| `dsh-skill-badge` | **关**（`disabled: true`） | `:243`–`245` |
| `ctx.commands` + `/feedback` | 开 | `:250`、`:253` |
| MCP client | **未装**，要 `--patch` | — |
| schedule | **未装**，要 `--patch` | — |

上面这些行都没有 `config:` 块，所以本章引的默认值（`toolCallTimeoutMs: 60000`、`maxConcurrentJobsPerOwner: 10`、`maxConsecutiveWakes: 3`、`enableRunInBackground: true`、`reconnect.*`）就是 shipped 组合的实际生效值。

> 想知道这一点上 Pi / Codex / LangChain 怎么做，见 [五个 agent 系统源码解剖](../2026-08_五个agent系统源码解剖/00-总览与阅读指南.md)。

---

## 9. 本章未确认

- ⚠️ **MCP 自动重连的两处文档打架**：`packages/mcp/mcp-client/README.md:69` 说有指数退避 supervisor、`:48` 说默认开，`examples/mcp-memory/README.md:82` 说 "the current generic client does not auto-reconnect"。源码里 `connection.ts:40`–`45`（`RECONNECT_DEFAULTS.enabled = true`）、`:192`（`scheduleReconnect()`）、`:248`（`onclose` 钩子）支持前者，但我没有运行验证，也没有逐行读完这份 351 行的文件。
- ⚠️ **所有默认值都是从源码里的 schema 与常量读出来的，但仓库未安装依赖，我没跑过 `--dump-config` 复核**，也没验证 profile 层或用户层是否会在你的机器上覆盖它们。
- ⚠️ **"dsh 不能当 MCP server"是静态检索结论**：我 grep 了整个仓库（含 `native/`、`python/`、`website/`、`apps/`）的 `@modelcontextprotocol/sdk`，server 侧导入只在 `packages/mcp/mcp-client/tests/` 出现。但检索按包名做，若有人手写 JSON-RPC 而不引 SDK 则测不到。
- ⚠️ **`ctx.jobs` 的最小自定义 producer 我没有写出完整可运行文件**，只引用了 `tool-bash` 的真实调用块；一个不依附于工具的独立 job producer 在仓库里没有现成范例，形状请以 `docs/subsystems/jobs.md:34`–`83` 的契约为准。
- ⚠️ **第 1 节表格里 `ctx.dynamicCordisRunner` 那一行只查到服务定义与消费者存在**（`packages/extensions/cordis-host-runner/README.md:5`、`packages/extensions/tool-cordis/src/index.ts:27`），我没有跟进它的工具签名与 `node:vm` 隔离边界。
