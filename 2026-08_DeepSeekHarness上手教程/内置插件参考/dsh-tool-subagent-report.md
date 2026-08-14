# tool-subagent-report

> `@deepseek-ai/dsh-tool-subagent-report` · bundle：`base` · 配置树 id：`tool-subagent-report` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

> ⚠️ **本篇未通过对抗式引用核验**：起草已完成，但逐条打开源码比对行号/字段名/英文引文的那一遍因会话额度耗尽未执行。文中 `path:line` 与配置字段请以源码为准，核验后本行会被移除。

**一句话**：给每个**可续的进程内子** agent 装上作用域局部的 `report` 工具和配套 prompt 段——子到父的返回通道，`ctx.subagents.reportFrom()` 的薄适配层。

## 它在树上长什么样

```yaml
    - id: tool-subagent-report
      name: '@deepseek-ai/dsh-tool-subagent-report'
```

`packages/bundle/base/cordis.patch.yml:332-333`，无 config，所以 `reportDelivery` 取默认 `wakeup`。上方注释一句话概括了它的定位：可选的直接子返回通道，root 和一次性 agent 身上都没有（`:331`）。模块导出 `export const inject = ['subagents', 'tools', 'systemPrompt']`（`packages/subagent/tool-subagent-report/src/index.ts:21`）——注册其实只经过 `childCtx.tools` 和 `childCtx.systemPrompt`，但把两个服务都声明出来是为了让 Loader 排序在**加载时**失败，而不是拖到下一次子物化才炸（`:18-20`）。

web-app **不禁用**这一行，理由写在 `packages/bundle/web-app/cordis.patch.yml:386-390`：它注册的是 singleton 上的一份 continuable setup，而不是本 agent 调用的工具，而且这个 setup 列表**不是 scope-aware** 的——每个挂载的 preset 各来一份，就会在第二个在线 session 上抛错。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| continuable setup 贡献 | 匿名 | `ctx.subagents.registerContinuableSetup(...)`，`src/index.ts:140-141` |
| 工具（子作用域） | `report` | `childCtx.tools.register(...)`，`src/index.ts:65-104` |
| prompt 段（子作用域） | `tool:report`（order 117） | `childCtx.systemPrompt.section(...)`，`src/index.ts:24`、`:54-62` |

**没有事件监听**（无 waterfall），也**没有全局工具**。root、一次性子、远端 provider 的子、兄弟作用域、以及无 agent 的工具执行，都永远看不到也执行不了它。

关键点：`report` 不接受收件人参数。`exec.agent` 就是发信方的精确在线 Agent，同时也是权限凭据，服务从该子持久的 `parentSession` 推出唯一收件人（`src/index.ts:98-101`）。成功返回的是父侧已接受消息的稳定 `MessageId`——**不是**读回执、不是 inbox 出现 id、不是父日志确认、不是 turn 完成回执、也不是持久化 flush。

安装体导出为 `installReportTool(childCtx, ctx, delivery)`（`src/index.ts:49-53`），返回一个同时撤销工具与 prompt 段的 disposer；生成工具目录用的就是这条路径，因为全局 registry 没法暴露一个作用域局部的 schema。注册失败会回滚已注册的 prompt 段，回滚也失败则抛 `AggregateError`（`:105-115`）。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `reportDelivery` | `'quiet' \| 'wakeup'` | `wakeup` | 每条被接受的 report 在父侧怎么调度 |

`src/index.ts:36-38`。`wakeup` 走 `parent.followup()`，恰好创建一个普通的后续父 turn 并唤醒停park的父 driver，**从不**改变进行中的 turn；它之所以是默认，是因为已经 park 的父没有别的理由回头看，安静投递会让一条已接受的 report 一直没人读。`quiet` 走 `parent.inject()`，只加模型可见上下文而不发起父的模型请求：父 idle 时追加在调用返回前就完成，父正在准入或运行时则暂存到下一个安全日志位置。这是**部署级调度策略**，模型 schema 无法逐次选择或覆盖。

## 模型看得见什么

- **子侧 schema**：一个必填 `output` 字符串。描述要求子在结束前 report 一次、说明 report 只到达启动它的那个 agent、且**不结束 turn**；还写着「A failed call may still have arrived, so do not blindly repeat it.」
- **子侧 prompt 段** `tool:report`：把这项义务放在 schema 之外重说一遍——那个 agent 共享你的 workspace，但不会自动收到你的 transcript、工具输出或推理，所以一句 "done" 什么也没给它；部分发现改变了它下一步该做什么时也要提前 report。这是 guidance 不是强制，机制上接受一轮里零次或多次调用，也没有任何运行时路径会拒绝一个从不 report 的子。
- **子侧结果**：`report accepted by the agent that started you as message <messageId>`。
- **父侧可见**：一条 user-role 消息，帧头 `Background subagent <child-id> reported:`（`packages/subagent/subagent/src/continuation.ts:638`）后跟子的原样 `output`，来源 `{ kind: 'subagent-report', senderSessionId: <child-id> }`。token 上是完整 `output` 加一行帧头，本包**不设上限**。

## 什么时候你会想换掉它 / 怎么换

- **要一个没有返回通道的子**：直接不加载这个包。README 明说这是唯一手段——作用域局部注册**刻意**扛过子的全局 `toolFilter`，好让委派的 allow-list 无法把唯一的返回通道摘掉。
- **不想让 report 唤醒父**：给这一行加 `config: { reportDelivery: quiet }`，代价是 park 住的父要等别的事把它叫醒才会读到。
- **只要父到子的方向**：那是独立的 [tool-subagent-control](./dsh-tool-subagent-control.md)；可续模式两个包都不依赖。

## 坑与边界

- **父已开始 host-owned 销毁时仍可能接受**——`AgentHandle.dispose()` 先取消、等静默、最后才卸作用域并离开 registry，中间没有「销毁已开始」的信号。这个窗口里被接受的 report 会追加进父的 transcript，但那个父在本进程里不会再对它做任何事。
- **接受弱于持久投递**——没有持久 mailbox、幂等键、投递回执、重试协议或恰好一次保证；一侧记录接受后进程挂掉，结果就是歧义的，外部重试可能造成重复 report。
- **quiet 暂存的 report 不能立刻重建**——接受返回了稳定 `MessageId`，但父 Session 要等待处理中的上下文到达普通日志边界后才能重建出帧化内容。
- **授予等下一个 Activation，撤销立即生效**——子已经 resident 之后再装这个包，`report` 和 guidance 要到它下一个 Activation 才有；卸载则立刻从 resident 子身上撤销。
- **嵌套 report 只往上走一层**——孙子只 report 给它的直接父，永远到不了顶层协调者，后者必须自己显式再 report 一次派生结论。
- **没有限流**——默认 `wakeup` 在嵌套子频繁 report 时会放大模型工作量；宁可容忍未读 report 的部署应选 `quiet`。
- 它也是 [fork provider](./dsh-subagent-fork-in-process.md) 至今不做可续子的直接原因：`report` 工具和它的 prompt 段排在继承历史之前，会作废整段前缀复用。
