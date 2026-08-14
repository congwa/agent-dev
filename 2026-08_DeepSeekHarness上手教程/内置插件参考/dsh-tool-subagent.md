# tool-subagent

> `@deepseek-ai/dsh-tool-subagent` · bundle：`base` · 配置树 id：`tool-subagent`、`tool-subagent-fork` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

> ⚠️ **本篇未通过对抗式引用核验**：起草已完成，但逐条打开源码比对行号/字段名/英文引文的那一遍因会话额度耗尽未执行。文中 `path:line` 与配置字段请以源码为准，核验后本行会被移除。

**一句话**：模型可见的委派工具，一个插件实例绑定一个 `ctx.subagents` provider 和一个工具名；换 provider 只换传输，不换执行契约。base 装了两份。

## 它在树上长什么样

```yaml
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: one-shot
```

`packages/bundle/base/cordis.patch.yml:313-318` 与 `:324-329`。第二行上方那段注释解释了 fork 为什么保持 one-shot：可续子的 `report` 工具与 prompt 段排在「fork 存在就是为了复用的那段继承历史」之前，一次性 fork 子两样都不装，父的请求前缀得以保留。模块导出 `export const inject = ['tools', 'subagents', 'systemPrompt']`（`packages/subagent/tool-subagent/src/index.ts:23`）。

web-app bundle 把这两行都 `disabled: true`（`packages/bundle/web-app/cordis.patch.yml:380-384`）：registry 和后端留在 host plane，preset 自己决定它的 agent 看见哪些委派工具。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 工具 | `config.toolName`（默认 `subagent`） | 只在其 provider 存在期间注册，`src/index.ts:297` |
| prompt 段 | `tool:<toolName>`（order 116.5） | 仅 `backgroundMode: continuable` 且开了后台时注册，`src/index.ts:26`、`:455-466` |
| 事件（收） | `subagent/provider-added`（emit） | provider 出现即挂载工具，`src/index.ts:440-442` |
| 事件（收） | `subagent/provider-removed`（emit） | provider 消失即卸载工具，`src/index.ts:443-447` |

两个监听都是 `emit`，**不是 waterfall**，它不拦截任何调用。之所以要跟着 provider 生命周期走，是因为 Cordis 可能并发加载兄弟插件，配置顺序不证明注册顺序；provider 尚未注册时会打一行 `logger.info` 并等待（`src/index.ts:448-454`）。

工具描述文案随 `provider.inheritsParentContext` 变（`src/index.ts:211-236`）：fresh 子的文案是「it does not see this conversation」，fork 子则是「a child agent seeded with all completed turns so far」——对 fork 说前一句是**假的**，所以这段分支是必需的。

三条执行路线（`src/index.ts:369-430`）：

| 路线 | 触发 | 返回 | 渲染 |
|---|---|---|---|
| 前台 | `run_in_background` 解析为 false | `{ kind: 'foreground', runId, output }` | 子的最终文本 |
| 一次性后台 | `backgroundMode: one-shot` 且显式 `true` | `{ kind: 'background', jobId }` | `started background subagent task <id>` |
| 可续后台 | `backgroundMode: continuable` 且省略或 `true` | `{ kind: 'continuable', subagentId }` | `started subagent <childId>` |

前台路线一定 `await run.dispose()`；非 `completed` 的 stop reason 变成 errored 结果，并把子保住的**部分输出**接在 headline 后面（`withPartialText`，`src/index.ts:149-155`），所以截断的答案既不会被当成成功，也不会被静默丢掉。可续路线在 inbox 接受时就 resolve，此后子自己拥有 turn，这次调用既不等待也不收集结果。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `provider` | `string` | 必填 | `ctx.subagents` 上的 provider 名 |
| `toolName` | `string` | `subagent` | 模型看到的工具名，每个实例必须不同 |
| `enableRunInBackground` | `boolean` | `true` | 关掉则省略参数，并拒绝强制后台调用 |
| `backgroundMode` | `'one-shot' \| 'continuable'` | `one-shot` | 同时决定后台路线和 `run_in_background` 省略时的默认值 |
| `agentOptions` | `{ provider, model, maxTokens }` | 省略 | 子的 provider/model/正整数 maxTokens；进程内 provider 视其为对继承值的覆盖 |
| `persona` | `string` | 省略 | 每子 persona，需要 provider 的 `persona` 能力 |
| `toolFilter` | `{ allow?, deny? }` | 省略 | 每子全局工具限制，需要 `toolFilter` 能力 |
| `maxDepth` | `number \| 'provider-managed'` | `3` | 绝对委派深度上限，`0` 完全禁止委派 |

Schema 在 `src/index.ts:81-99`。三处 fail-loud：`toolFilter` 写了但 `allow`/`deny` 都空 → apply 直接抛（`:272-274`）；数值 `maxDepth` 遇上没有 `depthLimit` 能力的 provider → **mount 时**抛，而不是等第一次委派（`:285-290`）；`continuable` 遇上没有 `prepareContinuable` 的 provider → mount 时抛（`:292-296`）。

## 模型看得见什么

默认 schema 是 `description` + `prompt`，开了后台再加 `run_in_background`。可续实例的描述里明确写着「runs in the background by default」「the runtime sends the parent a notice containing its outcome and any final assistant message」「`send_message` starts a later turn in the same child conversation」；一次性实例则写「This call waits for the result by default」「collect with `job_output` and stop with `job_kill`」。

可续实例还额外贡献一段 `tool:<toolName>` 系统 prompt（order 116.5，`src/index.ts:459-465`），要求模型把独立的委派放在同一条 assistant 消息里一起发起、在它们跑的时候继续干活、只有下一步动作依赖结果时才设 `run_in_background: false`。工具不可见时这段文本为空串，渲染时会被略去。

结果本身在父历史里都是**只追加**的：后台路线只留一行确认；可续子的输出永远不从这个工具返回，而是通过 [subagent 服务自己的结算通知](./dsh-subagent.md) 到达父那边。

## 什么时候你会想换掉它 / 怎么换

- **换传输**：改这一行的 `provider`，或新增一行绑到 `-acp` / `-codex` / `-claude-code` / `-dsh-sdk`，配一个不同的 `toolName`。
- **收紧子权限**：给这一行加 `toolFilter` 或 `persona`；注意这不是从父继承下来的授权天花板。
- **禁止递归**：`maxDepth: 0`。工具仍然可见，每次启动时检查调用方当前深度并返回 errored 结果，由运行时策略负责拒绝。
- **想让 `subagent` 也变回前台默认**：把 `backgroundMode` 改成 `one-shot`，同时那段 `tool:subagent` prompt 也会随之消失。

## 坑与边界

- **后台 run 不通过本工具暴露结果**——一次性任务的最终输出要走通用 task 面收集，可续子的输出留在它自己的 session 里，按 subagent id 读。结算通知说明它是怎么结束的、带上最后一条 assistant 消息，但那不是本次调用的返回值，也没法在这里 await。
- **等待中的一次性实例重名检测太晚**（`TODO(subagent-dup-toolname)`，`src/index.ts:436-439`）——可续实例在 apply 期就抢占 prompt 段名字因而更早失败；两个同名的等待中 one-shot fiber 要等 provider 出现才碰撞，重名抛出会回滚 provider 注册。
- **子策略按实例固定**——换 model、persona、工具过滤或深度上限，只能再开一个名字不同的工具。
- 并发是安全的：子在自己的 session 里工作，run 从不改父 session，唯一一次父侧写入（注册 Task）是同步、可交换的插入，所以重叠的后台调用按 dispatch 竞争顺序拿到 job id（`isConcurrencySafe: () => true`，`src/index.ts:368`）。
- 一次性后台路线需要 `ctx.jobs`，缺了会抛 `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`（`src/index.ts:400-403`）。base 里 `jobs` 在 `packages/bundle/base/cordis.patch.yml:69`、`tool-jobs` 在 `:218`。
