# plan-mode

> `@deepseek-ai/dsh-plan-mode` · bundle：`base` · 配置树 id：`plan-mode` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

> ⚠️ **本篇未通过对抗式引用核验**：起草已完成，但逐条打开源码比对行号/字段名/英文引文的那一遍因会话额度耗尽未执行。文中 `path:line` 与配置字段请以源码为准，核验后本行会被移除。

**一句话**：把「计划模式」做成一条从会话日志折叠出来的 per-agent 状态——开着时往系统提示插一段部署方写死的 guidance，靠 `exit_plan_mode` 走人工审批退出；它只劝导，不强制。

README 开门见山就把边界划清了：`Plan mode is soft guidance; sandbox mode and approval policy enforce restrictions independently and do not read or write plan state.`（`packages/plan/plan-mode/README.md:5`）。真正拦得住写操作的是 sandbox 和 approval，不是这个插件。

## 它在树上长什么样

```yaml
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
              You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.
```

`packages/bundle/base/cordis.patch.yml:265-279`。`section` 在 YAML 里是个 7 段的块标量，上面只贴了第 1 段（269 行）；其余 6 段分别讲「先探查、别改文件」「工具目录跨模式不变，这些规则压倒后面任何鼓励用变更工具的说明」「能查的别问用户」「计划要 decision-complete」「exit_plan_mode 必须是那一轮唯一且最后一个工具调用」。

这一行**没写 `inject`**：依赖声明在源码里，`static inject = ['tools', 'systemPrompt']`（`packages/plan/plan-mode/src/index.ts:185`）。

`web-app` bundle 在宿主平面把它关掉（`packages/bundle/web-app/cordis.patch.yml:348-349`，`disabled: true`），改由各个 agent preset 自己挂一份，配置文案略有差异（`apps/cli/config/agent-presets/code/agent.cordis.yml:117-125`）。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.planMode`（`PlanModeController`） | `src/index.ts:184`；只有 `get(agent)` / `set(agent, active)` 两个方法 |
| 事件监听 | `agent/pre-step`（**waterfall**） | `src/index.ts:205`。先 `await next()` 跑完下游，只有下游 accept 了这一步才把挂起的 `plan/mode` 落日志，并可能往 `decision.messages` 追加一条切换通知（`src/index.ts:209-221`） |
| 会话事件 | `plan/mode`（`{ active: boolean }`） | `src/index.ts:46-55`；log-only、非 surface、整值替换，last-write-wins |
| prompt 段 | `plan:policy`，order **50** | `src/index.ts:225-233`；非激活态返回空串，不产生任何 token |
| 工具 | `exit_plan_mode` | `src/index.ts:305`；无论开关都注册，保证工具目录跨模式不变 |
| 命令 | `/plan [off\|message]` | `src/index.ts:269-303`，仅当 `ctx.commands` 已挂载 |
| projection unit | `plan` → `{ active, pending }`，`stateVersion: 1` | `src/index.ts:244-266`，仅当 `ctx.sessionProjections` 已挂载 |
| 伴生插件 | `./invariant`（`plan-mode-invariant`） | `src/invariant.ts:20-26`，只校验 `plan/mode.active` 是不是 boolean；默认 bundle 的 patch.yml 里没有这一行 |

`agent/pre-step` 的 waterfall 派发方与消费方名单见 `docs/event-producer-consumer.md:18`。派发模式的通用讲法见 [10 章 waterfall 专章](../10-waterfall专章.md)。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `section` | `string` | **无默认，必填** | 激活时渲染成 `plan:policy` 段的原文 |

`resolveConfig`（`src/index.ts:106-119`）在插件加载期就把非字符串、空白串、以及任何多余 key 抛错，不做静默忽略。README:38 原文：`section is required and non-empty. Unknown keys fail at load. The package does not accept arbitrary named modes, tool filters, sandbox settings, or approval policy.`

## 状态什么时候真正落日志

`set(agent, active)` 的四种返回值（`src/index.ts:425-445`）：

| 返回 | 触发条件 |
|---|---|
| `committed` | 日志里没有未闭合的 turn（idle），当场 `session.append('plan/mode', …)` |
| `queued` | turn 开着，选择挂起，等下一个被接受的 in-turn pre-step |
| `cancelled` | 撤销了一个反向的挂起选择，日志态本来就对 |
| `noop` | 目标态等于当前态或已挂起态 |

`hasOpenTurn`（`src/index.ts:158-165`）是那个 idle 判据：agent 的 status 在 post-turn checkpoint 期间仍是 `running`，所以不能用 status 判断。

## 模型看得见什么

- **激活时**：order 50 位置多出 `section` 全文；非激活时一个 token 都不加（README:48、58）。
- **`exit_plan_mode` schema 常驻**：README:82 原文 `The stable schema is available in both states` 的对应表述是 `remains available in both states; execution outside plan mode fails`。批准时返回 `{ approved: true }`，渲染成 `Plan approved — plan mode exited; carry out the plan starting with your next step.`（`src/index.ts:319`）。
- **拒绝 = 失败调用**：`The user chose to keep planning; revise the plan and present it again.`，带反馈时换成 `The user chose to keep planning; their feedback: <feedback>`（`src/index.ts:372-374`）。
- **用户中途关掉审批框**去说别的（`ASK_CANCELLED`），单独报 `The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.`（`src/index.ts:357-359`）——README:17 特意解释了为什么不能复用通用消息：那条消息会提到模型压根没调过的 `ask_user_question`。
- **`/plan` 命令本身不进模型历史**（README:68）；`/plan xxx` 的 `xxx` 会经 `agent.steer()` 变成下一步一条普通的 user 文本块（`src/index.ts:294`）。
- **切换旁白**：只有当「上一条 `request/header` 描述的是另一个模式」时才追加一句 `The user switched this session to plan mode.` / `The user switched this session back to the default mode.`（`src/index.ts:463-474`），避免重复告知。

默认 `section` 里有两条跟同组插件直接相关的硬话（`packages/bundle/base/cordis.patch.yml:273`）：`Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.` —— 也就是说 [tool-todo](./dsh-tool-todo.md) 的 `todo_write` 在计划期是被提示层显式禁用的。同一段还写明 `The tool catalog stays the same across modes for request-cache stability.`，这是为什么 `exit_plan_mode` 不激活也注册。

## 什么时候你会想换掉它 / 怎么换

- **只想改文案**：覆盖 `section` 即可，这是唯一配置面。preset 各自挂一份就是这个用法。
- **想让它真能拦住写操作**：换不了——README:94 明说 `Plan mode guides rather than enforces`。要硬拦得去配 sandbox（`docs/subsystems/sandbox.md`）和 approval（`docs/subsystems/approval.md`），那两套不读也不写 plan 状态。
- **想整个关掉**：patch 里写 `- id: plan-mode` + `disabled: true`，web-app bundle 就是这么干的（`packages/bundle/web-app/cordis.patch.yml:348-349`）。关掉之后 `exit_plan_mode` 和 `/plan` 一起消失，`plan` projection key 缺席——`src/types.ts:11-17` 明确 `Capability absence (plan-mode not composed) is the key's absence, never a value.`
- **想加多个命名模式 / 工具过滤**：这个包不收（README:38），得另写插件。

## 坑与边界

README:94-98 的 Known Limitations 逐条：

- 只劝不拦（见上）。
- **turn 最后一个被接受的 pre-step 之后做的选择，如果进程先退出就丢了**，UI 必须重新应用一次。
- fork 出来的 agent 继承日志里的 plan 态，**新 spawn 的 agent 一律 inactive**，创建时没有 plan 选项。
- 别人家的 live child **打不开 `exit_plan_mode` 审批**，失败消息会让它把未决决策写进最终结果；但仅靠 fork 血缘不能阻止一个被 resume 成 runtime root 的会话去开审批。
- **只有 Web UI 有专门的 `plan-review` 渲染器**，别的交互 provider 会退化成通用选项流。`intent: { kind: 'plan-review', approve: APPROVE_LABEL }`（`src/index.ts:347`）纯粹是呈现意图，两种渲染下工具读到的答案一样。

读源码另外发现的：

- 审批期间插件被 HMR 卸载会失败并要求重新提交（`the plan-mode service was reloaded while the plan was under review; present the plan again`，`src/index.ts:366`）——因为没有 pre-step 监听器就永远追加不了那条 `plan/mode`。
- 计划正文必须以 `# ` 开头，正则 `/^#\s+\S/` 卡在 `src/index.ts:327`；只有 `##` 不行。
- `pendingIntents` 是 `WeakMap<Session, …>`（`src/index.ts:195`），进程内状态，不落盘——这正是上面「进程退出就丢」那条限制的来源。
- 批准退出时写的是 `{ active: false, narrate: false }`（`src/index.ts:379`），所以退出不产生旁白：工具结果自己已经说了。

## 未确认

- ⚠️ `docs/subsystems/plan.md:17` 说这是 `a prepended agent/pre-step listener`，但 `src/index.ts:205` 的 `ctx.on` 没传任何 prepend 参数。它靠「先 `await next()` 再动手」达到同样效果，注册顺序上是否真的前置没在源码里确认。
- ⚠️ `docs/event-producer-consumer.md:41` 把 plan-mode 列为 `session/created` 的消费方，源码里这个监听只出现在 `src/invariant.ts:34`（伴生插件），主插件没有。默认树是否挂了那个伴生插件，没在 bundle 的 patch.yml 里找到对应行。
