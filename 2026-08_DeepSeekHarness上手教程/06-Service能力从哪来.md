# 06 · Service：能力从哪来

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章只讲一件事：`ctx.tools` / `ctx.llm` / `ctx.fs` 这类挂在 `ctx` 上的能力是谁注册的、你怎么拿到它、拿不到时报错怎么读。事件系统（`ctx.on`、waterfall）在第 09、10 章。

**读完这章你会**：

- 指出任意一个 `ctx.<名字>` 是哪个包、哪一行注册上去的
- 用 `inject` 声明依赖，并说清不声明为什么会直接抛错，而不是拿到 `undefined`
- 用 `Service` 子类或 `ctx.provide()` 提供自己的服务，并用 declaration merging 让 TypeScript 认识它
- 读懂启动时的 `dsh: 1 entry did not activate … pending (waiting for service: x)`，并定位到底缺谁
- 判断什么时候该给一组插件开 isolate realm，什么时候开了反而把消费者甩到 realm 外面

## 1. 先看一次报错

你写了个插件想读文件，直接这么写：

```ts
export async function apply(ctx: Context) {
  const target = await ctx.fs.resolve('README.md')
  console.log(await ctx.fs.readText(target))
}
```

（`ctx.fs` 上没有 `read()` 这种一步到位的方法：先 `resolve(path)` 拿到一个 `FsTarget`，再 `readText(target)`。抽象签名在 `packages/fs/fs/src/index.ts:116,176`，真实调用方照抄 `packages/fs/tool-str-replace-editor/src/index.ts:97,234`。`apply` 可以是 async，harness 里有的是这种写法，例如 `packages/mcp/mcp-client/src/index.ts:140`。）它在 `ctx.fs` 这个属性读上就炸了，抛的是：

```
Error: cannot get property "fs" without inject
```

这条消息在 `vendor/cordis/src/reflect.ts:144`。注意它不是"`ctx.fs` 是 undefined 然后 `.resolve` 炸了"——`ctx` 根本不是普通对象，而是 `new Proxy(this, ReflectService.handler)`（`vendor/cordis/src/context.ts:74`），handler 装了 `get` / `set` / `has` 三个陷阱（`vendor/cordis/src/reflect.ts:135-206`）。读一个没声明过的服务名，陷阱直接抛。启动时你在终端看到的也不是这行光秃秃的报错：dsh 会把它收进第 6 节那套启动诊断里，连整段 stack 一起打印（收集在 `packages/boot/app-boot/src/index.ts:701-707`，格式化在 `:676-678`；stack 首行被 `vendor/cordis/src/reflect.ts:73-78` 重写成 `Error: <message>`）。

**服务（Service）就是一个插件挂到 `ctx` 上、供别的插件按名字取用的能力**（`docs/cordis-tutorial/03-services.md:5`）。消费方写的是名字 `'fs'`，不是 `import` 某个实现类——这就是依赖注入（DI）：谁来实现由配置决定，消费者代码不动。dsh 把这套叫 seam：一个 Service Definition（拥有 `ctx.<key>` 的那个 `Service` 类，可以是抽象类，也可以是具体注册表）+ 若干 Provider + 若干 Consumer（`docs/glossary.md:9`）。

harness 的主干能力都能追到一行 `super(ctx, '<名字>')`——`packages/` 下共 67 处（`grep -rn "super(ctx, '" packages/ --include=*.ts`，2026-08-14 数，已排除测试目录）；另有 21 处 `ctx.provide(...)` 直接挂裸值，见第 3 节。你最常碰到的十个：

| `ctx.<名字>` | `super(ctx, …)` 所在行 | 形态 |
|---|---|---|
| `tools` | `packages/core/tools/src/index.ts:827` | 具体注册表 `ToolRuntime`（类在 `:787`） |
| `llm` | `packages/llm/llm/src/index.ts:293` | 具体注册表 `LlmRuntime`（`:284`） |
| `agents` | `packages/core/agent/src/index.ts:267` | 具体注册表 `AgentRegistry`（`:256`） |
| `sessions` | `packages/core/session/src/index.ts:797` | 具体注册表 `SessionStore`（`:792`） |
| `systemPrompt` | `packages/core/system-prompt/src/index.ts:354` | 具体注册表 `SystemPrompt`（`:338`） |
| `approval` | `packages/interaction/user-approval/src/index.ts:198` | 具体注册表 `ApprovalService`（`:192`） |
| `tokenMeter` | `packages/llm/token-meter/src/index.ts:82` | 具体注册表 `TokenMeter`（`:74`） |
| `fs` | `packages/fs/fs/src/index.ts:88` | **抽象基类** `FileSystem`（`:86`）；实现有 `packages/fs/fs-local/src/index.ts:64`（`super(ctx)` 在 `:80`）、`packages/e2b/fs-e2b/src/index.ts:171` |
| `shell` | `packages/shell/shell/src/index.ts:67` | **抽象基类** `ShellExecutor`（`:65`）；实现有 `packages/shell/bash-local/src/index.ts:102`（`super(ctx)` 在 `:123`）、`packages/shell/pwsh-local/src/index.ts:128` |
| `jobs` | `packages/jobs/jobs/src/index.ts:70` | **抽象基类** `JobRegistry`（`:62`）；实现有 `packages/jobs/jobs-local/src/index.ts:91` |

抽象那三行是重点：`FileSystem`、`ShellExecutor`、`JobRegistry` 自己不干活，只定义契约；子类的 `super(ctx)` 把自己注册成 `ctx.fs` / `ctx.shell` / `ctx.jobs`。换沙箱实现只需要在配置里换一行，所有消费者不动。`JobRegistry` 还多挡了一道：`abstract` 在运行时会被擦掉，所以它在构造函数里检查 `new.target`，把抽象包直接写进配置会当场抛 `@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead`（`packages/jobs/jobs/src/index.ts:67-69`）。

> 想知道这一点上 Pi / Codex / LangChain 怎么做，见 [三个 agent 系统源码解剖](../2026-08_三个agent系统源码解剖/00-总览与阅读指南.md)。

## 2. 消费：`inject` 是开关，不是文档

```ts
export const inject = ['fs']

export async function apply(ctx: Context) {
  const target = await ctx.fs.resolve('README.md')
  console.log(await ctx.fs.readText(target))
}
```

`inject` 一行同时买到三件事（`docs/user/develop/framework/service.md:32`、`docs/cordis-tutorial/03-services.md:59,76`）：

1. **等**：服务没齐，插件停在 PENDING 不执行 `apply`，配置里的先后顺序完全不影响结果。
2. **保证**：`apply` 跑起来时，声明过的每个服务都已就绪。
3. **回滚**：运行中依赖消失（provider 被卸载或热替换），依赖方自动卸载，服务回来时再自动装回来。

### 为什么不声明就读不到

`get` 陷阱拿不到属性时，会沿 **fiber 链向上走**（`vendor/cordis/src/reflect.ts:153-166`）。fiber 是一个插件实例的运行时作用域（第 04、07 章）：

```
ctx.fs  ── Proxy get 陷阱 (reflect.ts:136)
  │
  ├─ 本 fiber 的 store 里有 'fs' 吗？        reflect.ts:157
  │     store 只装两种东西：本插件 inject 声明过的（fiber.ts:608,647）
  │                        + 本 fiber 自己 provide 出去的（reflect.ts:293）
  ├─ 'fs' 在本 fiber 的 inject 里但没值？    → 抛 "in inactive context"  reflect.ts:159-160
  ├─ 已经是根 fiber（没有 runtime）？        → 抛 "without inject"       reflect.ts:163
  ├─ 父 fiber 的 isolate['fs'] 不是同一个？  → 跨 realm，抛              reflect.ts:164
  └─ 换成父 fiber，回到第一步                reflect.ts:165
```

结论是硬的：**不声明就能读到的，只有祖先 fiber 的 store 里已经有的那些**——祖先自己 `provide` 出去的，或祖先 `inject` 声明过的。同级插件 provide 的读不到。harness 的服务插件和你的插件在配置树里通常是兄弟关系，所以 `inject` 不是礼貌用语，是唯一通路。（注意区分：声明过的服务解析走的是另一条路——全局 store 按 isolate symbol 直接查表，`vendor/cordis/src/reflect.ts:237-243`——所以兄弟插件提供的服务，声明了就拿得到；走 fiber 链的只有"没声明还硬读"这一种情况。）

一个例外要知道：根 context 的 fiber 没有 runtime（`vendor/cordis/src/context.ts:77` 建根 fiber 时 runtime 传的就是 `null`），读取直接绕过整套检查，而且是 `strict = false`——连没 ACTIVE 的 provider 也照给（`vendor/cordis/src/reflect.ts:152`）。你在 boot 脚本或 REPL 里 `ctx.tools` 能用，在插件里同样写法炸掉，原因就在这。

### 三种消费方式

| 写法 | 语义 | 出处 |
|---|---|---|
| `export const inject = ['a', 'b']` | 硬依赖；缺一个就整个插件 PENDING | `vendor/cordis/src/registry.ts:105-106`、`:330` |
| `ctx.get('a')` | 软探测；没有就返回 `undefined`，本插件照常运行 | `vendor/cordis/src/reflect.ts:233`、`docs/cordis-tutorial/03-services.md:82-89` |
| `ctx.inject(['a'], (ctx2) => {…})` | 开一个子 fiber，只有这段代码等依赖 | `vendor/cordis/src/registry.ts:300-302` |

第三种在 harness 里不是边角料：`packages/` 下有 43 处 `ctx.inject(` 调用（`grep -rn "ctx\.inject(" packages/ --include=*.ts`，2026-08-14 数，已排除测试）。`packages/storage/storage-domain/src/index.ts:201-206` 是典型——依赖名是从配置算出来的，写不进静态 `inject`：

```ts
const backendServices = [...new Set([
  config.backend,
  ...Object.values(config.routes ?? {}),
])].map(storageBackendServiceKey)

const fiber = ctx.inject(backendServices, (domainCtx) => { /* … */ })
```

`storageBackendServiceKey('json')` 就是字符串 `'storage.backend.json'`（`packages/storage/storage/src/index.ts:26-28`）。服务名可以是任意字符串，不必是 TypeScript 里声明过的键。

`ctx.get()` 有个隐藏语义：第二个参数 `strict` 默认 `true`（`vendor/cordis/src/reflect.ts:233`），provider 的 fiber 不是 ACTIVE 就返回 `undefined`（`:241`）。所以 `ctx.get('x') === undefined` 有两种含义——"没人提供"和"提供者自己还没起来"——第 6 节会用到这个区别。

## 3. 提供：两种形状

**形状一：`Service` 子类**（harness 的主干服务都是这个形状）。构造函数里 `super(ctx, name)` 就完成注册：

```ts
export class TokenMeter extends Service {
  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
  }
}
```

节选自 `packages/llm/token-meter/src/index.ts:74,81-82`（省略了 `static Config`、私有字段和构造函数其余语句）。`Service` 构造函数的最后一步是 `self.ctx.reflect.provide(name, self, this[symbols.check])`（`vendor/cordis/src/service.ts:57`，其后只剩 `return self`）——注册本身是一次 effect（一个自带反向操作的注册动作，`vendor/cordis/src/reflect.ts:278`），插件卸载时自动注销（第 07 章）。`Service` 子类本身就是一个插件（`docs/cordis-tutorial/03-services.md:42`），`ctx.plugin(TokenMeter)` 或在 yml 里写一行都能挂载——TokenMeter 就是 `export default`（`packages/llm/token-meter/src/index.ts:313`），配置里按包名挂在 `packages/bundle/base/cordis.patch.yml:282`。

服务可以依赖服务：`ToolRuntime` 用 `static inject = ['systemPrompt']`（`packages/core/tools/src/index.ts:788`），于是 `ctx.tools` 只在 `ctx.systemPrompt` 就位后才出现。

**形状二：`ctx.provide(name, value)`**，直接挂一个裸值，适合不需要类的注册表或纯数据：

```ts
ctx.provide(storageBackendServiceKey('json'), backend)
```

出自 `packages/storage/storage-json/src/index.ts:113`；签名与契约在 `vendor/cordis/src/reflect.ts:44,277`。

两个必须知道的行为：

- **重名会 fail loud**（当场抛，不静默覆盖）。同一 isolate 作用域里注册第二次直接抛 `service "x" has been registered at <…>`（`vendor/cordis/src/reflect.ts:289-291`）。`ctx.shell` 把这条写成了设计约束：一个 host 只组合一个 provider，win32 层用 pwsh 那套换掉 POSIX 那套，两套同时挂会当场炸（`packages/shell/shell/src/index.ts:16-18`；`ShellExecutor` 的类注释在 `:47-50` 又说了一遍）。
- **注册时机即可见时机**。fiber 已经 ACTIVE 时 `provide` 会立刻 `notify` 唤醒等待者（`vendor/cordis/src/reflect.ts:294-295`），注销时同样 `notify` 一遍再等依赖方收拾完（`:297-303`）。

## 4. 让 TypeScript 认识它：declaration merging

运行时注册和类型声明是两件独立的事。类型这一半靠 TypeScript 的 declaration merging——往 `Context` 接口上补一个字段：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenMeter: TokenMeter
  }
}
```

原样出自 `packages/llm/token-meter/src/index.ts:67-71`，`ctx.tools` 用的是同一招（`packages/core/tools/src/index.ts:137-140`）。

**这段不生成任何代码**（`docs/cordis-tutorial/03-services.md:40`）。少写它，服务照样能用，只是所有消费者失去类型；写了它但插件没挂载，`ctx.tokenMeter` 类型检查通过、运行时照样抛。类型是编译期的承诺，`inject` 才是运行时的开关，两者谁也不保证谁。

还有一条命名约束：服务名在一个应用里是**全局扁平命名空间**，harness 已经占了 `tools`、`llm` 这类朴素名字（`docs/cordis-tutorial/03-services.md:94`；第 1 节表里的 `fs`、`shell`、`jobs` 同理）。自己的服务加前缀，否则撞名就是上面那条 fail loud。

## 5. 完整示例：一个插件提供，另一个插件注入

改编自 `docs/cordis-tutorial/03-services.md:11-66`（服务代码）与 `docs/user/develop/basic/index.md:48-61`（挂载到 Web profile 的方式）。放在仓库根下的 `scratch-plugin/`。

`scratch-plugin/src/greeter.ts`：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string) {
    return `Hello, ${who}!`
  }
}

export const name = 'greeter'

export function apply(ctx: Context) {
  ctx.plugin(GreeterService)
}
```

`scratch-plugin/src/greeter-consumer.ts`（官方那份的文件名与 `name` 都叫 `consumer`，这里只是换了个名字）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'greeter-consumer'
export const inject = ['greeter']

export function apply(ctx: Context) {
  console.log(ctx.greeter.greet('world'))
}
```

`scratch-plugin/cordis.yml`（官方示例只插一行，这里插两行；路径必须是绝对路径，patch 文件不改变 loader 的解析根目录，见 `docs/user/develop/basic/index.md:56`）：

```yaml
- insert:
    - id: greeter
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/greeter.ts'
    - id: greeter-consumer
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/greeter-consumer.ts'
```

启动（`web` 子命令与 `--patch` 的定义在 `apps/cli/src/args.ts:156,163`；`pnpm dsh` 脚本在根 `package.json:136`）：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

启动日志里应出现 `Hello, world!`。三个可以自己做的验证：

1. **交换 yml 里两行的顺序**，输出不变——顺序由依赖决定，不由文件行号决定（`docs/cordis-tutorial/03-services.md:59`）。
2. **删掉 `greeter` 那一行**，consumer 进入 PENDING（下一节讲它长什么样）。
3. **把 consumer 的 `inject` 那行删掉再跑**，`ctx.greeter` 抛 `cannot get property "greeter" without inject`——因为两个插件是兄弟，不是祖孙。

## 6. 依赖没就绪：PENDING 长什么样

fiber 的状态机只有六个格子（`vendor/cordis/src/fiber.ts:147-154`、`docs/user/develop/framework/index.md:17-24`）：

| 状态 | 含义 |
|---|---|
| PENDING | 已登记，依赖没齐（fiber 的初始状态，`fiber.ts:194`） |
| LOADING | 依赖齐了，`apply` 正在跑 |
| ACTIVE | 跑起来了 |
| FAILED | `apply` 或 config 解析抛了（`fiber.ts:142-145`） |
| UNLOADING / DISPOSED | 正在卸载 / 已卸载 |

PENDING 不是错误状态——provider 可能几秒后才挂上，所以 Cordis 本体对它一声不吭（`docs/cordis-tutorial/06-composition-and-hmr.md:63`）。dsh 不接受这种沉默：`boot()` 在配置树 settle 之后跑一遍 `assertEntriesActivated`（`packages/boot/app-boot/src/index.ts:782-784`），把没转成 ACTIVE 的 entry 全部抓出来抛掉（函数体 `:692-725`，契约见 `packages/boot/app-boot/README.md:15,26`）。

缺依赖时你会看到的这行，模板在 `packages/boot/app-boot/src/index.ts:713` 和 `:723`，前缀 `dsh` 来自 `apps/cli/src/profile-boot.ts:41`（`const NAME = 'dsh'`，在 `:248` 传给 `boot()`）：

```
dsh: 1 entry did not activate
/abs/path/scratch-plugin/src/greeter-consumer.ts: pending (waiting for service: greeter)
```

**怎么读这条**：冒号左边是 entry 的 `name`（模块说明符，本地插件就是绝对路径，`vendor/loader/src/config/entry.ts:12-13`），括号里是"我 inject 了但 `ctx.get()` 取不到"的服务名列表。计算方式是 `Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)`（`:711`）——注意它用的是那个 fiber 自己的 ctx，所以 realm 隔开的情况也照实反映。单复数是算出来的（`:712`）：缺一个是 `service`，缺零个或多个是 `services`。

三种常见成因，对应三种查法：

| 症状 | 原因 | 怎么查 |
|---|---|---|
| `waiting for service: X` 且配置里确实没有 X 的 provider | 忘了挂 provider 包 | `dsh web --dump-config` 看合成后的配置里有没有那一行（非 web profile 用 `dsh --profile <name> --dump-config`；裸 `dsh --dump-config` 会因为缺 `--profile` 直接报错，`apps/cli/src/args.ts:133,138-140,164`；第 02 章） |
| `waiting for service: X` 但 provider 明明写了 | provider 自己也 PENDING/FAILED（它的依赖没齐），或者你和它不在同一个 realm | 看报错里有没有第二行；再看第 7 节的 realm |
| `waiting for services: unknown` | `missing` 算出来是空列表（`:713` 的 `\|\| 'unknown'` 兜底） | 见下 |

`unknown` 值得单说。`ctx.get()` 只看 provider 的 fiber 是不是 ACTIVE（`vendor/cordis/src/reflect.ts:241`），而 fiber 判定依赖是否满足时还会额外调用 provider 的 `[Service.check]` 谓词，谓词返回 false 或抛异常都算不满足（`vendor/cordis/src/fiber.ts:597-608`）。于是可能出现"`ctx.get()` 拿得到、依赖判定却不通过"——诊断里就只剩 `unknown`。这个谓词不是摆设：Loader 自己就实现了一个，`await` 拦截配置打开且还有在跑的任务时返回 false（`vendor/loader/src/index.ts:166-170`，注册在 `:90`）。

还有个作用域边界要记住：`assertEntriesActivated` 只遍历 `ctx.loader.entries()`（`:696`），也就是配置文件里的行。插件内部用 `ctx.plugin()` / `ctx.inject()` 开出来的子 fiber 卡在 PENDING，**启动诊断一个字都不会说**。想看这一层，两条路：

- 问 agent 自己。`@deepseek-ai/dsh-tool-cordis` 的 `cordis_inspect` 会把当前进程里的服务和所有活着的 fiber 列出来（`packages/extensions/tool-cordis/README.md:11`；状态数值映射在 `packages/extensions/tool-cordis/src/fiber-state.ts:12-18`）。它挂在 `cordis` 这个 agent preset 里（`apps/cli/config/agent-presets/cordis/agent.cordis.yml:245-246`），且依赖 `@deepseek-ai/dsh-cordis-host-runner` 提供的 `ctx.dynamic`（web 侧挂在 `packages/bundle/web-app/cordis.patch.yml:102-103`）——没有 runner，这套工具根本不会激活（`packages/extensions/tool-cordis/README.md:5`）。
- 自己写个诊断插件遍历 `ctx.registry.values()` 里每个 runtime 的 `fibers`，官方示例在 `docs/cordis-tutorial/06-composition-and-hmr.md:67-83`。

## 7. isolate realm：同一个名字，两份实例

服务名并不是直接当 key 用的。每个 context 上挂着一张 `服务名 → symbol` 的映射表（`vendor/cordis/src/context.ts:18`），reflect 的 store 用那个 symbol 当键（声明在 `vendor/cordis/src/reflect.ts:209`，查表在 `:238-239`）。`ctx.isolate(name)` 做的事就是给这个名字换一个新 symbol（`vendor/cordis/src/context.ts:121-125`）：换了 symbol，下面的插件读同一个名字就落到另一份实例上，父作用域毫发无伤。

配置里的写法是 entry 的 `isolate` 字段（`vendor/loader/src/config/isolate.ts:8`），值有两种：

| 写法 | realm 类型 | symbol 描述 | 代码 |
|---|---|---|---|
| `isolate: { fs: true }` | LocalRealm，本 entry 私有 | `fs#<entry id>` | 分支 `isolate.ts:81-82`，后缀 `:54-56` |
| `isolate: { fs: 'my-label' }` | GlobalRealm，同标签的 entry 共享 | `fs@my-label` | 分支 `:83-84`，后缀 `:65-67` |

真实用例，`minimal` agent preset 拿本地裸文件系统盖掉 host 的沙箱实现，只在这个 preset 内生效——文件自己的注释就是这么写的（`apps/cli/config/agent-presets/minimal/agent.cordis.yml:46-47`）。下面是原文 `:48-60`（`str-replace-editor` 的 `config` 在 `:61-62`，略）：

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

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
```

（`!!js` 是 loader 的惰性表达式，第 08 章讲；这里当普通配置看就行。）**这里最容易踩的**：realm 是加在 group 上的，provider 和 consumer 必须一起被包进这个 group。编辑器 `str-replace-editor` 和 `fs-local` 写在同一个 `config` 列表里不是排版习惯——落在 group 外面的消费者会解析到 host 那份实例，或者干脆没人提供而 PENDING。`standard` preset 的注释把这条写死了："a consumer left outside would resolve a host registry this preset does not populate"（`apps/cli/config/agent-presets/standard/agent.cordis.yml:166-167`）。`cordis:group` 这个内置行的存在理由就是"把 provider 和它的 consumer 一起放进同一个 realm"（`packages/boot/app-boot/README.md:30`）。

**什么时候该开**：这份 preset 里三个 realm 各自给了理由——`planMode` 因为计划状态天然是 per-agent 的（`:102-108`）、`compaction` 连同 `toolResultPruner` 一起隔离，因为 `compaction-basic` 用 `this.ctx.get('toolResultPruner')` 读 pruner（`packages/compaction/compaction-basic/src/index.ts:281`，服务注册在 `packages/compaction/compaction-tool-result-pruner/src/index.ts:59`），不同 realm 就读不到（`:128-142`；顺带一提，preset 注释里把服务名写成了 `toolResultPrune`，少个 r，以 `isolate` 那两行和代码为准）、`workflowEngine` 因为没有 agent 之外的东西读它（`:166-178`）。反例同样写得很清楚：`tokenMeter` 故意留在 host 平面，因为浏览器要跨会话读它的投影单元，塞进 realm 会随 preset 挂载来去（`:131-136`）。

一句话判据：**这份状态的生命周期是不是就等于这一组插件的生命周期**——是就开 realm，不是就别开，realm 会让所有外部消费者看不见你。

## 8. 本章未确认

- ⚠️ 本章没有实机运行过任何命令（仓库未装依赖）。第 1、2 节的 `ctx.fs` 片段按 `packages/fs/fs/src/index.ts:116,176` 的抽象签名与 `packages/fs/tool-str-replace-editor/src/index.ts:97,234` 的真实调用写成，但没跑过；第 5 节的示例代码逐段来自 `docs/cordis-tutorial/03-services.md:11-66` 与 `docs/user/develop/basic/index.md:48-61`，"启动日志里出现 `Hello, world!`"这个结果是照两处文档的同类流程推出来的，未实机验证。
- ⚠️ 第 6 节那段报错文本是按 `packages/boot/app-boot/src/index.ts:713,723` 的模板加 `apps/cli/src/profile-boot.ts:41` 的 binName 拼出来的示意，不是抄自真实终端输出；实际 entry 名取决于你怎么写配置。
- ⚠️ "`waiting for services: unknown` 可能由 `[Service.check]` 返回 false 造成"是我从 `packages/boot/app-boot/src/index.ts:711` 与 `vendor/cordis/src/fiber.ts:597-608` 两处代码推的，未实机复现。谓词本身有真实实现（`vendor/loader/src/index.ts:166-170`），但 `packages/` 下一处都没有（2026-08-14 `grep -rn "\[Service.check\]" packages/`），所以这条路径在插件侧是否真会触发，我没有现成用例可指。
- ⚠️ GlobalRealm 的回收时机（`vendor/loader/src/config/isolate.ts:155-172` 的 `loader/partial-dispose` 处理）只读了代码，未验证多 preset 共享标签时的实际行为。
