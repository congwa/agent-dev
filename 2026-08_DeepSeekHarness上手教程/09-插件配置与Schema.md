# 09 · 插件配置与 Schema

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。正文只讲机制；可照抄的代码统一收在文末[附录](#附录可以照抄的模板)，出处收在[脚注](#出处)，点角标可跳转。

关于配置，最常见的误解是：改一次配置，就是把新值塞进正在跑的插件里。

不是的。dsh 改配置的动作是**把旧实例整个卸掉、用新配置装一个新的**。这个心智模型先立在这，本章一半的现象都从它推出来。

立住它之前，先看配置这件事的两种痛苦。

一种是启动直接炸，吐出三四层嵌套的报错，看不出到底是 schema 不满意、插件自己抛的，还是依赖压根没就绪。

另一种更难受：**没报错，但你配的东西就是没生效。**

这章追的是同一条链路：`cordis.yml` 里那个 `config:` 块，怎么变成 `apply` 的第二个参数——中间经过哪几道手续，每道手续出错时你在终端上看见什么。

整条路的形状是：YAML 里的字面量先被四层 patch 揉成一份 raw config，等 `inject` 就绪后再依次穿过插值和校验两道门，最后才落到 `apply` 的第二个参数上。

```mermaid
flowchart TD
    Y["<b>cordis.yml 里的字面量</b><br/>!!js 标量在解析期就变成表达式节点"]
    P["<b>四层 patch 按顶层键覆盖</b><br/>config 整块顶替，不深合并"]
    RAW["<b>entry 的 raw config</b><br/>表达式节点原封不动躺着"]
    G{"<b>inject 声明的服务齐了吗</b>"}
    PEND["<b>停在 PENDING</b><br/>配置压根没被求值"]
    W["<b>waterfall internal/config</b><br/>interpolate 把表达式换成求值结果"]
    S["<b>resolveConfig 过 schema</b><br/>校验类型，填默认值"]
    AP["<b>apply 拿到第二个参数</b><br/>永远是完整的、已校验的配置"]

    Y --> P --> RAW --> G
    G -- "缺一个就不动" --> PEND
    G -- "齐了" --> W --> S --> AP

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class P,RAW,G,W,S main
    class AP data
    class Y entry
    class PEND note
```

---

## 什么该写死，什么该做成配置

你的插件里写死了一个 30 秒的超时常量。两台机器想要不同的值，于是你开始想"读环境变量吧"。

dsh 的规矩是反过来的：**两个部署可能想设成不同值的东西，一律做成配置字段**。判据只有一句——能不能不改代码、只改 `cordis.yml` 就换掉这个值[^1]。

环境变量不是不能用。但它的正确位置在 `cordis.yml` 里（后面 `!!js` 那节会讲），不在你的插件源文件里。

## 一个可配置插件只需要三个导出

`name`、`Config` 类型、`Config` schema，就这三样。完整形状照抄[附录 A](#a-一个可配置插件的三个导出)[^2]。

类型和 schema 同名不是笔误，是故意的：使用方拿走类型，Cordis 拿走运行期校验器[^3]。TypeScript 的类型空间和值空间互不打架，同名合法。

### Cordis 认的不是 Schemastery，是 Standard Schema

Standard Schema 是一个跨校验库的最小接口约定，核心就一条：校验器对象上挂一个 `~standard` 属性。

你导出的那个 `Config` 从模块走到校验点，是这么一条链：注册插件时，注册表把它原样存进这个插件的 runtime 记录，字段类型写的就是 Standard Schema 的接口；轮到校验时，fiber 从那条记录上取出 `~standard` 底下的校验函数来调[^4]。

这里的归属关系值得单独看一眼：你导出的东西先过 loader 的一道取值，才进注册表，最后在 fiber 里被当成校验器用。

```mermaid
flowchart LR
    M["<b>你的模块</b><br/>name、Config 类型、Config schema"]
    D{"<b>loader 取 exports.default ?? exports</b>"}
    ND["<b>没有默认导出</b><br/>具名导出直接生效"]
    HD["<b>写了默认导出</b><br/>只认那个对象上的属性，散在外面的失效"]
    REG["<b>注册表存下 plugin.Config</b><br/>字段类型是 StandardSchemaV1"]
    V["<b>fiber 取 Config 的 ~standard.validate</b><br/>普通对象没有这个属性，直接炸"]

    M --> D
    D -- "无" --> ND
    D -- "有" --> HD
    ND --> REG
    HD --> REG
    REG -- "读" --> V

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class D,ND,V main
    class REG data
    class M entry
    class HD note
```

由此推出四条实用后果：

- **不能拿一个普通对象充当 schema 导出。** 普通对象上没有 `~standard`，校验那一步直接炸[^5]。
- 本仓库用 Schemastery 实现这个接口[^6]，但 Cordis 本身接受任何 Standard Schema 校验器，你想换别的库是可以的。
- **类形式的插件把校验器挂成同名的静态属性**，仓库里有现成实例[^7]。
- **默认导出会吃掉具名导出。** loader 取模块时先看有没有默认导出，有就只认它[^8]。你一旦写了默认导出，`Config`、`inject`、`name` 就必须挂在那个默认导出的对象上，散在外面的具名导出不再生效。

### 构造器就这么十来个

全部构造器的声明和解析器位置见脚注[^9]：

| 写法 | 作用 |
|---|---|
| `Schema.object` | 对象 |
| `Schema.string` / `Schema.number` / `Schema.boolean` | 基础类型 |
| `Schema.array` / `Schema.dict` / `Schema.tuple` | 集合 |
| `Schema.union` | 枚举 / 多形态 |
| `.default` | **默认值就写在这** |
| `.required` | 缺了就报错 |
| `.min` / `.max` / `.pattern` | 范围与正则 |
| `Schema.any` | 放行整块（转交给别的库校验） |

### 默认值只写在 schema 上

不要在 `apply` 里自己写"取不到就用兜底值"的口袋逻辑[^10]。用户省略了某个字段时，校验器会把默认值填进去再交给 `apply`，所以 `apply` 拿到的永远是完整的、已校验的配置[^11]。

反向也成立：配置写回文件时，loader 会调 schema 的简化方法把等于默认值的字段删掉[^12]。

### 字段名打错，没有任何人会告诉你

这是本章第一个静默失败，也是"我明明配了怎么没生效"最常见的成因。

`Schema.object` 的解析器在非 strict 模式下分两步走：先按你声明的字段逐个解析（缺了就填默认值），然后把你**没声明的键原样合并进结果**——一声不吭[^13]。

于是 `cordis.yml` 里把 `greeting` 拼成 `greetng`，加载期零诊断：`greetng` 静静躺在 config 里没人读，`greeting` 用了默认值。

先怀疑拼写，别急着怀疑加载顺序。

## 校验发生在什么时候：先插值，再校验，最后 apply

这个顺序是硬编码的，不是约定俗成。

> 两个前置名词：waterfall 是 Cordis 的洋葱式事件派发，一串监听器依次拿到值、可以改写后再传给下一个（第 10、11 章展开），这里只需要知道它是"配置在到达 schema 之前经过的一道可改写管道"；fiber 是一个插件实例的运行期句柄（第 05 章），下面几个状态名都挂在它身上。

fiber 创建后先卡在一道门上：`inject` 声明的服务缺一个，它就什么都不做。服务齐了才进重装流程，配置依次过两道手续——先让那条配置 waterfall 把 `!!js` 表达式换成求值结果，再过 schema 校验、填默认值——最后才轮到 `apply`。这两道手续在源码里就挤在相邻的两行上[^14]。

PENDING 的判定是：只要 `inject` 里有一个服务缺席，重装流程根本不跑。对外的那两个状态名也是推出来的——错误槽有值就是 FAILED，没到启动条件就是 PENDING[^15]。

热更新路径遵守同一条纪律：fiber 不处于 ACTIVE 时**推迟**求值，源码注释直说原因是 config 解析可能访问注入的服务[^16]。

没导出 `Config` 的插件呢？校验入口第一行就检查有没有 schema，没有就原样放行[^17]。**没有 schema，就没有校验，也没有默认值**——用户写什么你收什么。

官方文档对这一步的说法是"schema 在插件加载期间运行，非法配置以可操作的错误让加载失败"[^18]。

### 改一次配置就是一次 HMR

现在回到开头那个心智模型。改配置时框架做的事是：卸载旧实例、加载新实例[^19]。不是给正在跑的插件换个变量值。

热更新那条路的形状是：先看 fiber 在不在 ACTIVE，不在就把求值推迟，在就卸旧装新。

```mermaid
flowchart TD
    CH["<b>改了一行 config</b>"]
    U["<b>fiber.update(config)</b><br/>新的 raw config 先存起来"]
    Q{"<b>fiber 现在是 ACTIVE 吗</b>"}
    DEF["<b>推迟求值</b><br/>因为解析 config 可能访问注入的服务"]
    RS["<b>_resolveConfig 重跑一遍</b><br/>插值 + schema 校验，和冷启动同一条路"]
    UN["<b>卸掉旧实例</b><br/>注册全是 effect，一并撤销不留残渣"]
    NEW["<b>用新配置装一个新实例</b><br/>apply 从头装一遍，不需要 diff 逻辑"]

    CH --> U --> Q
    Q -- "否" --> DEF
    Q -- "是" --> RS --> UN --> NEW

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class U,Q,RS,UN main
    class NEW data
    class CH entry
    class DEF note
```

这件事之所以敢这么干，靠的是第 08 章讲的 effect——插件的所有注册都是 effect，旧实例卸载时一并撤销，不会残留。所以你写插件时不需要为"配置变了"准备任何 diff 逻辑，`apply` 里按新配置从头装一遍就是对的。

反过来，这也解释了为什么配置改动会走一遍完整的 PENDING 判定和 schema 校验：新实例和冷启动的实例走的是同一条路。

## 配错了终端上长什么样

报错信息是一层层加前缀攒出来的。拿官方教程那个把数组字段写成一句字符串的例子，一路看下去。

四层前缀是从里往外一层层套上去的，`apply` 自己抛的异常从第三层起并进同一条路：

```mermaid
flowchart TD
    E1["<b>schema 校验不通过</b>"]
    E2["<b>apply 自己抛异常</b>"]
    L1["<b>① Schemastery</b><br/>路径前缀 + 期望什么拿到什么，一次只出一条"]
    L2["<b>② Cordis ValidationError</b><br/>invalid config: 加一行 issue"]
    L3["<b>③ Loader entry 包装</b><br/>补上是哪一行、哪个 stage 炸的"]
    F["<b>fiber 进 FAILED</b>"]
    O1["<b>④a 启动窗口内被 boot 接住</b><br/>plugin tree failed to load"]
    O2["<b>④b 树 settle 之后的审计</b><br/>N entries did not activate"]

    E1 --> L1 --> L2 --> L3
    E2 --> L3
    L3 --> F
    F -- "已过 _start 的 await 与否，本章未实跑区分" --> O1
    F --> O2

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class L1,L2,L3 main
    class E1,E2 entry
    class F danger
    class O1,O2 note
```

**第一层，Schemastery。** 给出路径前缀和"期望什么、拿到什么"[^20]：

```
$.targets expected array but got not-an-array
```

**第二层，Cordis 的 `ValidationError`。** 把 issue 列成"一条消息带一个路径"的形状[^21]：

```
ValidationError: invalid config:
  - $.targets expected array but got not-an-array (at targets)
```

这一段与官方教程贴出来的输出逐字一致[^22]。

有个细节值得记住：Schemastery 的 Standard Schema 适配器一次只产出**一条** issue，抛出即停[^23]。所以一次改一个错，别指望它一口气给你列全。

**第三层，Loader 的 entry 包装。** 补上是哪一行配置、在哪个阶段炸的[^24]：

```
failed to apply loader entry <id> (<name>): invalid config: ...
```

`apply` 只是四个 stage 之一，另外三个是 `import`（模块没解析出来[^25]）、`dispose`、`rollback`。

**第四层，dsh 自己的诊断出口。** 一共这么几条，值得照着认：

`dsh: plugin tree failed to load: <上面那串>` —— 启动窗口内被 boot 直接接住的失败，后面再附最深层 cause 的 stack[^26]。

`dsh: N entries did not activate`，后面每行一条 `<name>: <stack>` —— 树 settle 之后的审计：fiber 建起来了但是 FAILED。schema 校验失败、`apply` 抛异常，都落在这里，boot 收尾时跑[^27]。

`dsh: plugin(s) failed to load: <names>; …` —— 树 settle 之后压根没有 fiber 的启用行，意思是模块没解析出来，路径或包名拼错了[^28]。

`<name>: pending (waiting for services: a, b)` —— 配置根本没被求值，因为 `inject` 声明的服务没人提供[^29]。

`dsh: fatal load failure: <stack>` —— 启动窗口之后的异步 rejection，进程直接退出[^30]。

失败的插件不会被"跳过"，它是响亮的失败[^31]。

你可能在别处读到过一条例外：模块名拼错的报告走 Cordis logger，而启动早期还没有 console 输出器在监听，于是新加的那行看起来"什么都没发生"[^32]。

注意那说的是 Cordis 教程自带的 launcher——直接用 node 跑 vendor 里那个入口的裸启动方式[^33]。dsh 的 boot 额外压了一道"点名"检查专门指认没起来的那一行，所以在 dsh 里"完全没反应"不该是预期结果。

真遇到了，还是先查拼写。

## Schema 管不了的约束，在 apply 里抛

自包含的约束尽量写进 schema，让它在加载期就失败；涉及外部资源的约束靠依赖注入[^34]。

夹在中间的那类怎么办——比如"必须是非负安全整数"，schema 表达不了，但也不需要外部资源。仓库里的做法是 schema 只管类型，`apply` 开头显式抛。真实例子是时间上下文那个包：它的 schema 只声明两个顶层字段的类型——时区是字符串、刷新间隔是数字——真正的语义校验是 `apply` 开头调的一个独立函数，原文收在[附录 B](#b-schema-管不了的约束在-apply-开头抛)[^35]。

从 `apply` 抛出的异常同样让 fiber 进 FAILED[^36]，走上一节第四层那条路——所以用户看到的报错形态是一致的，不会因为"这是插件自己抛的"就变成另一种诊断。

遥测插件的注释把这条规矩写得更直白：schema 只查顶层字段，值检查放构造函数里，这样错误信息能点名具体字段[^37]。

## `!!js`：写在 YAML 里的惰性表达式

`cordis.yml` 允许一种自定义 YAML 标签 `!!js`，把标量解析成"表达式节点"而不是字符串：

```yaml
# packages/bundle/base/cordis.patch.yml:98-101
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
```

机制是三步：

1. **解析期**：include 插件注册了这个标签，把标量构造成一个只装着表达式源码的小对象[^38]。
2. **求值期**：插值器递归走一遍 config——遇到表达式节点就交给求值器（一个把 ctx 铺进作用域再执行表达式的函数），遇到对象或数组就对每个子节点递归，其余原样返回[^39]。
3. **接线**：loader 把插值器挂在配置 waterfall 上，成为校验之前那道手续[^40]。

写法上有个一次性的坑：**双叹号才映射到那个标签，单叹号无效**[^41]。

因为求值器把 ctx 铺进了作用域，表达式里同时有三类名字可写：

- **`ctx` 本身**。它是求值函数的形参，而 Context 上没有叫这个名字的属性，所以它总落到形参上，从它身上取服务一定能用。
- **ctx 上已声明服务的裸名字**。Context 代理实现了"有没有这个名字"的查询，声明过的服务名会答有[^42]，所以裸写 `dshHomePath` 这种成立——它就是 boot 显式提供给表达式用的[^43]。
- **没被 ctx 遮住的全局**。所以 `process.env` 这类全局照写，基础 bundle 里读环境变量、判断平台、取当前目录的真实用例都有[^44]。

### 它只在两个位置生效

同一个表达式节点，落在不同字段上是完全不同的命运：

```mermaid
flowchart TD
    T["<b>!!js 标量</b><br/>解析成 __jsExpr 表达式节点"]
    Q{"<b>它躺在哪个字段下</b>"}
    C["<b>config 下任意深度</b><br/>用该行插件自己的 ctx"]
    CT["<b>等 inject 就绪后才求值</b><br/>provider 换人或 patch 热重载会重算"]
    D["<b>disabled 表达式本身</b><br/>用 loader 侧上下文"]
    DT["<b>每一次挂载决策都算一遍</b><br/>只该写平台或环境判断"]
    X["<b>嵌在普通 disabled 值里面</b><br/>永不求值，恒为 truthy 数据"]
    N["<b>id / name / group / inject 等元数据</b><br/>一律当字面量"]

    T --> Q
    Q --> C --> CT
    Q --> D --> DT
    Q --> X
    Q --> N

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class Q,C,D main
    class CT,DT data
    class T entry
    class X danger
    class N note
```

逐格摊开就是这张表[^45]：

| 位置 | 是否插值 | 求值上下文 | 时机 |
|---|---|---|---|
| `config:` 下任意深度 | ✅ | **该行插件自己的 ctx**（inject 已就绪） | fiber 具备启动条件后、`apply` 之前；provider 换人或 patch 热重载会重算 |
| `disabled:`（表达式本身） | ✅ | loader 侧上下文 | **每一次挂载决策** |
| `disabled:` 是普通值、里面再嵌一层的表达式 | ❌ | — | 永不求值，恒为 truthy 数据 |
| `id` / `name` / `group` / `inject` / `intercept` / `isolate` | ❌ | — | — |

**`config` 表达式等注入就绪才求值**，这是它最有用的性质：

```yaml
# packages/boot/cmdline/README.md:40-47
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

`webStartup` 是另一个插件解析完命令行后 provide 出来的服务。Loader 会等这行声明的注入全部激活，再拿这行自己的插件上下文去求值[^46]；provider 被替换、patch 热重载时会**重新**求值，所以启动 flag 不会被悄悄重置。

仓库里有一条回归测试专门钉死这个顺序，而且刻意把消费者行写在提供者行前面，用来证明顺序来自注入就绪、不是来自 YAML 位置[^47]。

**`disabled` 是另一套**：按 loader 侧上下文求值，每次挂载决策都算一遍，没有"等服务就绪"这一步。所以那里只该写平台或环境判断：

```yaml
# packages/bundle/base/cordis.patch.yml:178-186（略去 bash-sandbox 的 config 块）
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'

- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: !!js process.platform !== 'win32'
```

这条规则有一段值得知道的历史。`disabled` 原本**不**插值，写在那里的 `!!js` 会留下一个恒为真的对象，于是把整栈文件系统工具在所有模式下禁掉了——而 YAML 语法完全合法，加载期零诊断。这就是复盘 0002[^48]。

2026-08-11 的决策把 `disabled` 加进插值范围，并让门禁只在 `disabled` 上放行表达式[^49]。

所以，**如果你在网上看到"`!!js` 只在 config 里有效"，那是 2026-08-11 之前的事实**——复盘 0002 当时写进贡献指南的措辞正是如此，本仓库 HEAD 上的指南和教程都已经改成"`config` 与 `disabled`"[^50]。

## 最贵的坑：patch 换掉的是整块 `config`

直觉是：patch 里只写一个字段，就只改那个字段。

合并算法不答应。它是**按顶层键整块覆盖**，不是深合并：把 patch 行上的顶层键逐个写回目标行，跳过 `id`，其余每个键都是整值顶替[^51]。`config` 正是这些顶层键之一。

看下面这个例子——你只想改一个超时：

```yaml
# packages/bundle/base/cordis.patch.yml:148-152
- id: session-telemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: !!js process.env.DSH_TELEMETRY_MODE || 'DISABLED'
    shutdownTimeoutMillis: 3000

# 你的 $DSH_HOME/cordis.patch.yml
- id: session-telemetry-otel
  config:
    shutdownTimeoutMillis: 5000
```

结果不是"超时变 5000、其余保持"，而是 **`config` 整块被换成只剩那一个超时字段**。`mode` 连同它的 `!!js`、以及原文里的 `exporter`、`processor` 整块，一起消失[^52]，退回 schema 默认值。

这条尤其阴险，因为它连症状都没有：`mode` 的 schema 默认值恰好也是 DISABLED[^53]，所以表面上看起来毫无变化，只是 `DSH_TELEMETRY_MODE` 这个环境变量从此对它无效了。

把这条静默失败串起来看，它的每一环都不报警：

```mermaid
flowchart TD
    B["<b>base 层的 session-telemetry-otel 行</b><br/>mode 走 !!js，另有 exporter 与 processor"]
    MY["<b>你的 patch 只写了 shutdownTimeoutMillis</b>"]
    R["<b>整块 config 被顶替</b><br/>顶层键逐个写回，不深合并"]
    L["<b>mode 的表达式连同 exporter、processor 一起消失</b>"]
    DF["<b>mode 退回 schema 默认值 DISABLED</b><br/>恰好和表达式原本的兜底一样"]
    Z["<b>表面毫无变化</b><br/>DSH_TELEMETRY_MODE 从此对它无效"]
    DUMP["<b>dsh --dump-config 逐字渲染 !!js</b><br/>表达式还在就是还在"]

    B --> R
    MY -- "整块写入" --> R
    R --> L --> DF --> Z
    R -. "改完对一眼" .-> DUMP

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class R,L main
    class B,MY entry
    class DF note
    class Z danger
    class DUMP note
```

官方把这件事写进了两处 Known Limitations："id 定向的 patch 不深合并，profile 覆盖必须重述它想保留的字段"；"用户 patch 替换整块 config 会丢掉它的表达式……保住表达式才保得住 flag 优先"[^54]。

三条自保措施：

1. **重述你要保留的字段，连 `!!js` 一起抄过来。** 表达式节点在 patch 里同样合法[^55]，原样写回去就行。
2. **改完用 `dsh --dump-config` 对一眼。** 它用 include 自己的解析器和 patch 算法离线合成，并把 `!!js` **逐字**渲染出来[^56]。表达式还在就是还在，变成字面量就是被抹了。四层叠加的完整规则见第 03 章。
3. **别用 patch 去"微调"一行**，宁可整行 `insert` 一个你自己的插件。

顺带记住另一个静默失败：patch 的 `id` 在树里找不到时，只是一条警告、不是错误。

patch 应用器把这条诊断丢给一个警告通道，include 再把这个通道接到 loader 的 logger 上；README 直接称之为 "a stderr warning"[^57]。所以 patch 的 id 打错了，你也只会在一堆启动日志里看到一行灰扑扑的提示。

## 把全章装进一个心跳插件跑一遍

两份文件的全文照抄[附录 C](#c-心跳插件全文)：一个带 schema 默认值、`apply` 开头显式抛错、用 effect 清理定时器的插件，加一份 `insert` 它的 patch 文件。示例改编自官方文档的插件形状与 Config 形状，额外约束仿时间上下文那个包[^58]。

有一处必须注意：patch 里的 `name` 必须写绝对路径——patch 文件不改变 loader 解析模块的基准目录[^59]。

跑起来（源码路径的启动方式见第 02 章，这条命令行与官方文档一致[^60]）：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

预期是终端每 5 秒打一行 `[dev] alive`；把 `HEARTBEAT_MS` 环境变量设成 2000 再跑，就变成每 2 秒一行。

然后建议做四个破坏性实验，它们分别命中本章讲过的四层：

| 改成 | 会发生什么 | 为什么 |
|---|---|---|
| `intervalMs: 'fast'` | 启动即失败，`invalid config:` + `$.intervalMs expected number but got fast` | schema 层，报错的第一、二层[^61] |
| `intervalMs: 500` | 启动即失败，`heartbeat: intervalMs must be a safe integer >= 1000, got 500` | schema 过了，`apply` 自己抛 |
| 删掉 `label` | 正常跑，打 `[heartbeat] alive` | schema 默认值补上了 |
| 写成 `labell: dev` | 正常跑，打 `[heartbeat] alive`，**没有任何警告** | 未声明的键原样通过 |

## 想知道某个内置插件能配什么

不要猜，也不要翻源码找 schema。仓库里有一份**生成**的全量配置目录，逐包贴出 `apply` 或服务构造函数实际接收的完整配置声明，连 JSDoc 一起，并列出该行必须存在的 `inject` 依赖[^62]。

它可信的原因在于生成器会拿运行期 schema 和贴出来的类型做交叉核对：**每个被 schema 校验的键（含嵌套键）都必须能在声明的类型上定位到**，所以这份目录藏不住"loader 收但文档没写"的字段[^62]。

每个条目末尾还带一行 Source 指针直接指向源码，随手就能跳过去核对[^63]。

## "我配了但没生效"，按这个顺序查

本章一共出现了四种不报错的失败，它们的排查成本从低到高恰好是这个顺序：

1. **字段名拼错。** 未声明的键被原样合并进 config，没人读也没人报[^13]。先跟上一节那份生成的配置目录逐字对一遍键名。
2. **patch 把整块 `config` 换掉了。** 你以为在改一个字段，实际上把兄弟字段连同它们的 `!!js` 一起抹了[^51]。
3. **patch 的 `id` 根本没匹配上。** 只是一行 stderr 警告[^57]。
4. **`!!js` 写在了不插值的位置。** 嵌在普通 `disabled` 值下面的表达式永不求值，恒为 truthy[^45]；元数据字段更是一律字面量。

前三种一条命令就能同时排掉：`dsh --dump-config` 打出来的是离线合成、`!!js` 逐字保留的最终树。你的键名在不在、表达式还在不在、patch 有没有命中，一眼可见。

摊平来看，这条排查线是一条捷径加两个岔口：

```mermaid
flowchart TD
    S["<b>配了但没生效</b>"]
    D["<b>先跑 dsh --dump-config</b><br/>离线合成，!!js 逐字保留"]
    A["<b>① 键名拼错</b><br/>未声明的键原样合并，没人读也没人报"]
    B2["<b>② patch 换掉整块 config</b><br/>兄弟字段和它们的表达式一起没了"]
    C2["<b>③ patch 的 id 没匹配上</b><br/>只有一行灰扑扑的 stderr 警告"]
    E2["<b>④ !!js 写在不插值的位置</b><br/>dump 看不出来，得回去核字段"]
    F2["<b>插件干脆没起来</b><br/>照诊断出口那节认报错，先看 pending 那行"]

    S --> D
    D -- "前三种一眼可见" --> A
    D --> B2
    D --> C2
    S -- "dump 排不掉" --> E2
    S -- "根本没跑起来" --> F2

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class D main
    class S entry
    class A,B2,C2 note
    class E2,F2 danger
```

如果不是这四种，而是插件干脆没起来，那就回到诊断出口那节按报错认——尤其是 pending 那一行，它意味着配置压根没被求值，问题不在配置本身。

## 把整条链路串起来

现在回看整章的结论，每一条都能从链路上重新推出来，推得动才算真懂了：

- `apply` 拿到的配置**永远是完整的、已校验的**——因为 schema 校验和默认值填充卡在 `apply` 之前那道门上；没导出 `Config` 的插件是唯一例外，原样放行；
- 字段名拼错**零诊断**——因为非 strict 的对象解析器会把未声明的键原样合并进结果，没人读它，也没人替它报警；
- patch"微调一个字段"会**抹掉兄弟字段连同它们的 `!!js`**——因为合并算法按顶层键整块覆盖，而 `config` 正是顶层键之一；
- `!!js` 写错位置**恒为 truthy 数据**——因为插值只挂在 `config` 和 `disabled` 两个位置上，别处的表达式节点永远等不到求值那一步；
- 改配置**不需要写 diff 逻辑**——因为改配置 = 卸旧装新，新实例和冷启动走同一条路，effect 保证卸载不留残渣。

两道门都放行、插件却没按你想的跑，那八成是你的字段名从没被任何人读过。

配置的四层叠加规则见 [03 章](./03-配置的四层结构.md)，waterfall 的完整机制见 [11 章](./11-waterfall专章.md)，effect 为什么能让卸载不留残渣见 [08 章](./08-effect与生命周期.md)。

---

## 附录：可以照抄的模板

### A. 一个可配置插件的三个导出

抄自官方文档，删掉了原文行尾的说明注释[^2]：

```ts
// 抄自 docs/user/develop/basic/config.md:11-32，落盘为 scratch-plugin/src/my-plugin.ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)
}
```

### B. schema 管不了的约束，在 apply 开头抛

时间上下文包的真实做法：schema 只管类型，语义校验独立成函数、`apply` 开头调[^35]：

```ts
// packages/context/time-context/src/index.ts:128-137
function validateRefreshInterval(refreshIntervalMs: number | undefined): void {
  if (refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(refreshIntervalMs)
    || refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}
```

### C. 心跳插件全文

**文件一** `scratch-plugin/src/heartbeat.ts`[^58]：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'heartbeat'

export interface Config {
  label: string
  intervalMs: number
}

export const Config: Schema<Config> = Schema.object({
  label: Schema.string().default('heartbeat'),
  intervalMs: Schema.number().default(5000),
})

export function apply(ctx: Context, config: Config) {
  if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1000) {
    throw new TypeError(
      `heartbeat: intervalMs must be a safe integer >= 1000, got ${String(config.intervalMs)}`,
    )
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log(`[${config.label}] alive`)
    }, config.intervalMs)
    return () => clearInterval(timer)
  })
}
```

**文件二** `scratch-plugin/cordis.yml`（`name` 必须绝对路径，理由见正文[^59]）：

```yaml
- insert:
    - id: heartbeat
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/heartbeat.ts'
      config:
        label: dev
        intervalMs: !!js Number(process.env.HEARTBEAT_MS ?? 5000)
```

---

## 出处

[^1]: 配置字段的判据："能不能不改代码、只改 `cordis.yml` 换掉这个值"，`docs/user/develop/basic/config.md:80`、`:92`。
[^2]: 三导出模板原文：`docs/user/develop/basic/config.md:11-32`（即附录 A，删掉了行尾说明注释）。
[^3]: 同名 `interface Config` 与 `const Config` 是故意的（类型给使用方、值给 Cordis 当校验器）：`docs/cordis-tutorial/05-config.md:34`。
[^4]: 注册表建立插件 runtime 记录时直接读 `plugin.Config` 存进去：`vendor/cordis/src/registry.ts:326`；该字段类型是 `StandardSchemaV1`：`:104`；校验点取 `runtime.Config['~standard'].validate(config)`：`vendor/cordis/src/fiber.ts:53`。
[^5]: 普通对象没有 `~standard`、当场炸：`docs/user/develop/basic/config.md:45`、`docs/cordis-tutorial/05-config.md:34`。
[^6]: Schemastery 实现 Standard Schema 接口的适配器：`vendor/schemastery/src/index.ts:275-292`。
[^7]: 类形式插件写 `static Config = Config` 的实例：`packages/session/session-telemetry-otel/src/index.ts:149`。
[^8]: loader 取模块时是 `exports.default ?? exports`：`vendor/loader/src/index.ts:192-199`，调用点 `vendor/loader/src/config/entry.ts:280`。
[^9]: 构造器出处合集，均在 `vendor/schemastery/src/index.ts`：`Schema.object` 声明 `:89`、对象解析器 `:752`；基础类型 `:59-67`；集合 `:83-87`；`.default` `:167`；`.required` `:157`（抛点在 `:475`）；范围与正则 `:180-185`。`Schema.union` 与 `Schema.any` 的实战用例：`packages/session/session-telemetry-otel/src/index.ts:121` 与 `:122-123`。
[^10]: 不要在 `apply` 里写 `config.greeting ?? 'Hello'` 这种兜底：`docs/user/develop/basic/config.md:9`。
[^11]: 默认值由校验器填充：`docs/cordis-tutorial/05-config.md:51`；填充逻辑 `vendor/schemastery/src/index.ts:474-484`，最后一步 `data = clone(fallback)` 在 `:483`。
[^12]: 写回时删掉等于默认值的字段（`simplify`）：`vendor/loader/src/index.ts:106-108`，`simplify` 定义在 `vendor/schemastery/src/index.ts:193`。
[^13]: 未声明键原样合并，关键一句 `if (!strict) merge(result, data)`：`vendor/schemastery/src/index.ts:752-763`，`merge` 本体在 `:745-750`。
[^14]: 插值与校验的挂载点：`vendor/cordis/src/fiber.ts:641-644`，两步挤在 `:642`（waterfall `internal/config` 插值）和 `:643`（`resolveConfig` 过 schema）两行里，调用点在 `:655`。
[^15]: PENDING/FAILED 的判定（`inject` 缺席则 epoch 为 INACTIVE、`_reload` 不跑；`_error` 有值为 FAILED）：`vendor/cordis/src/fiber.ts:611-623` 与 `:575-578`。
[^16]: 热更新入口 `fiber.update()` 在非 ACTIVE 时推迟求值：`vendor/cordis/src/fiber.ts:736-753`，"config 解析可能访问注入的服务"的注释在 `:740-741`。
[^17]: 没有 schema 原样放行，`resolveConfig` 第一行 `if (!runtime.Config) return config`：`vendor/cordis/src/fiber.ts:51`。
[^18]: "schema 在插件加载期间运行，非法配置以可操作的错误让加载失败"：`docs/user/develop/basic/config.md:74`。
[^19]: 改配置 = 卸载旧实例、加载新实例：`docs/user/develop/basic/config.md:100`。
[^20]: Schemastery 的路径前缀（`$.targets`）：`vendor/schemastery/src/index.ts:213-226`；array 解析器的"期望什么拿到什么"：`:714`。
[^21]: Cordis `ValidationError` 的 issue 排版（`  - <message> (at <path>)`）：`vendor/cordis/src/fiber.ts:27-35`。
[^22]: 官方教程贴出的同款输出：`docs/cordis-tutorial/05-config.md:63-66`。
[^23]: 适配器一次只产出一条 issue（抛出即停）：`vendor/schemastery/src/index.ts:281-288`。
[^24]: Loader 的 entry 包装前缀：`vendor/loader/src/config/entry.ts:24-27`。
[^25]: `import` stage 失败（模块没解析出来）：`vendor/loader/src/config/entry.ts:280-283`。
[^26]: 启动窗口内被 `boot()` 接住的失败，格式模板 `${binName}: ${stage}: ${detail}`、附最深层 cause 的 stack：`packages/boot/app-boot/src/index.ts:767-773`、`:791-800`。
[^27]: 树 settle 之后的审计（`N entries did not activate`），`boot()` 收尾时跑：`packages/boot/app-boot/src/index.ts:692-724`、`:701-707`、`:723`，调用点 `:784`。
[^28]: 模块没解析出来的点名（`plugin(s) failed to load`）：`packages/boot/app-boot/src/index.ts:658-663`。
[^29]: pending 行（`waiting for services`）：`packages/boot/app-boot/src/index.ts:710-713`。
[^30]: 启动窗口后异步 rejection 的 `fatal load failure`，进程 `exit(1)`：`packages/boot/app-boot/src/index.ts:622`。
[^31]: "失败的插件不会被跳过，它是响亮的失败"：`docs/cordis-tutorial/01-first-plugin.md:89`。
[^32]: 模块名拼错走 Cordis logger、启动早期无 console 输出器的例外：`docs/cordis-tutorial/01-first-plugin.md:91`。
[^33]: Cordis 教程自带的 launcher（`node --import tsx ../../vendor/cordis/bin.js`）：`docs/cordis-tutorial/01-first-plugin.md:36`；dsh 的点名检查是 `boot()` 里的 `assertEntriesLoaded`（就是脚注 28 那条诊断的来源）。
[^34]: 自包含约束进 schema、外部资源约束靠依赖注入：`docs/user/develop/basic/config.md:94-96`。
[^35]: 时间上下文包的语义校验（附录 B 原文）：`packages/context/time-context/src/index.ts:128-137`；schema 只声明 `z.object({ timeZone: z.string(), refreshIntervalMs: z.number() })`（`z` 是这个包给 schemastery 起的别名）在 `:35-38`；`apply` 从 `:145` 起，调用点在 `:148`。
[^36]: `apply` 抛异常同样让 fiber 进 FAILED：`vendor/cordis/src/fiber.ts:576`。
[^37]: "schema 只查顶层字段，值检查放构造函数里，让错误信息点名具体字段"的注释：`packages/session/session-telemetry-otel/src/index.ts:113-118`。
[^38]: `cordis-plugin-include` 注册 `tag:yaml.org,2002:js`，把标量构造成 `{ __jsExpr: '<源码>' }`：`vendor/include/src/index.ts:9-15`。
[^39]: `interpolate()` 递归求值：`vendor/loader/src/config/utils.ts:12-22`；求值器是 `new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')`，在 `:5-9`。
[^40]: loader 把 `interpolate` 挂在 `internal/config` waterfall 上：`vendor/loader/src/index.ts:92-101`。
[^41]: 只能写 `!!js`、写 `!js` 无效：`AGENTS.md:96`。
[^42]: Context 代理的 `has` trap 对已声明服务名返回 true：`vendor/cordis/src/reflect.ts:199-205`。
[^43]: `dshHomePath` 由 `boot()` 显式 provide 给表达式用：`packages/boot/app-boot/src/index.ts:770`；README 点名这个用途：`packages/boot/app-boot/README.md:21`。
[^44]: `process.env` / `process.platform` / `process.cwd()` 的真实用例：`packages/bundle/base/cordis.patch.yml:151`、`:180`、`:176`。
[^45]: 插值位置的规则："`config` 与 `disabled`"见 `docs/cordis-primer.md:38`；`disabled` 的求值实现在 `vendor/loader/src/config/entry.ts:104-112`（用 `Entry` 自己的 ctx，`:67` 从 `loader.ctx` 扩展而来）；静态字段名单在 `scripts/verify-cordis-config.ts:41`；嵌套表达式与非法元数据的门禁在 `scripts/verify-cordis-config.ts:431-451`，其中 `:444-450` 的注释直说"嵌在下面的表达式永远不会求值，所以必须保持字面值"。
[^46]: 等注入激活后用该行插件上下文求值：`packages/boot/cmdline/README.md:53`。
[^47]: 消费者行故意写在提供者行前面的回归测试：`packages/boot/app-boot/tests/user-patches.spec.ts:145-170`，注释在 `:162-163`。
[^48]: 复盘 0002（`!!js` 留在不插值的 `disabled` 下、恒为真、禁掉整栈文件系统工具）：`docs/postmortem/0002-js-expression-disabled-filesystem-tools.zh.md:9`、`:32`。
[^49]: 2026-08-11 把 `disabled` 加进插值范围的决策记录：`.agents/notes/implemented/architecture/2026-08-11-loader-entry-disabled-interpolation.zh.md:13`；对应提交 `feat(loader): interpolate the entry disabled field`，2026-08-11。
[^50]: 复盘 0002 当时加进 `AGENTS.md` 的措辞（"只在 config 里有效"）见其 `:39`；本仓库 HEAD 的 `AGENTS.md:96` 和 `docs/cordis-tutorial/05-config.md:80` 都已改成"`config` 与 `disabled`"。
[^51]: 按顶层键整块覆盖的合并循环（`for (const [key, value] of Object.entries(overrides))`，跳过 `id`，其余 `target[key] = value`）：`vendor/include/src/index.ts:121-124`。
[^52]: base 层该行原文里的 `exporter` / `processor` 整块：`packages/bundle/base/cordis.patch.yml:153-161`。
[^53]: `mode` 的 schema 默认值 `DEFAULT_TELEMETRY_MODE` 恰好是 DISABLED：`packages/session/session-telemetry-otel/src/index.ts:51`。
[^54]: 两处 Known Limitations：`packages/boot/app-boot/README.md:60`、`packages/boot/cmdline/README.md:73`；同一条也写在 `packages/boot/app-boot/README.md:43`。
[^55]: 表达式节点在 patch 里同样合法：`packages/boot/app-boot/README.md:16-17`。
[^56]: `--dump-config` 离线合成、`!!js` 逐字渲染：`packages/boot/app-boot/README.md:22`；flag 说明见 `apps/cli/README.md:41`，逐条语义见 `apps/cli/reference/README.md:39`。
[^57]: `applyEntryPatches` 把诊断丢给 `warn` sink：`vendor/include/src/index.ts:110-113`；include 把 sink 接到 loader logger：`:267-270`；"a stderr warning"的说法在 `packages/boot/app-boot/README.md:43`。
[^58]: 心跳插件改编自 `docs/user/develop/basic/index.md:33-85`（插件形状与 `ctx.effect` 清理）与 `docs/user/develop/basic/config.md:11-32`（Config 形状），额外约束仿 `packages/context/time-context/src/index.ts:128-137`。
[^59]: patch 文件不改变 loader 解析模块的基准目录：`docs/user/develop/basic/index.md:56`。
[^60]: 这条命令行与 `docs/user/develop/basic/index.md:61` 一致；`--patch <path>` 的定义在 `apps/cli/src/args.ts:132`。
[^61]: schema 报错的消息模板：`vendor/schemastery/src/index.ts:640`。
[^62]: 全量配置目录 `docs/config-catalog.md`：生成器 `scripts/gen-config-catalog.ts`，生成声明与 `inject` 依赖见 `docs/config-catalog.md:1-2`、`:6`、`:10`；schema 与类型交叉核对的保证见 `:8`。
[^63]: Source 行示例（`@deepseek-ai/dsh-bash-sandbox` 那条）：`docs/config-catalog.md:369-388`。
