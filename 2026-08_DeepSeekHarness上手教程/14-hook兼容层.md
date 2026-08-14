# 14 · hook 兼容层

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章只讲一件事：dsh 里的 "hook" 到底指什么，以及那两个能直接跑你现有 `hooks.json` 的桥接插件怎么配、能干什么、丢了什么。

**读完这章你会**：

- 分清 dsh 的「原生 hook」（就是普通插件）和「hook 桥」（跑外部 shell hook 的兼容层）
- 把一份现有的 Claude Code / Codex `hooks.json` 挂进 dsh 并看到它真的拦住工具
- 读懂退出码 / stdout 协议如何被解码成中性 `HookOutput`，再映射成 harness 的 typed Decision
- 预测多个 hook 同时命中时的合并结果（deny > ask > allow）
- 在会话日志里用 `hook/invoked` / `hook/result` 排查「我的 hook 到底跑没跑」

---

## 1. 先把名字理顺：dsh 里根本没有「hook 系统」

很多人打开仓库看到 `packages/hooks/` 就以为找到了 hook 系统。**不是。**

> 「原生 hook」不是一个包 —— 原生 hook 只是一个订阅规范生命周期事件的普通 Cordis 插件。
> —— `.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md:9`

同样的话在两处重复出现：`packages/hooks/README.md:5`（"a 'native hook' is just an ordinary Cordis plugin on those extension points"）和 `docs/cookbook/extension-cookbook.md:13`（"A 'native hook' is an ordinary Cordis plugin on an interception point; it needs no external protocol."）。

所以 dsh 里想在生命周期上插一脚，**默认答案永远是第 11、13 章那套**：写个插件，监听 `tools/pre-execute` 之类的 waterfall 拦截点，返回一个 typed Decision。`packages/hooks/` 下的三个包是**另一件事**：

| 包 | 角色 | 是不是插件 |
|---|---|---|
| `hook-protocol` | 共享的 shell hook 线协议库 | **不是**。`packages/hooks/hook-protocol/README.md:5` 明写 "NOT a cordis plugin — it registers nothing and injects nothing" |
| `hooks-claude-code` | Claude Code 方言桥 | 是，cordis 插件 |
| `hooks-codex` | Codex 方言桥 | 是，cordis 插件 |

桥的存在理由只有一条：**你已经有一份 `hooks.json` 了，不想重写成插件。**
`packages/hooks/hooks-claude-code/README.md:7` 说得很直白：原生插件能做这个桥做的一切，而且更强 —— 有类型化返回、没有序列化边界；**桥只是那个被映射子集的兼容通道**。

## 2. 先看一个真的例子，再讲机制

仓库里有 15 份端到端快照测试跟 hook 有关（`examples/acp-agent/tests/snapshots/hook-cc-*` 与 `hook-codex-*`），每份都自带一个真实 `hooks.json` 工作区。最简单的那份（`examples/acp-agent/tests/snapshots/hook-cc-pretool-deny/workspace/hooks.json:1`，全文）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          { "type": "command", "command": "echo 'bash is disabled by policy in this session' >&2; exit 2" }
        ]
      }
    ]
  }
}
```

模型调 `bash` 时，会话日志落下的是这三条。以下是同目录 `session.jsonl` 第 21–23 行原文（第 23 行的 `callId` / `id` 用 `…` 截短，其余逐字）：

```jsonl
{"type":"hook/invoked","seq":59,"time":1785730466385,"data":{"turn":1,"point":"PreToolUse","dialect":"claude-code","handlerId":"claude-code:PreToolUse:1","matcher":"bash"}}
{"type":"hook/result","seq":60,"time":1785730466389,"data":{"turn":1,"point":"PreToolUse","handlerId":"claude-code:PreToolUse:1","decision":"block","exitCode":2,"stderrSummary":"bash is disabled by policy in this session","durationMs":3.6819170000001122}}
{"type":"tool/result","seq":61,"time":1785730466390,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call_00_…"},"content":[{"type":"tool-result","toolCallId":"call_00_…","content":[{"type":"text","text":"Error: bash is disabled by policy in this session"}],"isError":true}],"role":"user","id":"e8988570-…"}},"sourceEventSeqs":[58],"surfaceOp":"append"}
```

一条链路全在这里了：`exit 2` → stderr 变成 block reason → 变成 `PreToolDecision.deny` → 工具层把 reason 包成 `Error: <你的 stderr>` 交给模型（拼这个前缀的代码在 `packages/core/tools/src/index.ts:1494`）。

## 3. 怎么配上去

### 3.1 装包

两个桥**都不在任何出厂 bundle 里** —— `packages/bundle/` 下只有 base / web-app / headless 三份 `cordis.patch.yml`，全文搜不到 `dsh-hooks`。必须自己装：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code
```

`dsh plugin --profile <name> <pnpm args>` 是 pnpm 的转发器，工作目录是 profile 目录（`apps/cli/README.md:14`）。注意一个坑：装完 dsh 会去看这个包的 `package.json` 有没有声明 `dsh.bundle.patch`（判据就是 `apps/cli/src/plugin.ts:44` 的 `manifest.dsh?.bundle?.patch !== undefined`）；**两个桥都没有声明**（`packages/hooks/hooks-*/package.json` 全文没有 `dsh` 这个 key），所以它会以「普通依赖」身份留下并往 stderr 打一次性 warning（`apps/cli/src/plugin.ts:71`，行为描述见 `apps/cli/reference/README.md:43`）—— 这是正常的，接下来你自己写挂载行。（桥的一堆 `@deepseek-ai/dsh-*` 是 peer 依赖，而 profile 的 `pnpm-workspace.yaml` 写着 `autoInstallPeers: false`；缺的 peer 靠 hoisted node_modules 回落到安装目录解决，设计说明在 `packages/boot/app-boot/src/profile.ts:133`。）

### 3.2 写 patch 行

profile 目录是 `$DSH_HOME/profiles/<name>`（`apps/cli/README.md:11`），里面的 `cordis.patch.yml` 是你自己的那一层，叠在所有 bundle 之后（`docs/architecture.md:27`）。patch 的 `insert` 形式见 `docs/user/develop/basic/config.md:37` 与 `packages/bundle/base/cordis.patch.yml:15`：

```yaml
- insert:
    - id: hooks-claude-code
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /Users/you/project/.claude/hooks.json
```

仓库里唯一一处真实挂载示例在 `examples/acp-agent/cordis.yml:181`（CC）和 `:189`（Codex），形状一样。

### 3.3 配置字段

| 字段 | CC 桥 | Codex 桥 | 说明 |
|---|---|---|---|
| `configPath` | 必填 | 必填 | 裸的事件表，或一个把它包在 `hooks` key 下的文件（settings 形态）；**两个桥都接受这两种**（`hooks-claude-code/src/config.ts:83`、`hooks-codex/src/config.ts:47`，都是 `asObject(root.hooks) ?? root`） |
| `pluginRoot` | 有 | 无 | 替换命令串里的 `${CLAUDE_PLUGIN_ROOT}`（`hooks-claude-code/src/config.ts:59`） |
| `projectDir` | 有 | 无 | 既替换 `${CLAUDE_PROJECT_DIR}`（`config.ts:60`），又作为 `CLAUDE_PROJECT_DIR` 环境变量导出；不填则**逐次**回落到会话工作区（`index.ts:150`） |
| `model` | 无 | 有 | 静态字符串（`hooks-codex/src/index.ts:53`），盖在每个 Codex payload 的 `model` 字段上（`index.ts:300`） |
| `defaultTimeoutMs` | 有 | 有 | 单个 hook 没写 `timeout` 时用它，默认 `DEFAULT_HOOK_TIMEOUT_MS` = `600_000`（`hook-protocol/src/runner.ts:20`）；单 hook 的 `timeout` 单位是**秒**（`runner.ts:74` 乘 1000），Codex 额外接受 `timeoutSec` 别名（`hooks-codex/src/config.ts:70`） |
| `stderrSummaryMaxChars` | 有 | 有 | `hook/result` 里 stderr 摘要的字符上限，默认 500（`hook-protocol/src/events.ts:53`）；非正整数会在 `apply()` 一开头就抛错（`index.ts:99` 调用，`:92` 抛） |

字段的权威定义在 `packages/hooks/hooks-claude-code/src/index.ts:45` 与 `packages/hooks/hooks-codex/src/index.ts:44`，也被抽进 `docs/config-catalog.md:661` / `:699`。

### 3.4 三个必踩的坑

1. **`configPath` 是进程级、只读一次。** 加载时 `readFileSync` 读一遍（`hooks-claude-code/src/index.ts:104`），相对路径按**进程启动 cwd** 解析，且没有「每个会话发现各自项目里的 `hooks.json`」，也没有热重载 —— 这两条写在字段自己的 JSDoc 里，连同 `TODO(per-session-hook-config)`（`index.ts:48`–`:51`）。**写绝对路径**。
2. **读失败/解析失败是静默降级。** `catch` 里只 `ctx.logger.warn` 然后 `return`，一个 hook 都不注册（`index.ts:113`–`:115`）—— 路径打错不会让 dsh 起不来，但也不会有人在 UI 上提醒你。查日志。
3. **只有 `type: 'command'` 的 hook 会跑。** CC 侧任何非 `command` 的 `type` 都被 parsed-and-skipped（`config.ts:98`）并 warn（`index.ts:111`）；README 点名的是 `http` / `mcp_tool` / `prompt` / `agent`（`hooks-claude-code/README.md:97`）。Codex 侧还额外跳过 `async: true`（`hooks-codex/src/config.ts:67`）。

## 4. 两种方言各支持什么

### 4.1 事件子集与落点

先解释两个待会儿要反复出现的动作：`agent.inject(msg)` 是「给下一次 pre-step 排一条模型可见的上下文，但**不唤醒** driver」（`packages/core/agent/src/runtime-types.ts:143`）；`agent.steer(msg)` 是「给最近的一步塞进 steering，driver 空闲就直接开一个 turn」（`runtime-types.ts:133`）。前者只是加料，后者能把停下来的循环推着再跑一步。

| CC hook | Codex hook | harness 拦截点 | 派发模式 | 桥做什么 |
|---|---|---|---|---|
| `SessionStart` | `SessionStart` | `agent/session-start` | emit | `additionalContext` → `agent.inject()`，**拦不住启动** |
| `UserPromptSubmit` | `UserPromptSubmit` | `agent/pre-step` | waterfall | deny → `{ kind: 'reject' }`；只有 context 则 `next()` 后追加到下游 `enter` |
| `PreToolUse` | `PreToolUse` | `tools/pre-execute` | waterfall | deny → `PreToolDecision.deny`；**CC 还支持 ask**，Codex 不支持 |
| `PostToolUse` | `PostToolUse` | `tools/post-execute` | waterfall | deny → `block` + feedback；context 前置到下游决定上 |
| `Stop` | `Stop` | `agent/turn-stopping` | serial | 阻塞则 `agent.steer()` 强制再来一步 |
| `SubagentStart` | — | `subagent/start` | emit | 注入到在进程内的子 agent |
| `SubagentStop` | — | `subagent/end` | emit | 纯观察 |

派发模式那一列不是我编的：每个事件声明上都挂着 `@mode` 标签（`packages/core/agent/src/runtime-types.ts` 的 `agent/session-start` emit、`agent/pre-step` waterfall、`agent/turn-stopping` serial；`packages/core/tools/src/index.ts:150`、`:173` 两个 waterfall；`packages/subagent/subagent/src/index.ts:155`、`:164` 两个 emit）。

CC 支持 7 个点（`hooks-claude-code/src/config.ts:11` 的 `CLAUDE_EVENTS`），Codex 5 个（`hooks-codex/src/config.ts:11` 的 `CODEX_EVENTS`）。**不在名单里的事件在解析阶段就被丢掉**，所以配了也不会报错，只是永远不响。

Codex 多一条 CC 没有的路：`SessionStart` 和 `UserPromptSubmit` 的 hook 如果干净退出且吐的是**非 JSON 的纯文本**，那段文本直接当 `additionalContext`（`hooks-codex/src/index.ts:152`–`:156`）。CC 桥不认纯 stdout（`hooks-claude-code/README.md:90`、`:91` 把它列为未支持）。

emit 点是 detached 的（没有任何拦截点 await 它们）：CC 有三个（`hooks-claude-code/README.md:47`），Codex 只有 `SessionStart`（`hooks-codex/README.md:55`）。插件卸载时 `createDetachedRuns().drain()` 先 abort 掉还在跑的 hook 进程、再等续作跑完（`hook-protocol/src/detached.ts:53`）。副作用是 `SessionStart` 的 context **可能赶不上第一次请求**（源码里挂着 `TODO(session-start-gating)`，`index.ts:205`）。

### 4.2 matcher 规则差在哪

| | Claude Code 模式 | Codex 模式 |
|---|---|---|
| 缺省 / `''` / `'*'` | 全匹配 | 全匹配 |
| 纯 `[A-Za-z0-9_\|]+` | **字面量**，`\|` 是精确分支：`pattern.split('\|').includes(query)` | 仍然当正则 |
| 其它 | 非锚定正则 | 非锚定正则 |

规则实现在 `hook-protocol/src/matcher.ts:57`，字面量判别式是 `matcher.ts:18` 的 `CLAUDE_LITERAL`。所以 `"matcher": "bash"` 在 CC 下只命中名字**恰好是** `bash` 的工具，在 Codex 下会命中任何名字里含 `bash` 的工具 —— 同一份文件换个桥语义就变了。仓库自己也是各用各的文件：`examples/acp-agent/cordis.yml:186` 的注释写着 Codex "cannot share Claude's file"。

matcher 的被测对象（matcher subject）也要看事件：`PreToolUse`/`PostToolUse` 是工具名，`SessionStart` 是 session source，CC 的 `SubagentStart`/`SubagentStop` 是写死的 `general-purpose`（`hooks-claude-code/src/index.ts:304`）。`UserPromptSubmit` 和 `Stop` **没有** subject，配置里的 `matcher` 在解析时就被丢弃（CC `config.ts:109`、Codex `config.ts:75`）。

无效正则不是「这条不生效」而是**整份配置作废**：解析器 `throw new SyntaxError`（`config.ts:113`），桥的 catch 接住后一个 hook 都不注册。仓库里专门有这个场景的快照（`hook-cc-invalid-matcher/workspace/hooks.json:12` 那个孤零零的 `"["`），同文件里那条本该生效的 `UserPromptSubmit`（第 3–9 行）也跟着一起没了。

## 5. stdin 载荷与环境

两种方言的 payload 都是 JSON 对象写进 hook 进程的 stdin（`runner.ts:75`）：

| | Claude Code | Codex |
|---|---|---|
| 公共字段 | `session_id` / `transcript_path` / `cwd` / `hook_event_name`（`index.ts:322`） | 同上再加 `model` / `permission_mode: 'default'`（`index.ts:292`），turn 级事件再加 `turn_id`（`:306`） |
| `transcript_path` 取不到时 | `''`（`index.ts:325`） | `null`（`index.ts:295`） |
| 尾部换行 | **有**（`index.ts:169`） | **没有**（`index.ts:146`） |
| 工具入参 | `tool_input: exec.arguments`，原样（`index.ts:340`） | `tool_input: { command }`，只取 `command` 参数，其余全丢（`index.ts:324`） |
| 环境变量 | 注入 `CLAUDE_PROJECT_DIR`（`index.ts:151`） | **什么都不注入**（`index.ts:141`–`:149` 的 `runHook` 调用没有 `env`） |
| 工作目录 | 会话工作区 `session.header.cwd`（`index.ts:147`） | 同左（`index.ts:128`） |

Codex 的 `tool_input: { command }` 是个真实的信息损失：非 shell 工具的参数根本到不了你的 hook（`hooks-codex/README.md:96`）。而 `tool_name` 是真名，与 matcher 测的是同一个值。

hook 进程本身走 `ctx.shell`（`inject = ['shell']`，`index.ts:42`），因此吃到执行器的凭据擦洗、进程组 kill 和超时机制；桥的 env 是在擦洗**之后**合并的（`hook-protocol/README.md:23`）。

## 6. 从退出码到 typed Decision

```
hook 进程
  ├ exitCode ─┐
  ├ stdout ───┼──► parseHookOutput()          codec.ts:59
  └ stderr ───┘         │
                        ▼
                   HookOutput（方言中性，字段全可选）types.ts:89
                        │  同一拦截点上每个命中的 hook 各产出一个
                        ▼
                   mergeHookOutputs()          merge.ts:62
                        │
                        ▼
                   MergedHookOutcome ──► 桥自己的 map ──► PreToolDecision /
                                                        PreStepDecision /
                                                        PostToolDecision /
                                                        agent.steer()
```

退出码规则（`codec.ts:59`）：

| exitCode | 结果 |
|---|---|
| `0` | 干净退出。stdout **以 `{` 开头**才尝试 JSON（`codec.ts:75`）；JSON 坏了就当纯文本，不报错 |
| `2` | 阻塞。`decision = 'block'`，trim 后的 stderr 成为 `reason`（`codec.ts:66`） |
| 其它 | 非阻塞错误，只留在记录里 |
| `undefined` | 进程被信号打死（`runner.ts:91`），或执行器基础设施故障 —— `runHook` **永不抛**，转成一条无 exitCode 的非阻塞错误（`runner.ts:96`） |

结构化 stdout 有**两条互不相同的 decision 通道**，这是最容易配错的地方：

- 顶层 `decision` 合法值**只有** `approve` / `block`。写 `{"decision":"deny"}` 会被当无效值**静默忽略**（`codec.ts:38`）。
- 精细权限走 `hookSpecificOutput.permissionDecision`，合法值 `allow` / `deny` / `ask`（`codec.ts:43`），并且**覆盖**顶层 decision（`codec.ts:126`）。

`hookSpecificOutput` 还有一道守卫：桥每次都传 `expectedEventName = point`（CC `index.ts:172`、Codex `index.ts:148`），块里的 `hookEventName` 对不上（或没写）时，**只丢弃事件域字段**（`permissionDecision` / `permissionDecisionReason` / `additionalContext` / `updatedInput`），顶层字段和那个声明值仍保留下来进日志（`codec.ts:120` 记下声明值，`:122` 提前 return）。所以给 `PreToolUse` 写的 hook 里 `hookEventName` 拼成 `PreToolUSe`，表现是「exit 0、一切正常、决定就是没生效」。

合并后的 `decision` 到各点的映射：

| merged.decision | pre-step | pre-execute | post-execute | turn-stopping |
|---|---|---|---|---|
| `deny` | `{ kind: 'reject' }` | `{ kind:'deny', reason }` | `{ kind:'block', feedback }` | `agent.steer(reason)` |
| `ask` | — | CC：`{ kind:'ask' }`；Codex：无此路径 | — | — |
| `allow` / `none` | `next()` | `next()` | `next()` | 不动 |

注意 `allow` 那一格：桥**从不返回** `PreToolDecision` 的 `{ kind: 'allow' }`（该分支确实存在，`packages/core/tools/src/index.ts:589`），只是 `return next()` 继续往下走。也就是说 CC hook 里的 `permissionDecision: "allow"` **不能预先批准**、跳不过后面的 guard 和审批（`hooks-claude-code/README.md:92`）。

无 reason 的兜底文案（`index.ts:241`、`:252`、`:274`）：`blocked by PreToolUse hook`、`blocked by PostToolUse hook`、`continue: blocked by Stop hook`。

## 7. 多个 hook 命中时怎么合并

同一个点上命中的 hook **串行执行、按配置顺序**（`index.ts:152` 的双层循环里 `await`），然后一次性折叠（`merge.ts:62`）：

| 维度 | 规则 |
|---|---|
| 权限 | 取最严：`deny`/`block` (3) > `ask` (2) > `approve`/`allow` (1) > 无 (0)（`merge.ts:35`） |
| reason | **只收胜出档位的**理由，多条用 `\n\n` 连接（`merge.ts:74`、`:91`、`:94`）—— 有人 deny 时，ask 的理由不会混进去 |
| `continue:false` | 首个置位后黏住，`stopReason` 取第一个（`merge.ts:79`） |
| `additionalContext` | 全部按顺序累积成数组，不合并字符串（`merge.ts:83`） |
| `systemMessage` | 同上累积（`merge.ts:86`），但**两个桥都只打 warn，不呈现给模型**（CC `index.ts:178`、Codex `index.ts:161`） |

串行不是性能疏忽，是为了让每个 hook 的 `hook/invoked`/`hook/result` 在日志里相邻；而且折叠对决定本身是**顺序无关**的（`hooks-claude-code/README.md:49`）。代价写在 README 里：Claude Code 原生是并行跑且对相同 handler 去重的，桥两样都没有（`hooks-claude-code/README.md:97`）。

## 8. `hook/*` 会话事件

两个日志专用事件，声明合并进 `SessionEventMap`（`hook-protocol/src/types.ts:19`、`:31`），也收录在 `docs/persistence-catalog.md:427`：

| 事件 | 字段 |
|---|---|
| `hook/invoked` | `turn` / `point` / `dialect`（`claude-code` \| `codex`）/ `matcher`（全匹配时省略）/ `handlerId` |
| `hook/result` | `turn` / `point` / `handlerId` / `decision` / `exitCode?` / `stderrSummary?` / `durationMs` |

`handlerId` 形如 `claude-code:<point>:<序号>`，序号来自一个**进程内全局自增**的计数器（`hooks-claude-code/src/index.ts:81`–`:84`，Codex 同构在 `:67`–`:70`），所以它只保证一对 invoked/result 能配上，不是「这个点的第几次」。

`decision` 字段的取值规则在 `events.ts:99`：有解析出的 decision 就用它，否则 `continue:false` 记成 `stop`，再否则记 `pass`（`hook-cc-posttool-context/session.jsonl:22` 那条只吐 context 的 hook 记的就是 `"decision":"pass"`）。`stderrSummary` 空则省略、超长截断加省略号（`events.ts:64`）。

有一条**运行时不变量**在盯着这对事件（`hook-protocol/src/invariant.ts`）：两条记录必须落在**已开启的 turn 内**（`:37`）、turn 号必须和当前开启的一致（`:38`）、`hook/result` 必须能找到配对的 `hook/invoked`（`:52`）、`durationMs` 必须是非负有限数（`:55`）。违反就 fail。

推论：**detached 的那几个点不会有 `hook/*` 记录**。桥只在 `opts.turn !== undefined` 时才写这对事件（`index.ts:157`、`:181`），而 `SessionStart` / `SubagentStart` / `SubagentStop` 三个调用都没传 turn（`index.ts:207`、`:284`、`:294`）—— `SessionStart` 的理由 `hook-protocol/README.md:32` 写得很清楚：它在第 1 个 turn 之前跑，没有开启的 turn 可挂。想知道 SessionStart hook 跑没跑，只能看它注入的那条 context 消息（source 是 `{ kind: 'plugin', plugin: 'hooks-claude-code' }`，`index.ts:87`，所以不会被误当成用户输入）。

## 9. 桥相比原生插件丢了什么

README 自己列得很完整，挑最会咬人的：

| 能力 | 原生插件 | 桥 |
|---|---|---|
| 事件覆盖 | 全部拦截点 | CC：30 个里支持 7 个（`hooks-claude-code/README.md:89` 列出未支持的 23 个）；Codex：10 个里支持 5 个（`hooks-codex/README.md:93`）。两个基线数字都是 README 引外部文档说的，见第 11 节 |
| 预批准工具 | `{ kind: 'allow' }` 可返回 | 不返回，`allow` 只是不拦 |
| 改写工具输出 | `PostToolDecision.accept` 带 `content`/`value`（`tools/src/index.ts:598`） | 不支持 `updatedToolOutput`；`tool_response` 被压平成纯文本 |
| 改写工具入参 | 全仓库都还没有（`PreToolDecision` 明确排除了改写，`tools/src/index.ts:585`；`updatedInput` 只解析不生效，`hook-protocol/README.md:44`，设计仍在 proposed 状态） | 同左。CC 桥还会为此打一条 warn（`index.ts:176`），Codex 桥连 warn 都不打 |
| `systemMessage` | 自己决定怎么呈现 | 只 warn，模型看不到 |
| `{"continue": false}` | 自己实现 | **只记录，不停止运行**（源码里挂着 `TODO(hook-continue-false)`，CC `index.ts:189`、Codex `index.ts:172`） |
| Stop 循环护栏 | 自己写计数 | 没有。`stop_hook_active` 恒为 `false`（CC `index.ts:346`、Codex `index.ts:261`），**无条件阻塞的 Stop hook 会让每一步都被强制续跑**（`TODO(stop-loop-guard)`，`index.ts:269`）—— 官方 fixture 才要用 `.stop_fired` 标记文件自限（`hook-cc-stop-continue/workspace/hooks.json:6`） |
| 配置发现 | `cordis.yml` 四层叠加 | 一个进程级 `configPath`，读一次，无分层、无热重载 |
| 并发与去重 | 随便 | 串行、不去重 |

结论很朴素：**桥是迁移用的**。已有 hooks.json → 先桥起来跑通；真要长期维护的策略 → 改写成第 13 章那样的原生插件。

## 10. 一份能直接用的最小配置

以下两段可直接落盘。`hooks.json` 是把 `hook-cc-pretool-deny` 与 `hook-cc-posttool-context` 两份仓库 fixture（`examples/acp-agent/tests/snapshots/*/workspace/hooks.json`）**逐字合并**进一个文件，没有改动任何 matcher 或文案 —— 这样你看到的输出就能跟快照里已提交的期望输出对上。

`/Users/you/project/.claude/hooks.json`：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          { "type": "command", "command": "echo 'bash is disabled by policy in this session' >&2; exit 2" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          { "type": "command", "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"Note: command output has been verified against the audit log.\"}}'" }
        ]
      }
    ]
  }
}
```

`$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: hooks-claude-code
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /Users/you/project/.claude/hooks.json
        projectDir: /Users/you/project
        defaultTimeoutMs: 600000
```

装包 + 启动：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code
dsh web
```

按快照推断应该看到：让模型跑任何 bash 命令，工具结果是 `Error: bash is disabled by policy in this session`；会话日志里出现一对 `hook/invoked` + `hook/result`（后者 `decision: "block"`、`exitCode: 2`），即 `hook-cc-pretool-deny/session.jsonl:21`–`:23`。把 `PreToolUse` 那组删掉再试，则 bash 正常执行，`hook/result` 记 `"decision":"pass"`，那句 `Note: command output has been verified against the audit log.` 以 `{"kind":"plugin","plugin":"hooks-claude-code"}` 的身份进 inbox 再变成一条 user 消息（`hook-cc-posttool-context/session.jsonl:22`、`:24`、`:28`）。

Codex 侧结构对称：换成 `@deepseek-ai/dsh-hooks-codex`、另起一个 `codex-hooks.json`（**不要复用 CC 那份**，matcher 语义不同），配置里 `pluginRoot`/`projectDir` 换成 `model`。注意语义不完全对称：Codex 没有 `ask`，`tool_input` 只剩 `{ command }`，也不注入任何环境变量。

## 11. 本章未确认

- ⚠️ **我没有运行过任何东西。** 本章所有「会看到什么」来自源码逐行阅读，加上仓库里**已提交的**快照期望输出（`examples/acp-agent/tests/snapshots/**/session.jsonl`），不是当场跑出来的。
- ⚠️ `packages/hooks/hooks-claude-code/README.md:77`（Codex 侧同一句在 `hooks-codex/README.md:81`）声称提示词被拦时的兜底文案精确为 `blocked by UserPromptSubmit hook`，但 `PreStepDecision` 的 reject 分支**不带 reason 字段**（`packages/core/agent/src/runtime-types.ts:53`），两个桥返回的都是裸 `{ kind: 'reject' }`（`hooks-claude-code/src/index.ts:224`、`hooks-codex/src/index.ts:211`）。这串文案在全仓 `.ts` 里搜不到，只出现在两个桥 README 的中英四份文件里 —— 我无法在代码中确认它。
- ⚠️ 「Claude Code 当前共 30 个 hook 事件」「Codex 当前共 10 个」这两个基线数字来自两份 README（`hooks-claude-code/README.md:89`、`hooks-codex/README.md:93`）引用的官方文档链接；我没有访问外部网页核对，也无法确认它们在 2026-08-14 是否仍然成立。
- ⚠️ `hooks-claude-code/README.md:91` 说 Claude Code 原生给 `UserPromptSubmit` 的专用超时是 30 秒（桥统一用 600 秒）；这个 30 秒是 README 转述的外部产品行为，dsh 代码里没有对应实现可核对。
- ⚠️ `dsh plugin --profile web add ...` 装一个非 bundle 包时「保留为普通依赖并打一次性 warning」的行为，代码路径是清楚的（`apps/cli/src/plugin.ts:44` 的判据 + `:71` 的 `process.stderr.write`），文字描述在 `apps/cli/reference/README.md:43`，但我没有实际执行验证；peer 依赖靠 hoisted 回落解析这条同样只读了 `packages/boot/app-boot/src/profile.ts:133` 的注释，没跑过 `pnpm`。
