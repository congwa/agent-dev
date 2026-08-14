# session

> `@deepseek-ai/dsh-session` · bundle：`base` · 配置树 id：`session` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：事件溯源的会话日志与内存 store（`ctx.sessions`），append-only 的 `SessionEvent` 序列是整段交互史的唯一事实源，发给模型的 message 历史是从它**派生**出来的，而不是它本身。

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:27`：

```yaml
- id: session
  name: '@deepseek-ai/dsh-session'
```

没有 `inject`、没有 `config`——这是整棵树的地基。它**故意不实现持久化**：落盘、检索、投影全部由订阅它事件的插件完成（`packages/core/session/README.md:11`）。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.sessions`（`SessionStore`） | `packages/core/session/src/index.ts:792`、`797` |
| typert lookup | `session` | 在 `ctx.inject(['typert'])` 子上下文里注册，把 wire 上的 `sessionId` 解析回宿主侧 `Session` 对象（`src/index.ts:798`–`806`） |
| 事件（派发方） | `session/created`（**emit**） | 发布会话时同步宣告；监听器同步 throw 可以否决并回滚出配对的 disposal，返回的 Promise 拒绝只记日志、无法追溯否决（`src/index.ts:54`；模式见 `docs/event-producer-consumer.md:41`） |
| 事件（派发方） | `session/disposed`（**emit**） | 已宣告的会话离开 store 时恰好一次，含发布回滚路径（`src/index.ts:64`；`event-producer-consumer.md:42`） |
| 事件（派发方） | `session/event`（**emit**） | 提交后的 append 通知，fire-and-forget；监听器失败被逐个容纳，不会让已提交的 append 失败（`src/index.ts:76`；`event-producer-consumer.md:43`） |
| 事件（派发方） | `session/flush`（**parallel**，awaited） | 耐久性检查点：每个监听器都启动、调用方 await 全部 settle，**没有 waterfall 否决**（`src/index.ts:85`；`event-producer-consumer.md:44`） |

四个事件都是 scope-filtered 派发，但两种口径：`session/created` 与 `session/event` 是 agent 作用域过滤——该作用域的监听器只收到经这个 agent 上下文进入的会话/事件（`src/index.ts:48`–`49`、`69`–`70`）；`session/disposed` 与 `session/flush` 复用会话自己的 owner scope（`:59`、`:79`–`80`）。

本包不注册任何工具、命令或 prompt 段。

主要 API（`README.md:15`–`19`）：`create(id?, {seed?, meta?})` / `flush(session)` / `fork(source, boundary?, childSessionId?)` / `get(id)` / `list()`。需要与别的资源做有序拆卸时另有 `prepare` + `enter` + `announce` 三段式（`README.md:25`–`27`），`dsh-agent-loop` 用它保证 loop 的最后一次 flush 早于会话摘离。

`Session` 实例侧关键面：`append()` 同步提交并冻结事件；`deriveMessages()` 增量投影 surface 得到模型可见历史；`surface` 是有序投影视图，每次落地的 rewrite 都会改变 `replaceGeneration`；`header` 是一次写入、深冻结的创建元数据（`README.md:39`–`45`）。

## 配置项

无配置项。行为完全由调用方给的 `create/fork` 参数、以及订阅它的插件决定。日志格式版本常量 `SESSION_FORMAT_VERSION = 0`（`packages/core/session/src/types.ts:56`）不可配。

## 模型看得见什么

README 的 Model Experience 恰好三块（`README.md:95`–`137`）：

**一、派生 message 历史（`README.md:97`–`109`）**

- 模型逐字收到 `user/message`、`assistant/message`、`tool/result` 三类 surface entry 里的完整 message，身份/角色/source/content block 都是创建时那份值，投影层不铸造新身份；工具调用长在 assistant message 里面。chunk、边界、usage、hook 记录、todo 记录等 log-only 事件不产生任何 message。
- token：已 append 的 surface entry 在后续 step 会被重发；`replace` 这种 surface 操作把被遮蔽的条目移出未来输入，但不删除底层 raw log。
- KV Cache：append 保留可复用前缀；一次 `replace` 会从**第一条被遮蔽的 message** 起让复用失效——即便事件日志本身仍是 append-only。

**二、崩溃修复结果（`README.md:111`–`123`）**

恢复时若发现 assistant 请求了工具却没有耐久的 `tool/call`，补一条 `TOOL_NOT_STARTED`，原文是 `The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.`；若有 `tool/call` 无结果，补 `TOOL_OUTCOME_UNKNOWN`，要求模型只在只读或幂等时重试，有副作用则先核验外部状态或问用户。两条文案由本包拥有（`src/repair.ts:104`–`105`），[session-checkpoint-policy](./dsh-session-checkpoint-policy.md) 只负责把 call 记耐久。完好会话零 token；修复结果追加在可复用前缀之后，不使更早的 KV 条目失效。

**三、已记录的 request header（`README.md:125`–`137`）**

会话能重建 loop 当时真正发出去的 system prompt、工具 schema、call config 与会话前缀。header 事件**不会**在 message 历史里多出一份拷贝——前缀是在 `deriveMessages()` 之外拼上去的，所以记录本身零重复 token、零失效；只有后续 header 换了前缀/prompt/schema 才会从第一处差异起让复用失效。

## 什么时候你会想换掉它 / 怎么换

**换不掉。** 它是 `ctx.sessions` 的唯一实现（全仓只有 `src/index.ts:797` 一处 `super(ctx, 'sessions')`），agent loop、工具管线、持久化、投影全部直接依赖它；`docs/config-catalog.md:3077` 把它列在「Loadable plugins with no config」小节里，且不带任何 `Requires:` 子句。

真正可选的是它的伴生插件 `@deepseek-ai/dsh-session/invariant`（插件名在 `packages/core/session/src/invariant.ts:18`，`inject = ['invariants']` 在 `:20`）：注册单调 seq、turn/step 包含关系、同 step 内 tool call/result 配对这三类关系不变量，加载或热重载时会回放已有会话（`README.md:7`）。三个 bundle 都没有 `invariants` 行，所以默认不生效——想开就自己插一行 `@deepseek-ai/dsh-invariants` 再插伴生行。

要改的其实是它周围的行：换落盘后端见 [session-persistence-jsonl](./dsh-session-persistence-jsonl.md)，换耐久时机见 [session-checkpoint-policy](./dsh-session-checkpoint-policy.md)，加派生读模型见 [session-projection](./dsh-session-projection.md)。

## 坑与边界

来自 `README.md:139`–`144`：

- **没有会话树/分支**（pi 风格 entry tree）——除非 `fork()` 的边界切法不够用，否则不做。
- **`fork()` 只能切活会话的稳定边界**：所选前缀必须结束在 turn 之外，且源会话必须在 store 里；已持久化但未加载的会话不能 fork。
- **`SESSION_FORMAT_VERSION` 钉死在 `0`**：预发布，不承诺兼容。`Session` 只接受当前 seed 形状，后端遇到更新版本报 "written by a newer harness — upgrade"，更旧的版本目前没有升级路径。未知事件类型同样拒绝重建，除非信封里标了 `ignorable`。
- **`TurnEndReasonMap` 缺 ACP 的 `refusal` / `max_turn_requests`**——等第一个 adapter 或 loop 真的发出来再加。

读源码补充：`session/created` 的否决语义是同步边界，异步监听器里做校验是无效的（`src/index.ts:44`–`47`）；`session.events` 是随 append 失效的冻结快照缓存（`README.md:43`）。
