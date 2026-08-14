# 08 · effect 与生命周期

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章讲 dsh 底座 Cordis 的一条核心机制：**注册即 effect，卸载即逆序回滚**，以及由它派生出来的热重载与失败回滚语义。

**读完这章你会**：

- 用 `ctx.effect()` 包住定时器、文件监听、连接这类框架管不到的外部资源，让它随插件卸载自动释放
- 说清哪些注册动作**本身已经是 effect**（不用你手动清），以及怎么用 `label` 把它们在诊断里认出来
- 读懂 fiber 的六个状态，并解释"依赖被换掉 → 我的插件重启"这件事
- 写出装到一半抛错也能自己回滚干净的插件，并知道错误跑哪去了
- 判断 dsh 里 HMR 到底开到哪一层：改 `cordis.patch.yml` 会生效，改插件源码在默认 profile 下不会

## 1. 一个会漏的插件

假设你要写个心跳插件，每秒打一行日志：

```ts
export function apply(ctx: Context) {
  setInterval(() => ctx.logger.info('tick'), 1000)
}
```

这个插件在 dsh 里是**坏的**。插件不是只装一次：改一行配置、依赖的服务被换掉、HMR 保存文件、把这条 entry 标成 `disabled: true`（`docs/cordis-tutorial/06-composition-and-hmr.md:19`），都会导致这个实例被卸载再装一个新的。上面的 `setInterval` 没人认领，卸载后它继续跑，装十次就有十个定时器同时打日志。

（`ctx.logger` 不用装插件就有，Cordis 建 root context 时就挂上了 `LoggerService`（`vendor/cordis/src/context.ts:81`、`logger.ts:191`）；但**日志能不能被你看见**取决于有没有 exporter——纯 Cordis 环境下要另配 `@deepseek-ai/cordis-plugin-logger-console`，见 `docs/cordis-tutorial/06-composition-and-hmr.md:42`。）

正确写法是把资源的**获取和释放写在一起**，交给 `ctx.effect()`：

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => ctx.logger.info('tick'), 1000)
    return () => clearInterval(timer)
  }, 'heartbeat.timer()')
}
```

官方教程用的就是这个形状（`docs/cordis-tutorial/02-lifecycle-and-effects.md:13`–`42`，一个 `heartbeat` 定时器 + 一个 `setTimeout` 效果；官方那份没传 `label`）。文档把规则写成一句话：Cordis 已经管的东西不用你操心，**Cordis 管不到的资源必须包进 `ctx.effect()`**（`docs/cordis-tutorial/02-lifecycle-and-effects.md:5`）。

## 2. `ctx.effect()` 的确切契约

`ctx.effect` 不是 Context 自己实现的方法，它转发到当前 fiber 上。类型侧是 `Context extends Pick<Fiber, 'effect'>`（`vendor/cordis/src/fiber.ts:10`），真正做转发的是一句 mixin：`this.mixin('fiber', ['runtime', 'effect'])`（`vendor/cordis/src/reflect.ts:220`）。实现在 `vendor/cordis/src/fiber.ts:418`。

| 项 | 语义 | 出处 |
|---|---|---|
| `execute` | **立即执行**，不是延迟到某个时机 | `fiber.ts:522` |
| 返回值 | 一个 disposer；调它就地拆掉这个 effect | `fiber.ts:504`–`514` |
| 何时清理 | 手动调 disposer 或 fiber 卸载，**谁先到算谁**（wrapper 一创建就进 fiber 的 `_disposables`） | `fiber.ts:520`；行为说明见源码注释 `fiber.ts:406`–`408` |
| 重复调 disposer | no-op（外层 `runner.epoch` 闸 + 内层 `disposing` 标志） | `fiber.ts:508`、`fiber.ts:428`–`429` |
| fiber 已 DISPOSED / UNLOADING | 抛 `CordisError('INACTIVE_EFFECT')` | `fiber.ts:419`–`422`、`fiber.ts:351`–`354` |
| body 返回了不认识的东西 | 抛 `TypeError('Invalid effect')` | `fiber.ts:363`、`fiber.ts:372` |
| `label` | 只用于诊断，出现在 `getEffects()` 里；不传默认 `'anonymous'` | `fiber.ts:418`、`fiber.ts:444`、`fiber.ts:568` |

body 可以返回四种形状（类型定义在 `fiber.ts:83`–`93`，分发逻辑在 `fiber.ts:366`–`398`）：

| 形状 | 写法 | 分发行号 |
|---|---|---|
| 一个 disposer | `() => () => clearInterval(t)` | `fiber.ts:367` |
| `Promise<disposer>` | `async () => { await open(); return close }` | `fiber.ts:374` |
| generator，`yield` 多个 disposer | `function* () { yield a; yield b }` | `fiber.ts:375`–`382` |
| async generator | `async function* () { … }` | `fiber.ts:383`–`395` |

返回 `undefined` / `null` 也是合法的（`fiber.ts:369`–`370`）——表示这段 effect 没有需要回收的东西。

dsh 自己大量用 generator 形式把"一组要一起装、一起拆"的注册串起来，例如 `packages/core/agent/src/index.ts:294`–`297`：

```ts
ctx.effect(function* (this: AgentRegistry) {
  yield () => this.disposeInitiators()
  yield () => { this.closeInitiators() }
}.bind(this), 'agents.initiatorLifecycle()')
```

**这里最容易踩的是**：在 effect body 里调 `ctx.on()` 之类的注册，那个监听器仍然挂在 **fiber** 上，并不会自动变成"这个 effect 的子资源"。只有被 `yield` 或 `return` 出来的 disposer 才会被这个 effect 接管——`collect` 会把它从 fiber 的清单里 `delete` 掉再放进自己的清单（`fiber.ts:448`–`453`）。

这条机制有两个真实用法。一是**改所有权以控制顺序**：`packages/schedule/schedule/src/index.ts:69`–`75` 的 disposer 里**手动**调 `stopCreated()`（即第 45 行 `ctx.on('agent/created', …)` 的返回值），因为它要求先停止接新 agent、再逐个拆已建的 runtime，就得自己拿住句柄。二是**改标签**：`packages/preset/persona/src/index.ts:61`–`66` 把已经是 effect 的 `ctx.systemPrompt.section(...)` 再包一层 `ctx.effect(…, 'persona.section()')`，该 disposer 于是从 fiber 名下转到外层 effect 名下，诊断里显示 `persona.section()` 而非内层的 `systemPrompt.section()`。

## 3. 哪些动作本来就是 effect

判据很简单：**一个 API 返回 disposer，它就已经是 effect**，你不用为它写清理代码。

| 你写的 | 内部实现 | 自动挂的 label |
|---|---|---|
| `ctx.on(name, fn)` | `events.ts:254`–`260` | `ctx.on("name")`（`events.ts:300`） |
| `ctx.plugin(child)` | `fiber.ts:265`–`297` | `ctx.plugin()`（`fiber.ts:297`） |
| `ctx.provide(name, value)` | `reflect.ts:277`–`305` | `ctx.provide("name")`（`reflect.ts:304`） |
| `ctx.accessor(name, opts)` | `reflect.ts:345`–`353` | `ctx.accessor("name")`（`reflect.ts:352`） |
| `ctx.mixin(source, keys)` | `reflect.ts:364`–`389` | `ctx.mixin("source")`（`reflect.ts:389`） |
| `ctx.tools.register(def)` | `packages/core/tools/src/index.ts:1057`–`1061` | `tools.register()` |
| `ctx.systemPrompt.section(s)` | `packages/core/system-prompt/src/index.ts:385`–`389` | `systemPrompt.section()` |
| `ctx.tools.presentAs(mode)` | `packages/core/tools/src/index.ts:951`–`971` | `tools.presentAs()` |

官方 primer 把这条写成设计原则：prompt section、tool schema、adapter、provider、listener 全都通过 `ctx.effect()` 或 `ctx.on()` 安装，好让 reload 和 teardown 可预测地回退（`docs/cordis-primer.md:13`）。面向插件作者的清单在 `docs/user/develop/framework/index.md:57`–`63`。

## 4. `apply` 本身就是一个 effect body

很多人不知道这条：插件的启动函数走的是**同一套 effect 分发**。`Effect` 类型的文档注释明写 "Effect body result accepted by `ctx.effect()` and plugin startup."（`fiber.ts:77`），runner 的 `execute` 就是 `runtime.callback(this.ctx, this.config)`（`fiber.ts:259`），返回值交给同一个 `_execute`（`fiber.ts:356`）收集到 fiber 的 `_disposables`（`fiber.ts:230`–`232`）。

所以下面两种写法都是合法插件——`apply` 直接返回 disposer，不用套 `ctx.effect()`：

```ts
export function apply(ctx: Context) {
  const timer = setInterval(() => ctx.logger.info('tick'), 1000)
  return () => clearInterval(timer)
}
```

```ts
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const timer = setInterval(() => ctx.logger.info('tick'), 1000)
  await Promise.resolve()
  return async () => clearInterval(timer)
}
```

第二种在仓库里有真实用例：`packages/api/remotes/src/client/index.ts:105`–`122`，`apply` 是 async 的，返回一个"按挂载逆序卸载"的 disposer。`_reload` 会 `await` 这个 promise（`fiber.ts:656`）。

**async `apply` 的坑**：`await` 之后 fiber 可能已经在卸载了，这时再调 `ctx.effect()` / `ctx.on()` 会抛 `INACTIVE_EFFECT`。dsh 自己就在 boot 路径上处理这个竞态——`packages/boot/app-boot/src/index.ts:258`–`264` 显式判 `error.code === 'INACTIVE_EFFECT'`，并按源码注释"这是 app 按要求退出，不是 watch 失败"处理，返回一个空 disposer 而不是崩掉。

## 5. fiber 状态机与卸载顺序

一个 fiber = 一个已加载的插件实例。状态枚举在 `fiber.ts:147`–`154`（顺序为 `PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING`），教程给的迁移图是（`docs/cordis-tutorial/02-lifecycle-and-effects.md:73`–`74`；另一种画法与逐状态释义见 `docs/user/develop/framework/index.md:11`–`24`）：

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

当前状态不是随手赋值的，`_getState()` 按优先级算（`fiber.ts:574`–`579`）：`uid === null` → DISPOSED；有 `_error` → FAILED；epoch 不是 `INACTIVE` → ACTIVE；否则 PENDING。注意 LOADING / UNLOADING 这两个**过渡态永远不由 `_getState()` 算出**，只能由 `_updateState` 的回调显式返回（`fiber.ts:630`–`637`、`fiber.ts:665`–`672`）。每次跃迁都 `emit('internal/status', fiber, oldState)`（`fiber.ts:586`），这个事件是公开声明的（`vendor/cordis/src/events.ts:333`），dsh 内部就有订阅者（`packages/core/agent/src/index.ts:289`）。

**依赖驱动**是这套模型最反直觉的一处。fiber 的 "epoch" 不是布尔值，而是把每个依赖服务的 provider fiber uid 拼成的字符串（`fiber.ts:611`–`623`）：

```
epoch = ':' + providerA.uid + ':' + providerB.uid
```

于是：某个依赖消失 → epoch 变成 `INACTIVE` → `_unload()`；依赖回来 → epoch 变了 → `_reload()`（`fiber.ts:625`–`639`）。注意即使服务名没变，**换了一个实现**（新 provider fiber，新 uid）epoch 字符串也会变，所有依赖它的插件都会卸载重装。触发者是 `reflect.notify()`（`reflect.ts:314`–`336`）。

卸载顺序有两条必须分清的规则，都能从源码读出来：

| 范围 | 顺序 | 出处 |
|---|---|---|
| 一个 fiber 的所有 effect 之间 | **逆注册序开始**，但异步 disposer 用 `Promise.all` **并发**跑，不保证逐个跑完 | `fiber.ts:676`–`686` + `utils.ts:27`–`31`（`clear()` 返回 `values.reverse()`） |
| **同一个** effect 内部收集的多个 disposer | 逆序且**串行**（`task = task.then(...)` 逐个链起来） | `fiber.ts:430`–`440` |

所以顺序敏感的清理必须收进**同一个 effect**：无论是 generator 里 `yield` 出的多个 disposer，还是写成一个 disposer 在里面自己 `await`，都能拿到串行保证。官方两处给的是更保守的后一种说法——"放进单个 `ctx.effect()` 返回的同一个 disposer 里，在那里串行 await"（`docs/user/develop/framework/index.md:63`、`docs/cordis-primer.md:44`）。至于 `fiber.dispose()` 的三条保证——注册全部移除、子插件递归卸载、promise 在所有异步清理结束后才 resolve——是官方文档的表述（`docs/user/develop/framework/index.md:94`–`97`）。

## 6. 实操：一个持有外部资源、能干净卸载的插件

下面这个插件同时持有一个定时器和一个事件订阅，并且**卸载时要求先摘监听、再落盘**——所以两件事写在同一个 disposer 里。定时器与它无顺序关系，单独一个 effect。

```ts
// heartbeat.ts
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'heartbeat'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => ctx.logger.info('tick'), 1000)
    return () => clearInterval(timer)
  }, 'heartbeat.timer()')

  ctx.effect(() => {
    const seen: string[] = []
    const stop = ctx.on('internal/status', (fiber) => {
      seen.push(fiber.name)
    })
    return async () => {
      stop()
      await writeFile(resolve(process.cwd(), 'heartbeat.log'), seen.join('\n') + '\n', 'utf8')
    }
  }, 'heartbeat.audit()')
}
```

纯 Cordis 环境下挂载它只要 `cordis.yml` 两行（本地文件用相对路径，写法见 `docs/cordis-tutorial/06-composition-and-hmr.md:38`–`39`）：

```yaml
- id: heartbeat
  name: './heartbeat.ts'
```

在 dsh 里则是往 patch 层的 `insert:` 列表里加同样两行——patch 文件就是一个顶层 YAML 数组，元素是"按 id 覆盖 config"或 `insert` 列表（`packages/boot/app-boot/src/index.ts:268`–`271`），形状照抄 `packages/bundle/base/cordis.patch.yml:15`–`17`。四层叠加的细节见第 03 章，挂载走查见第 06 章。

三处对着源码的说明：

- `ctx.on('internal/status', …)` 本身已经是 effect，就算你不调 `stop()`，fiber 卸载时它也会被摘掉（`events.ts:254`–`260`）。这里手动调，纯粹是为了**保证在落盘之前摘干净**。
- 第二个 effect 的 disposer 是 `async` 的，`_unload` 会 `await` 它（`fiber.ts:678`–`681`）。
- 两个 effect 之间的先后**不要指望**：并发。真要串，合成一个。
- 更大规模的真例：`packages/skill/skill-filesystem/src/index.ts:136`–`138`（文件监听 provider 的 dispose）、`vendor/hmr/src/index.ts:177`–`182`（chokidar watcher 的 `watcher.close()`）。

## 7. 装到一半失败：回滚语义

分三种情况，全部可从源码读出：

**(a) effect body 里同步抛错。** 已经收集到的 disposer 立刻跑一遍，然后把原错误继续抛出（`fiber.ts:521`–`537`）。也就是说这个 effect 要么整体成立，要么什么都不留。

**(b) `apply` 抛错，或 config 校验没过。** `_reload()` 的 catch 做三件事：`ctx.logger.error(reason)`、记下 `_error`、把 epoch 置回 `INACTIVE`（`fiber.ts:659`–`664`）；紧接着的状态更新发现 epoch 变了，于是直接调 `_unload()`（`fiber.ts:665`–`672`）——**这一轮里已经注册的一切被逆序拆掉**，fiber 终态是 FAILED（`_getState` 见 `fiber.ts:574`–`579`）。config 校验失败走的是同一条路：`resolveConfig` 抛 `ValidationError`（`fiber.ts:50`–`62`），发生在 `_reload` 的 try 里（`fiber.ts:655`）。

**(c) 错误跑哪去了？** 进 logger，不会炸进程。要主动拿到它，`await fiber.await()`——它会把 `_error` 重新抛出来（`fiber.ts:704`–`710`）。

**什么时候还需要你手写回滚？** 当那批 disposer 还攥在你自己手里、没交给 fiber 的时候。`packages/api/remotes/src/client/index.ts:107`–`116` 就是标准形状：async `apply` 里逐个 `$mount`，中途失败就 `for (const dispose of disposers.reverse()) await dispose()` 再 rethrow。`packages/host/directory-picker-auto/src/index.ts:69`–`97` 同理，在 `ctx.effect(async () => …)` 内部维护 `ids`，失败时调逆序 `unmount()`（`:93`），成功时把同一个 `unmount` 作为 disposer 返回（`:96`）。

## 8. 为什么 HMR 可行，以及 dsh 里它实际开在哪

热重载在这套模型下不是特性，是推论：**卸载能把注册退干净，加载又由依赖驱动，那么"卸载 + 重新加载"就等于替换**（`docs/cordis-tutorial/06-composition-and-hmr.md:25`）。`@deepseek-ai/cordis-plugin-hmr`（`vendor/hmr`，package version 1.0.16，见 `vendor/hmr/package.json:4`）做的事按顺序是：

1. chokidar 监视 `root`，防抖后进 `partialReload()`（`vendor/hmr/src/index.ts:242`、`:272`–`:274`）
2. 改动文件属于框架自身（externals）→ 调 `loader.exit()`；属于 ESM `loadCache` → 局部重载（`vendor/hmr/src/index.ts:259`–`268`）
3. 备份并清掉 ESM `loadCache` 与 CJS `require.cache`，重新 `import`（`vendor/hmr/src/index.ts:461`–`496`）
4. `ctx.registry.delete(oldPlugin)`（`:517`）—— 它会 dispose 该 plugin 的**每一个** fiber（`vendor/cordis/src/registry.ts:258`–`267`）
5. 用旧 fiber 的 `_config` 重新 `registry.plugin(newModule, …)`（`vendor/hmr/src/index.ts:502`–`509`）
6. 任一步抛错就整体回滚：恢复两个 module cache，把旧插件重新注册回去（`vendor/hmr/src/index.ts:482`–`489`、`:532`–`:545`）

**第 2 步的 `loader.exit()` 在本仓库里是个空方法**（`vendor/loader/src/index.ts:188`–`189`，注释写的是 "Hook for hosts that can restart the process on full-reload requests"），全仓 grep 没有任何子类覆写它。也就是说：改到框架自身的文件时，HMR 既不局部重载也不重启进程，那次改动被静默忽略——想生效只能自己重启。

Schema 里声明的字段有四个（`vendor/hmr/src/index.ts:560`–`570`）：`base`、`root`（默认 `['.']`）、`ignored`（默认忽略 `**/node_modules`、`**/.*`、`cache`、`data`）、`debounce`（默认 100ms）。但它不是"只认这四个"：`Config extends ChokidarOptions`（`:553`），整份 config 被展开传给 `watch()`（`:229`），而 schemastery 的非严格解析会把未声明的键原样并回结果（`vendor/schemastery/src/index.ts:761`），所以 chokidar 自己的选项能透传。它 `inject` 了 `loader` 和 `timer`（`vendor/hmr/src/index.ts:87`），并且要求拿得到 Node 的内部 ESM loader，否则构造函数直接抛（`vendor/hmr/src/index.ts:120`–`122`）。

那句报错文案写的是 `--expose-internals is required`，但**这不是唯一途径**：`vendor/loader/src/internal.ts:108`–`118` 先看 `process.execArgv` 有没有 `--expose-internals`，没有就退到原生插件 `node-addon-require-builtin` 的 `requireBuiltin()`（该包是 `apps/cli` 与 `vendor/loader` 的依赖，见 `apps/cli/package.json:83`、`vendor/loader/package.json:34`）。另外还要 Node ≥ 22（`internal.ts:122`–`130`）。

**现在是 dsh 特有的部分，跟纯 Cordis 教程不一样，务必记住**：

| profile | hmr 行状态 | 出处 |
|---|---|---|
| base bundle（所有 profile 的共同底） | 启用，`root: ['.']` | `packages/bundle/base/cordis.patch.yml:19`–`22` |
| web-app | `disabled: true`（注释：reload lifecycle 未测试，待重开） | `packages/bundle/web-app/cordis.patch.yml:21`–`23` |
| headless | `disabled: true` | `packages/bundle/headless/cordis.patch.yml:12`–`15` |

被关掉之后并非全无热更：CLI 在 boot 之后发现 `ctx.get('hmr') === undefined`，会**兜底挂一个 `root: []` 的 watch-only HMR**（必要时先补 `timer`），专门用来盯用户的 patch 层（`apps/cli/src/profile-boot.ts:279`–`294`），再由 `watchUserPatches` 把变更转成对 Include entry 的 `entry.update({ config })`（`packages/boot/app-boot/src/index.ts:241`–`254`）。

于是对使用者的实际结论是：

- 改 `cordis.patch.yml`（profile 的和 `$DSH_HOME` 的两份，见 `profile-boot.ts:287`、`:292`）→ **实时生效**，不用重启。
- 在默认的 web / headless profile 下改**插件源码文件** → **不会热更**（`root: []` 不监视任何模块），得重启进程；想要模块级热更，自己在 patch 里把 `hmr` 行 `disabled` 去掉并给回 `root`。
- 配置变更本身也是一次热替换：框架卸载旧实例、装新实例，旧实例的注册不会残留（`docs/user/develop/basic/config.md:100`）。走的是 `fiber.update()` → `internal/update` waterfall → `restart()`（`vendor/cordis/src/fiber.ts:736`–`753`、`:718`–`723`）。
- **entry 一定要写 `id`**：没有 `id` 的条目每次读配置都会拿到新生成的 id，于是任何一次配置文件编辑都会被当成"删掉旧的 + 加个新的"，哪怕它自己那几行没动也会重挂（`docs/cordis-tutorial/06-composition-and-hmr.md:59`）。

## 9. 怎么看现在挂着哪些 effect

`ctx.fiber.getEffects()` 返回当前存活的 effect 元数据树（`fiber.ts:568`–`572`），节点形状是 `{ label, children }`（`fiber.ts:96`–`101`）。它按 `symbols.effect` 过滤：凡是经 `ctx.effect()` 建的都带这个标记（没传 label 就叫 `anonymous`），而直接被 `collect` 收进去的裸 disposer（例如 `apply` 直接 `return` 的那个）没有标记，不会出现在结果里。`children` 只包含被 `yield` / `return` 出来的嵌套 effect（`fiber.ts:451`–`453`）。

它是有公开 API 文档的（`docs/cordis-api/fiber.md:195`–`203`）。但全仓 grep 的结果是：除了 `vendor/cordis/src/fiber.ts` 里的定义和那两份 API 文档，`getEffects()` 只出现在 7 个测试文件中，**没有任何 CLI 或诊断命令把它暴露给使用者**。所以它现在的实际用途是写断言，可以照抄这个用法：

```ts
// packages/core/scope/tests/store.spec.ts:195
expect(ctx.fiber.getEffects().map(effect => effect.label)).toContain('store.order')
```

这就是**给每个 effect 起 label 的实际收益**：`agentLoop.lifecycle(<sessionId>)`（`packages/core/agent-loop/src/index.ts:530`）、`schedule.runtime()`（`packages/schedule/schedule/src/index.ts:65`）、`tools.presentAs()` 这类名字在诊断输出里能一眼定位是谁没退干净。反过来，插件没反应但也不报错，多半是 fiber 停在 PENDING（缺依赖），排查脚本见 `docs/cordis-tutorial/06-composition-and-hmr.md:67`–`83`，更系统的诊断留到第 25 章。

> 想知道这一点上 Pi / Codex / LangChain 怎么做，见 [五个 agent 系统源码解剖](../2026-08_五个agent系统源码解剖/00-总览与阅读指南.md)。

## 10. 本章未确认

- ⚠️ 本章没有运行过任何代码（仓库未安装依赖，只做只读源码核对）。第 6 节的 `heartbeat.ts` 是按 `docs/cordis-tutorial/02-lifecycle-and-effects.md:13`–`42` 的形状改写的，所用 API（`ctx.effect` / `ctx.on('internal/status')` / `ctx.logger.info`）逐个对过源码，但**整份文件未实机跑通**。
- ⚠️ "默认 web / headless profile 下改插件源码不会热更"是由 bundle patch 的 `disabled: true` 加 CLI 兜底只挂 `root: []` 两处代码推出的结论，**未实机验证**；rc.6 及以后是否重开 hmr 行不在本教程覆盖范围。
- ⚠️ "framework 自身文件改动被静默忽略"依据的是 `loader.exit()` 空实现 + 全仓无覆写这一 grep 结果；若某个下游发行版自带覆写了 `exit()` 的 host，行为会不同。未实机验证。
- ⚠️ `node-addon-require-builtin` 这条免 `--expose-internals` 的路径只从源码与 `package.json` 依赖读出，**没有在真机上验证过原生插件是否装得上、装不上时的降级表现**。
- ⚠️ "多个异步 disposer 并发、不保证逐个完成"来自 `_unload` 的 `Promise.all` 写法与官方文档的一致表述，但其可观察后果（例如两个 disposer 互相依赖时的具体失败形态）未实测。
