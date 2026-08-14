# 04 · Cordis 是什么

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章只讲 Cordis 的心智模型——它是什么、几个核心概念怎么咬合、为什么 dsh 非要垫这一层；具体 API 怎么写留给 05–10 章。

**读完这章你会**：

- 说清 `ctx` 到底是什么对象，以及为什么每个插件手里的 `ctx` 都不是同一个；
- 读懂 `cannot get property "x" without inject` 在源码哪一行抛出、为什么不是返回 `undefined`；
- 画出 dsh 启动后的 plugin tree，并指出谁决定加载顺序（不是配置文件的行序）；
- 解释 `isolate` 让"同一个服务名同时存在两份实现"成立的机制；
- 回答"为什么不能用普通 DI 容器或洋葱中间件替代 Cordis"。

## 1. 一个反常的事实：这个项目没有"核心"

先看两个当场数出来的数字。`packages/` 下有 226 个 `package.json`，其中 219 个把 `@deepseek-ai/cordis` 写进了 `peerDependencies`（同时也在 `devDependencies` 里）；剩下 7 个全在 `packages/typert/generator/tests/fixtures/` 下，是测试夹具。`vendor/README.md:5` 也是这么说的："every harness package declares `cordis` as a peer dependency"。**dsh 的每一个真实包都是 Cordis 插件**——模型适配器是，工具注册表是，会话日志是，连 agent 主循环本身也是（`docs/architecture.md:11`）。口号写在 README 第一屏："everything is a plugin"（`README.md:7`），架构文档说得更硬：

> There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.（`docs/architecture.md:13`）

所以启动代码里没有"依次初始化各模块"那一段。`packages/boot/app-boot/src/index.ts` 的启动函数总共干三件事：`new Context()`（`:764`）、`ctx.plugin(Loader)`（`:771`）、把一份 YAML 挂成根 Include（`:774` → `:518-523`）。`apps/cli/src/profile-boot.ts:1-6` 的模块说明也只讲"把各层 patch 叠出这份 YAML"，没有模块初始化顺序这回事。而清单开头专门写了一句提醒（`packages/bundle/base/cordis.patch.yml:12-13`）：

> Row order carries no load semantics (activation is service-availability driven); the grouping is for readers.

配置行的顺序不代表加载顺序。那什么决定加载顺序？这就是本章要回答的。

## 2. Cordis 的来历，以及它为什么被抄进 `vendor/`

| 项 | 值 | 出处 |
|---|---|---|
| 上游 | `cordiverse/cordis`（`packages/core`），commit `56b3d4f7` | `vendor/README.md:17` |
| 设计论文 | _A Programming Paradigm for Spatiotemporal Composability_ | `README.md:7` |
| dsh 里的包名 | `@deepseek-ai/cordis`（整体 rescope 进 `@deepseek-ai` 域） | `vendor/cordis/package.json:2`、`vendor/README.md:5` |
| 源码 | `vendor/cordis/src/`，9 个文件共 2693 行（当场 `wc -l`） | — |

（"Cordis 出自 Koishi 生态"这句是背景常识，仓库里没有写，别当成核对过的事实。）

关键是**它是 vendored 的，不是 npm 依赖**："copied into this monorepo instead of being depended on via npm, so that the harness fully owns its framework layer (auditable, patchable, pinned)"（`vendor/README.md:3`）。而且真的改了——`vendor/README.md:33-50` 逐条列了 18 项本地修改（小标题在 `:29`），第 6 条是对 `cordis/src/fiber.ts` 的生命周期加固，堵了三个可重入卸载的漏洞（`vendor/README.md:38`）。对你的意义只有一条：**读 Cordis 行为必须以 `vendor/cordis/src/` 为准，不能拿上游文档或博客当事实源**。本章所有行号都指这里。

## 3. 五个词，一张图

官方 primer 用五句话概括 Cordis（`docs/cordis-primer.md:9-13`），挑的是 plugin / context / `inject` / typed events / reversible effects。本章的词表跟它不完全重合：`inject`、事件、effect 分别留给 06 / 09 / 07 章，这里先把承载它们的五个对象摆出来。

| 词 | 一句话 | 出处 |
|---|---|---|
| **Context**（`ctx`） | 服务仓库。插件通过 `ctx.<key>` 找能力，而不是 import 实现 | 类定义 `vendor/cordis/src/context.ts:42`；"repository of services" 这个说法出自 `docs/cordis-primer.md:10` |
| **plugin** | 一个函数、类、或带 `apply(ctx, config)` 的对象 | `vendor/cordis/src/registry.ts:92-95`（对象形态见 `:130-133`） |
| **fiber** | 一次插件加载的运行时实例：状态、校验过的配置、注册的 effect | `docs/cordis-api/fiber.md:6` |
| **registry** | 插件加载与依赖注入 | `docs/cordis-api/registry.md:6` |
| **service** | 占住 `ctx.<name>` 的类，随所属 fiber 自动注销 | `docs/cordis-api/service.md:6` 与 `:10` |

后三行的措辞抄自 `docs/cordis-api/*.md`——那是 `scripts/gen-cordis-catalog.ts` 生成的 API 参考，属于官方文档表述；本章后文每一条行为结论另有源码行号。

```
 new Context()  ← 构造函数返回的是一个 Proxy，不是 this      context.ts:74 / :83
   ├── ctx.reflect ── store: { Symbol(name) → Impl{name,value,fiber,check} }  reflect.ts:209 / :116-125
   ├── ctx.registry ─ Map<callback → Runtime{ fibers[] }>            registry.ts:197
   ├── ctx.events ─── _hooks: { 事件名 → [{ ctx, callback }] }        events.ts:132 / :257
   └── root fiber (uid = 0, runtime = null)                          fiber.ts:321-324
         │  ctx.plugin(X) 每调一次新建一个 fiber           registry.ts:330
         └── fiber #1 ─ ctx₁ = 父ctx.extend({ fiber: 自己 })          fiber.ts:236
               └── fiber #2 / #3 / …  每个都有自己的 ctx，同样是 Object.create 出来的
```

三张表是**平的**（都挂在根上那三个服务实例里），fiber 是**树的**。这个"表平树竖"的错位，正是 Cordis 全部表达力的来源。

## 4. Context 是个 Proxy——而且每个插件手里的 ctx 都不是同一个

本章最重要的一节。搞不清这一点，后面所有章的行为你都会觉得是玄学。

### 4.1 根 ctx 是 Proxy，子 ctx 不是

| 行 | 代码 | 是什么 |
|---|---|---|
| `context.ts:74` | `const self = new Proxy<this>(this, ReflectService.handler)` | 根 ctx；`:83` 把它 `return` 出去 |
| `context.ts:101` | `const self = Object.create(getTraceable(this, this))` | `extend()` 造子 ctx |
| `fiber.ts:236` | `this.ctx = this.context = parent.extend({ fiber: this })` | 每个插件收到的 ctx |

全仓只有 `context.ts:74` 这一处用了 `ReflectService.handler`（当场 grep），所以**整棵树上只有根是 Proxy**。`extend()` 用的是 `Object.create(父)`——子 ctx 是普通对象，原型指向父 ctx。Context 类自己没挂 tracker（`symbols.tracker` 只出现在 logger / events / registry / reflect / `Service` 上），`getTraceable` 遇到没 tracker 的值原样返回（`utils.ts:122-124`），所以原型链最终落到根那个 Proxy 上。

**结论：你的插件函数收到的 `ctx` 只属于你这个 fiber。它的自有属性只有 `fiber` 一个——声明了 `inject` 时还会多一个 intercept 符号属性（`fiber.ts:240-244`）——其余全靠原型链继承。你和隔壁插件拿到的 `ctx` 长得一样，行为不同。**

### 4.2 读 `ctx.tools` 时逐行发生了什么

子 ctx 上没有 `tools`，查找沿原型链上溯，撞到根 Proxy 的 `get` trap。ES 的 Proxy 语义里 trap 第三个参数 `receiver` 是**最初被访问的那个对象**——就是你的 ctx，Cordis 直接把它命名为 `ctx`（`reflect.ts:136` 的 `get: (target, prop, ctx: Context) => {`）。同时第一个参数 `target` 恒等于**根 Context 实例**，下面第 154 行取的 `key` 因此是根那张 isolate 表里的标签。解析过程（`reflect.ts:144-167`）：

```
ctx.tools
 ├─ :144  先造好错误对象：cannot get property "tools" without inject
 ├─ :152  你在根 ctx 上（fiber.runtime === null）？→ 直接查表，不要求 inject
 ├─ :153  否则进 internal/get waterfall（一种可被插件层层包住的派发方式，第 10 章专讲）
 ├─ :154  key = 根 ctx 的 isolate 表里 'tools' 那一格的 Symbol
 └─ :155  从你的 ctx（带 shadow 时用 shadow 的）的 fiber 开始往上爬：
       :157  fiber.store['tools'] 有 → :158 返回 getTraceable(你的ctx, 值)
       :159  在 fiber.inject 里但 store 没有 → 抛 cannot get required service "tools" in inactive context
       :163  爬到根 fiber（runtime === null）→ 抛 without inject
       :164  父 ctx 的 isolate['tools'] ≠ key（也就是进了别的 realm）→ 抛
       :165  否则 fiber = fiber.parent.fiber，继续
```

三个立刻能用上的推论：

1. **不 `inject` 就读不到。** `fiber.store` 是 fiber 激活时对"我声明的依赖"的快照（`fiber.ts:647` 建、`:687` 清），自己 `provide` 的服务随后补写进去（`reflect.ts:293`）。没声明的名字爬到根就抛 `without inject`，**不是返回 `undefined`**。
2. **另有一条不检查 inject 的旁路**：`ctx.get(name)`（`reflect.ts:233`，混入见 `:219`）。它按 isolate 键直查表，`strict` 默认 `true`，只返回提供方 fiber 处于 ACTIVE 的实现（`reflect.ts:237-243`）。`packages/` 里有 376 处 `ctx.get('…')`（当场 grep），dsh 里"有就用、没有算了"的可选依赖走的就是它——例如 `packages/core/tools/src/index.ts:1020` 读 `codeRuntime`、`packages/core/agent-loop/src/index.ts:359` 读 `sessionPersistence`。
3. **两条报错文案区分两种失败**：`without inject` = 你压根没声明；`in inactive context` = 你声明了但提供方此刻不可用。第 24 章会把这两条接进诊断流程。

### 4.3 你拿到的服务，是一个"绑在你身上的影子"

第 158 行返回的不是 `impl.value` 本身，而是 `getTraceable(ctx, impl.value)`。`Service` 基类构造时造了 tracker `{ associate: name, property: 'ctx' }`（`service.ts:46-49`）并挂到实例上（`:55`），于是 `getTraceable` 会套一层 Proxy（`utils.ts:117-125` → `:165`），里面有决定性的一行（`utils.ts:176`）：

```ts
if (prop === tracker.property) return ctx
```

**服务方法里读到的 `this.ctx`，是调用方的 ctx，不是服务自己被创建时的那个 ctx。** 这一行把模型闭合了。看 dsh 里最常用的注册路径：`ctx.tools.register()` 的签名在 `packages/core/tools/src/index.ts:1037`，中间十几行是 schema 与保留名校验，真正干活的是收尾五行（`:1057-1061`，`name` 来自 `:1038` 的 `definition.name`）：

```ts
return this.layers.effect(
  this.ctx,
  layer => layer.tools.insert(name, definition),
  { label: 'tools.register()' },
)
```

`this.ctx` 一路传下去，最终落到 `ctx.effect(...)`（`packages/core/scope/src/store.ts:226` 的方法、`:233` 的调用；`:221` 的文档写明这个 ctx "determines both scope visibility and effect ownership"）。所以：

> 你在自己的插件里调 `ctx.tools.register(...)`，这个工具注册成了**你这个 fiber 的 effect**；你的插件卸载，工具自动消失。你不写一行清理代码，`tools` 服务也不需要知道你是谁。

事件监听同理，`ctx.on()`（`events.ts:288`）走到 `register()`，里面就是 `this.ctx.fiber.effect(...)`（`events.ts:254-260`）。这就是"注册即 effect、卸载即逆序回滚"的物理基础——不是靠约定，是靠 `ctx` 的身份被 Proxy 全程携带。`packages/` 下有 189 处 `ctx.effect(` 调用点，算上 `apps/` 与 `vendor/` 共 212 处（当场 grep），怎么写见第 07 章。

## 5. fiber：一次插件加载的运行时实例

一个插件被 `ctx.plugin()` 调几次就有几个 fiber，它们共享一条 `Runtime` 记录（`registry.ts:136-145`）；registry 用 `Map<callback, Runtime>` 索引（`registry.ts:197`），键是 `resolve()` 出来的可执行体（`registry.ts:222-228`）。fiber 有六个状态，枚举顺序如下（`fiber.ts:147-154`）：

| 状态 | 含义 | 你什么时候会撞见 |
|---|---|---|
| `PENDING` | 在等 `inject` 声明的服务 | 插件"没加载"最常见的真相 |
| `LOADING` | 插件体正在跑 | 异步 `apply` 期间 |
| `ACTIVE` | 加载完成，对外可见 | 正常态 |
| `FAILED` | 插件体或配置校验抛了 | 配置写错时 |
| `DISPOSED` | 已移除，不能再起 | — |
| `UNLOADING` | disposers 正在跑 | 此时再建 effect 会被拒（`fiber.ts:419-422`） |

迁移不靠调度器，靠一个 epoch 字符串（`fiber.ts:611-639`）：`_refresh()` 把每个依赖的提供方 fiber uid 拼成 `":3:7"` 这样的串，任一依赖缺失就写成 `__INACTIVE__`；`_setEpoch()` 看到从 `__INACTIVE__` 变成别的就 `_reload()`（`:631-633`），其余任何变化——包括从一个非 `__INACTIVE__` 串变成另一个——都走 `_unload()`（`:634-637`），而 `_unload()` 收尾时若 epoch 已不是 `__INACTIVE__`，会再自动 `_reload()` 回来（`fiber.ts:688-694`）。后果值得记住：

- **依赖的提供方换了一个 fiber（uid 变了），epoch 就变，你的插件会被完整卸载重装。** 这不是 bug，是热重载能干净工作的原因（第 07 章）。
- `effect()` 自己的 disposer 是严格**逆序**串行执行的（`fiber.ts:431` 的 `.reverse()`）；fiber 整体 `_unload()` 时把 `_disposables.clear()` 拿到的逆序列表（`utils.ts:27-31` 的 `values.reverse()`）交给 `Promise.all` 并发跑（`fiber.ts:676`）——逆序决定的是启动顺序，不是串行等待。

## 6. plugin tree：`cordis.yml` 的一行 = 树上一个节点

Cordis 本体不认识 YAML，是 loader 插件把配置翻译成 `ctx.plugin()` 调用。上游那个最小启动器统共 16 行（`vendor/cordis/bin.js:1-16`，值得打开看一眼）：去掉 import 与 `baseUrl` 赋值，剩下的就是 `new Context()` → `ctx.plugin(Loader)` → `ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: './cordis.yml' } })`。dsh 的启动是同一个形状，只是 Include 那一行换成了内置 id（`packages/boot/app-boot/src/index.ts:764`、`:771`、`:518-523`）。配置里每一行叫一个 **Entry**（`vendor/loader/src/config/entry.ts:52`）：它自己也 `extend` 出一个 ctx（`entry.ts:67`），再把插件挂上去（`entry.ts:296` 的 `this.ctx.registry.plugin(...)`）。一行 Entry 的字段就那么几个（`entry.ts:9-22`）：`id` / `name` / `config` / `group` / `disabled` / `inject`，另加 loader 的 isolate 插件补的 `intercept` / `isolate`（`vendor/loader/src/config/isolate.ts:6-9`）。启动后的树：

```
root Context                                             app-boot/src/index.ts:764
└── Loader                                                                  :771
    └── Include(id: include)  ← 四层配置叠加后的那份清单，见第 02 章    :518-523
        ├── llm      @deepseek-ai/dsh-llm      provide 'llm'    base patch:24
        ├── session  @deepseek-ai/dsh-session  provide 'sessions'         :27
        ├── agent    @deepseek-ai/dsh-agent    provide 'agents'           :58
        └── …  dsh-base 这一层共 78 行 entry（当场数）
```

服务名不是猜的：`super(ctx, 'llm')` 在 `packages/llm/llm/src/index.ts:293`、`'sessions'` 在 `packages/core/session/src/index.ts:797`、`'agents'` 在 `packages/core/agent/src/index.ts:267`。

**树的深度不是模块层级，是作用域层级。** 兄弟节点之间没有先后，谁先 ACTIVE 完全由 `inject` 与 epoch 决定——这就是第 1 节那句 "Row order carries no load semantics" 的机制解释。

## 7. registry 与 service store：两张不同的表

新手最容易把它们当一个东西。索引对象、键、生命周期都不同：

| | registry | reflect store |
|---|---|---|
| 存什么 | 插件运行时 `Runtime{ name, fibers[], callback, Config }` | 服务实现 `Impl{ name, value, fiber, check }` |
| 键是什么 | 插件的可执行体（函数引用） | **一个 Symbol**，不是服务名字符串 |
| 定义 | `registry.ts:136-145` / `:197` | `reflect.ts:116-125` / `:209` |
| 谁写进去 | `ctx.plugin()`（`registry.ts:316`） | `ctx.provide()`（`reflect.ts:277`） |
| 何时清 | 最后一个 fiber 销毁时触发（`fiber.ts:270-274`）→ `registry.delete()`（`registry.ts:258-267`） | 提供方 fiber 卸载时（`reflect.ts:297-303`） |

服务表的键是 Symbol，这是下一节的全部前提。`provide()` 里 `reflect.ts:286-287` 两行先在根上给服务名分配一个 Symbol，再从**当前 ctx 的 isolate 映射**里取键：服务名 `'fs'` 只是用来查那张映射表的，真正的键是表给出的 Symbol。默认全局共用根上那一个，所以大家看到同一份 `ctx.fs`。

## 8. isolate realm：同一个名字，两份实现

场景是真实的：`minimal` 这个 agent preset 想让**只有这个 agent** 用裸的本地文件系统，进程里其它 agent 继续用宿主那份被沙箱包过的 `fs`（意图写在 `apps/cli/config/agent-presets/minimal/agent.cordis.yml:46-47` 的注释里）。配置这么写（同文件 `:48-57`）：

```yaml
- id: filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.env.DSH_CWD ?? process.cwd()
```

处理在 `vendor/loader/src/config/isolate.ts`：`true` = entry 本地 realm（`LocalRealm`，后缀 `#<entry id>`，`isolate.ts:48-57`）；写成字符串 = 具名 realm（`GlobalRealm`，后缀 `@<label>`，`isolate.ts:59-68`），**同 label 的多个 entry 共享一个 realm**（`isolate.ts:77-89`）。realm 只干一件事：给这个名字发一个新 Symbol（`isolate.ts:31-37`），塞进这棵子树的 isolate 映射（`isolate.ts:98-101`，新表的原型指向父表）。

```
root:  isolate = { fs: Symbol(fs), tools: Symbol(tools) }
  │      store[Symbol(fs)] = 宿主那份沙箱 fs;  store[Symbol(tools)] = 全局工具表
  └── filesystem group:  isolate = { fs: Symbol(fs#filesystem) } ← 原型指向 root 那张表
        ├── fs-local            provide('fs') → 写进 Symbol(fs#filesystem) 这一格
        └── str-replace-editor  ctx.fs    → 解析到 Symbol(fs#filesystem)（本地那份）
                                ctx.tools → isolate 表里无自有项，原型链继承到
                                            root 的 Symbol(tools)（全局那份）
```

`fs-local` 占的名字是 `'fs'`——它继承的 `FileSystem` 基类构造时调 `super(ctx, 'fs')`（`packages/fs/fs/src/index.ts:88`）；`str-replace-editor` 那行 `export const inject = ['tools', 'fs']`（`packages/fs/tool-str-replace-editor/src/index.ts:494`）正好一个来自 realm、一个来自全局。

**一次 isolate 只切一个名字**，其余服务照旧继承。这就是"给某个 agent 换掉文件系统、同时保留全局工具表"能一行配置搞定的原因。而 4.2 里那条看起来古怪的第 164 行——父 ctx 上这个名字的标签一旦不等于根表里的那个（也就是你已经进了某个 realm），上爬就停——正是防止子树里的插件顺着 fiber 链爬到父作用域去偷宿主那份实现。

顺带纠正一个容易想歪的地方：**这棵 preset 子树不是第 6 节那份启动清单里的兄弟节点**。它由 `dsh-agent-presets` 在运行时直接挂在 agent 的 scope 上下文下——`packages/preset/agent-presets/src/mount.ts:350` 的 `agentCtx.plugin(PresetTree, config)`，其中 `PresetTree` 是 `Include` 的子类，roster 自己那一行则在 `packages/bundle/web-app/cordis.patch.yml:421`。同一个 preset 文件里还有另一个 realm（`persistent-shell` 组 `isolate: { terminals: true }`，`:18-22`），机制完全一样。

## 9. 回答总问题：普通 DI 容器 / 中间件框架为什么不够

两个词先说清楚。**DI 容器**（dependency injection，依赖注入）：你不自己 `new` 依赖，而是声明"我要一个 X"，由容器在启动时把实例塞给你——Spring、NestJS 那一类。**洋葱中间件**：把一串处理函数套成同心圆，每个函数拿到 `next()`，可以在调用它前后各做点事，也可以不调用它从而截断后面所有层——Koa、Express 那一类。

| 维度 | 传统 DI 容器 | 洋葱中间件 | Cordis |
|---|---|---|---|
| 依赖解析时机 | 启动时一次成型 | 不管依赖 | 任意时刻，服务可来可走 |
| 依赖消失时 | 通常不表达 | — | 依赖方自动卸载，恢复后自动重装（`fiber.ts:625-639`） |
| 注册的回收 | 手写销毁钩子 | 手写 | 归属 fiber 自动逆序回滚（`fiber.ts:418-442`，逆序在 `:431`） |
| 归属判定 | 靠调用方自觉 | — | 服务方法里的 `this.ctx` 就是调用方（`utils.ts:176`） |
| 同名多实现 | 手工 qualifier / token | — | isolate realm，配置一行（`isolate.ts:77-89`） |
| 拓扑 | 类依赖图 | 一维数组 | 作用域树 |
| 拦截 | AOP 装饰器 | 全局一条 `next()` 链 | 具名 waterfall 事件（第 10 章有全表） |

> 表里"传统 DI 容器 / 洋葱中间件"两列是通用常识对照，不是从本仓库验证出来的；Cordis 那一列每格都有行号。

压成一句：**普通 DI 容器只有空间维度（谁依赖谁），洋葱中间件只有时间维度（先后顺序），Cordis 两个都要，而且要的是"运行中可变"的版本。** 这正对应论文标题里的 _Spatiotemporal Composability_（原文本章没读，只引标题）。那么"一切皆插件"这句口号，具体靠哪几个机制才成立？

| 口号里的分句 | 靠的机制 | 出处 |
|---|---|---|
| 任何能力都能被替换 | 按 name 解析服务，不 import 实现 | `reflect.ts:157-158` |
| 任何插件都能被卸载 | 注册即 effect，卸载逆序回滚 | `fiber.ts:418` / `:431` |
| 卸载不留残渣 | 服务方法在**调用方**的 ctx 上建 effect | `utils.ts:176` + `core/tools/src/index.ts:1057-1058` |
| 加载顺序不用人排 | `inject` → epoch → 自动 reload/unload | `fiber.ts:611-639` |
| 同名能力可以并存 | isolate realm 的 Symbol 索引 | `reflect.ts:286` + `isolate.ts:31` |
| 不改核心就能插进流程 | 事件多种派发模式，waterfall 可短路 | `events.ts:234-243` |
| 监听器按作用域过滤 | 每条监听记录自带 `ctx`，派发时按 filter 筛 | `events.ts:171-174` |

少任何一条，"一切皆插件"都会退化成"一堆插件加一个不能动的核"。

> 想知道这一点上 Pi / Codex / LangChain 怎么做，见 [三个 agent 系统源码解剖](../2026-08_三个agent系统源码解剖/00-总览与阅读指南.md)。

## 10. 三个最容易踩的坑

**坑一：把 `ctx` 存进模块级变量再共享。** 服务方法读的是调用方 ctx，你把自己的 `ctx` 传给别的模块去注册东西，等于把注册的归属也送出去了——那些注册记在**你的** fiber 上，你卸载时它们跟着消失，而对方毫不知情；反过来拿别人的 ctx 注册，你自己卸载时东西还在。规矩很简单：**谁的生命周期，用谁的 ctx**。

**坑二：以为读不到的服务会返回 `undefined`。** 不会，会抛（`reflect.ts:144` / `:163`）。想要"有就用"的语义必须显式走 `ctx.get(name)`（`reflect.ts:233`）。

**坑三：以为配置文件里的顺序就是加载顺序。** 不是。插件激活时机由 `inject` 与 epoch 决定（`fiber.ts:611-639`）。插件"没加载"时第一件事是查它是不是卡在 `PENDING`——在等谁，而不是去调行序。

## 11. 本章未确认

- ⚠️ **本章全部结论来自逐行读 `vendor/cordis/src/` 等源码文件，一行代码都没运行过**（仓库未安装依赖）；行为描述是静态阅读的结果，不是运行时观测。另，版本号对不上：`vendor/README.md:17` 的清单把 cordis 记作 `4.0.0-rc.7`，`vendor/cordis/package.json:4` 写的却是 `4.0.1`，而 `vendor/README.md:5` 又声称"upstream version numbers are deliberately unchanged"。没有去上游核对哪个是真实快照；本章一切以 `vendor/cordis/src/` 的实际代码为准。
- ⚠️ "Row order carries no load semantics" 是 `packages/bundle/base/cordis.patch.yml:12-13` 的注释声称。fiber 激活确由 inject/epoch 驱动这点在源码里成立，但"配置行序完全不影响任何可观测行为"这个更强的说法未验证：同一事件的监听器按注册先后派发（保序在 `events.ts:172-174`，`:255` 决定 push 还是 unshift），而注册先后取决于各 fiber 的激活先后——依赖都已满足时行序会不会就此体现为派发顺序，本章没有逐行验证。
- ⚠️ 第 8 节末尾的 preset 子树：挂载动作本身在代码里读到了（`packages/preset/agent-presets/src/mount.ts:350`），但"同一个 preset 每进程只挂一次、各会话靠 scope 父链共享这棵子树"这层更细的语义只来自 `packages/preset/agent-presets/README.md:5` 与 `:31` 的官方描述，其单飞与生命周期实现本章没有逐行核对。
- ⚠️ 论文 _A Programming Paradigm for Spatiotemporal Composability_ 只引了 `README.md:7` 里的标题与链接，没读原文；文中对"时空可组合性"的解释是笔者依据源码的转述。第 9 节对照表中"传统 DI 容器"与"洋葱中间件"两列同属通用背景知识，未在本仓库中取证。
