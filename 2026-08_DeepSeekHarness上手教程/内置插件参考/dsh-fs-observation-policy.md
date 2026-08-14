# fs-observation-policy

> `@deepseek-ai/dsh-fs-observation-policy` · bundle：`base` · 配置树 id：`fs-observation-policy` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：纯中间件插件——它**不注册任何 service**，只挂三个 `fs/*` 监听器，把"这个 session 读过没读过这个文件"记在 `WeakMap` 里，据此给写/改操作生成 provider 级守卫，实现"读过才准写、读过才准改"。

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:221-222`：

```yaml
- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'
```

没有 `config`，没有 `inject`——包本身也不导出 `inject`（`packages/fs/fs-observation-policy/src/index.ts:100-105` 的注释写明 "No `inject` — this plugin reads no services"）。`docs/config-catalog.md:3069` 把它列在 "Loadable plugins with no config"（章节头在 `:3024`）那一档。

web profile **没有**关掉它（`packages/bundle/web-app/cordis.patch.yml` 里没有这一行）：模型侧工具下沉到 agent preset，而 `ctx.fs` 与这层策略留在 host 平面。它在 bundle 里紧挨在 `tool-fs`（`:224-225`）之前，对应 README 的建议——策略监听器应当是这两个决策槽上最先注册的那个（`packages/fs/fs-observation-policy/README.md:17`）。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| 事件监听 | `fs/write-intent`（**waterfall**） | 未见过或确认缺失 → `{ kind: 'createIfAbsent' }`；确认存在 → `{ kind: 'replaceIfVersion', version }`。**独占单槽，不调 `next()`**（`src/index.ts:119`，决策体在 `:65-71`） |
| 事件监听 | `fs/edit-intent`（**waterfall**） | 未见过 → 抛 `FS_NOT_OBSERVED`；确认缺失 → 抛 `FS_NOT_FOUND`；确认存在 → `{ version }` 作 CAS 基准。同样独占单槽（`src/index.ts:122`，决策体在 `:78-88`） |
| 事件监听 | `fs/observed`（emit） | 同步记录 `present`/`absent`，实现就是一次 `WeakMap.set`（`src/index.ts:127-129`） |

没有 service，没有工具，没有 prompt 段，没有命令。两个 waterfall 的 listener 都包在 `Promise.resolve().then(...)` 里，好让抛出变成 reject 而不是穿过 waterfall 同步逃逸（`src/index.ts:116-122`）。

派发方有两个：[tool-fs](./dsh-tool-fs.md) 与 [tool-str-replace-editor](./dsh-tool-str-replace-editor.md)；`fs/observed` 这一槽上本插件不是唯一监听者，`skill-filesystem` 也在听（`docs/event-producer-consumer.md:34-36`）。

## 配置项

**无配置项。** 它的行为完全由三件事决定：谁先在这两个槽上注册（先到先得）、事件里那个不透明 `actor` 能否推出 owner、以及这个 owner 曾经观察到什么。

owner 的推导只有一行：`(actor as FsObservationActor | undefined)?.agent?.session`（`src/index.ts:40`）。owner 被当作纯粹的对象身份用作 `WeakMap` 键，插件从不读它的任何字段。

状态结构是 `WeakMap<object, Map<string, FsObservation>>`（`src/index.ts:28`）——外层键是 owner 对象，内层键是 `target.targetKey`；三种逻辑态：unseen（无条目）、`{ kind: 'absent' }`、`{ kind: 'present', version }`。插件**自己不做任何文件 IO**，只把状态翻译成 provider 守卫；真正的新鲜度检查是 provider 在写锁内做的 CAS。

插件 dispose 时 `ctx.effect` 回调整个换掉 `WeakMap`（`src/index.ts:109-114`、`:57-59`），HMR 重载后从零开始。

## 模型看得见什么

README 的 Model Experience 写得很直白：**这个插件不加任何 prompt 或 schema**。模型只在被拒绝时才会感知到它：

- 没读过就 `edit` → code `FS_NOT_OBSERVED`，消息逐字为 `edit requires reading "<path>" first`（`src/index.ts:82`）。
- 刚确认缺失的目标去 `edit` → `FS_NOT_FOUND`，消息 `cannot edit "<path>": not found`（`src/index.ts:85`）。
- 观察过但版本已陈旧的守卫写 → provider 抛的 `FS_STALE_VERSION` 原样上浮。

补救话术不归它：`— read the file, then retry` / `— re-read the file, then retry` 由 tool-fs 的 error wrapper 追加（`packages/fs/tool-fs/src/error.ts:14-17`），code 保持不变。

## 什么时候你会想换掉它 / 怎么换

**去掉它是无损的**——这正是用事件门而不是强制方法服务的全部理由。卸掉之后 tool-fs 不会在注入边界上断，只是落回裸 provider：`write` 无条件创建或覆写，`edit` 无条件替换。

```yaml
- id: fs-observation-policy
  disabled: true
```

想换成自己的策略：写一个插件，在这两个槽上比它更早注册（或 `prepend`），返回自己的 `FsWriteIntent` / `{ version }`。槽是先到先得，本插件占住它只是默认部署的约定，不是事件层强制的不变量（`docs/subsystems/filesystem.md:185`）。

**不要**把它当成授权链的一环去叠加：README 明确说分层的权限/审计/沙箱拦截属于 `tools/execute`，不属于这两个单槽决策（`README.md:46`）。它与 [fs-sandbox](./dsh-fs-sandbox.md) 的模式围栏是正交的两件事，可以同时生效（`packages/fs/README.md:17`）。

## 坑与边界

- **观察状态不跨 session 恢复**：`WeakMap` 记录的持久化被推迟了，resume 出来的 session 必须重新读文件才能做守卫写/改。
- **没有 agent session 的调用方永远满足不了策略**：它们的 `edit` 一律 `FS_NOT_OBSERVED`，`write` 一律解析成 `createIfAbsent`，因此非 agent 调用方无法经这个门覆写已存在的文件。
- **直接调 `ctx.fs` 读文件不会发 `fs/observed`**：绕过 `read` 工具读到的内容不算观察，后续守卫编辑照样被拒。
- **授权判据是版本新鲜度，不是视图完整性**：任意一次窗口读都能授权对未变更文件的整文件覆写——这是刻意做得比"必须看全文"更弱（`docs/subsystems/filesystem.md:224` 有同样表述）。
- 读源码另注：`fs/observed` 的 listener 必须同步且不抛。派发方不 guard，抛出会替换掉读错误、或在变更**已经成功**之后把工具结果变成 `isError`（`docs/subsystems/filesystem.md:185`）。
