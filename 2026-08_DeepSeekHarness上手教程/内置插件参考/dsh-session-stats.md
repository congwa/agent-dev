# session-stats

> `@deepseek-ai/dsh-session-stats` · bundle：`web-app` · 配置树 id：`session-stats` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：往会话投影注册表里加一个 `sessionStats` 单元，从整条日志折出轮次/步数与 LLM、工具、首 token、解码四类墙钟时间——**翻页和压缩都改不动这些数字**。

## 它在树上长什么样

```yaml
- id: session-stats
  name: '@deepseek-ai/dsh-session-stats'
```

出处 `packages/bundle/web-app/cordis.patch.yml:84-85`，上方注释：`Whole-log turn/step counts for the chat stats strip (the sessionStats projection key); the projection registry itself is a base-layer row.` 无 config、无 inject 行；包自己声明 `export const inject = ['sessionProjections']`（`packages/session/session-stats/src/index.ts:20`）。注册表 `session-projection` 本身是 base 层的行（`packages/bundle/base/cordis.patch.yml:126-127`），各形态都有；只有本行是 web-app 独有（其余 bundle 无此行），所以 `sessionStats` 这个 key 只在 Web 形态存在。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 投影单元 | `sessionStats` | `ctx.sessionProjections.register(sessionStatsProjectionDefinition)`（`src/index.ts:27-29`），`stateVersion: 1`（`src/projection.ts:182`） |
| 类型声明 | `SessionProjectionMap.sessionStats` | 唯一声明处 `src/types.ts:41-46`，字段文档在 `src/types.ts:22-39` |
| invariant | 包名占位 | 空实现：折叠是纯函数，wire payload 由注册表逐次 schema 校验，事件关系归 dsh-agent-loop（`src/invariant.ts:17-26`） |

**不注册 service、不监听任何事件、不注册工具或命令。** 它是 function plugin，只有一个 `apply`（`src/index.ts:27`）；投递（快照、变更流、历史尾页、`session/projection` 推送帧、会话列表行）全归投影 seam（`README.md:5`）。

## 配置项

无配置项。输出字段固定为八个（`src/projection.ts:172-181`）：

| 字段 | 含义 | 折叠自 |
|---|---|---|
| `turns` | 至少含一个已关闭 step 的不同轮次数 | `step/end` 的 `turn` 与 `lastTurn` 比对（`src/projection.ts:155-162`） |
| `steps` | 已关闭的 step 数 | `step/end` 计数——**不是** `assistant/message` |
| `llmMs` | 模型墙钟时间之和 | `step/start` → `assistant/message`（`src/projection.ts:126`） |
| `toolMs` | 工具墙钟时间之和 | `tool/call` → `tool/result`，按 `callId` 配对（`src/projection.ts:140-154`） |
| `ttftMs` / `ttftSteps` | 首 token 延迟之和 / 计入的步数 | `step/start` → 第一条非空 delta chunk（`src/projection.ts:113-118`，累加在 `129-131`） |
| `decodeMs` / `decodeTokens` | 解码时间与 provider 报的输出 token | 首 token → 组装完成，且该步报了 usage（`src/projection.ts:129-136`） |

schema 是 `.strict()` 的八个非负数（`src/projection.ts:65-74`）。每个字段在第一条贡献事件到达前都是 0；注册表一旦组合，key 永远在，客户端读**值**而不是判 key 是否存在（`README.md:15`）。

为什么数 `step/end` 而不是 `assistant/message`：README 说得很直白——它是 step 生命周期的权威，agent loop 在 `finally` 里每进一个 step 就恰好写一条，所以完成、失败、取消、撞 max-tokens 的步都算；换成数组装消息会把 max-tokens 的 usage-host 消息多算、把取消的步漏算（`README.md:9`）。

## 模型看得见什么

README："None, as the plugin only computes a client-facing read model of already-logged session events and touches no prompt, message, schema, stream, or tool result."（`README.md:28`）KV Cache 亦无影响（`README.md:32`）。

## 什么时候你会想换掉它 / 怎么换

- **不想要**：删掉或 `disabled: true`。Web 聊天页的 stats strip 不会消失，而是**整条退回窗口内折叠**——`StatsLine` 里 `useProjection('sessionStats') ?? deriveStats(settledNodes)`（`packages/client/ui-conversation/src/client/chat/StatsLine.tsx:170-171`）。字段名两边刻意一样，就是为了能整体回退。差别是：窗口折叠只统计已经加载进来的那段历史，翻页和压缩会让数字变。
- **想在别的形态里也有**：把这一行搬进对应 bundle 即可，前提是那棵树上有 `session-projection`（base 层已有）；不然 fiber 会一直 pending，什么都不注册（`README.md:24`）。
- **想改口径**：没有配置开关，折叠逻辑是编译进包的纯函数（`src/projection.ts:105-171`）。要改只能自己写一个 key 不同的投影单元并接管消费端。

## 坑与边界

README《Known Limitations》四条（`README.md:36-39`）：

- **步数统计的是"尝试过的工作"，不是"可见产出"**：没产出任何可见内容就失败的步照样有 `step/end`，照样计数；被崩溃打断的步会在会话重载、崩溃恢复补上合成 `step/end` 之后才计入。
- **取消的步计数但不计时**：它没有组装出消息，所以那段部分流时间进不了任何墙钟字段；反过来，撞 max-tokens 的 usage-host 消息会贡献界面上看不到的模型时间。
- **口径是日志范围而非界面范围**：被压缩掉的那些步仍然计数——这些数字描述整个会话，不是当前模型可见的表面。
- **只在 web-app bundle 挂载**：别的形态没有 `sessionStats` key，消费者退回窗口内计数。

另外两处读源码得到的细节：
- `tool/result` 用 `Object.hasOwn` 查 `pendingCalls`——`callId` 是模型/工具 JSON 边界上来的，`constructor`、`toString` 这类原型属性名必须读作"未匹配"，否则 `toolMs` 会被 NaN 污染（`src/projection.ts:147-149`）。
- `turn/end` 会清掉没等到结果的挂起调用，避免持久化状态无限增长（`src/projection.ts:163-167`）。
- 与 [session-title](./dsh-session-title.md) 注册的 `title` 单元同住一个 `sessionProjections` 注册表，两者互不相干；差别在于 title 那颗是 base 层、且用 `ctx.inject` 做可选挂载，本颗是硬 `inject`，没有注册表就整个不启动。

## 未确认

- ⚠️ "崩溃恢复补合成 `step/end`" 引自 README 提到的 dsh-session `interruptedTurnClosers`（`README.md:36`），本次未进 dsh-session 源码核对该函数。
