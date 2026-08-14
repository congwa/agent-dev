# 22 · 做一个 bundle 和 profile

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。

到目前为止你写的插件只有你自己能跑。原因很具体：挂载它的那行配置里写着一个绝对路径，换台机器就断了。这一章从头攒一个能发布的组合，把那个绝对路径消掉，让别人 `dsh plugin --profile <name> add` 一句话就装上。

配置的四层叠加（bundle → profile → home → `--patch`）在 [03 章](./03-配置的四层结构.md) 讲过原理，这里是它的实践面：怎么把自己塞进第一层。

---

## bundle 是你写的，profile 是用户启动的

先把三个最容易混的词钉死，后面每一节都建立在它们的分工上。官方教程那句话说得很干脆：bundle 是你写的、profile 是用户启动的，**Nothing is both**（`docs/user/develop/basic/publish.md:13-16`）。

三者的关系是一条指向链：profile 列出 bundle，bundle 的 patch 行指向 plugin；而它们各自被系统认出来的方式完全不同。

```mermaid
flowchart LR
    PR["<b>profile</b><br/>一份可启动的组合"]
    B["<b>bundle</b><br/>npm 包，附带一层配置补丁"]
    P["<b>plugin</b><br/>一个导出 apply 的模块"]

    RP["<b>靠目录位置被识别</b><br/>DSH_HOME 下的 profiles 目录里，有 package.json 就算"]
    RB["<b>靠 package.json 里的 dsh.bundle.patch 被识别</b>"]
    RN["<b>没有自己的识别方式</b><br/>配置行里的 name 指向它"]

    PR -- "dsh.profile.bundles 列出" --> B
    B -- "patch 行的 name 指向" --> P
    PR --> RP
    B --> RB
    P --> RN

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    class PR,B main
    class RP,RB data
    class P,RN entry
```

| | 是什么 | 靠什么被识别 | 住在哪 |
|---|---|---|---|
| **plugin** | 一个导出 `apply` 的模块 | 无（配置行里的 `name` 指向它） | 任意路径 / npm 包内 |
| **bundle** | 一个 npm 包，附带一层配置补丁 | `package.json` 里有 `dsh.bundle.patch`（`apps/cli/src/plugin.ts:44`） | npm / git / 本地目录 |
| **profile** | 一份可启动的组合 | 目录位置 + 目录里有 `package.json`；`dsh.profile.bundles` 决定它组合哪些 bundle | `$DSH_HOME/profiles/<name>/` |

profile 那一格的门槛比想象中低。`loadProfile` 只要求目录里有 `package.json`，`dsh` 段整个缺失也不报错，bundles 按空列表处理（`packages/boot/app-boot/src/profile.ts:386-387`）。手写一个 profile manifest 是完全可以的。

代码里这两份 manifest 是两个独立接口，挂在同一个 `dsh` 键下（`packages/boot/app-boot/src/profile.ts:42-62`，去掉 doc 注释后的等价签名）：

```ts
export interface DshBundleManifest { patch: string }
export interface DshProfileManifest { bundles?: string[] }
export interface DshManifestSection { bundle?: DshBundleManifest; profile?: DshProfileManifest }
```

这里有个措辞上的微妙差异值得留意：源码注释写的是 "A manifest may declare both roles"（`packages/boot/app-boot/src/profile.ts:53-56`），文档写的是 "Nothing is both"。两句话不矛盾——类型上允许，实践里不这么干。dsh 自带的三个 bundle 都只声明 `dsh.bundle`（`packages/bundle/base/package.json:36-40`、`web-app/package.json:41-45`、`headless/package.json:41-45`），而 `packages/bundle/` 下确实也就 base、web-app、headless 三个包，没有第四个。

---

## 起点是一个绝对路径

最原始的形态是写一个 `.ts`，拿 `--patch` 挂进去。官方第一课就是这么开场的（`docs/user/develop/basic/index.md:50-54`）：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

（`docs/user/develop/basic/index.md:61`；`pnpm dsh` 是在仓库源码里的跑法，装好的 dsh 直接写 `dsh web --patch ...`。）

路径必须是绝对的，这条没得商量：patch 文件只贡献配置，不会改变 loader 解析模块路径的基准目录（`docs/user/develop/basic/index.md:56`）。自己调试够用了，但没法给别人——对方还得知道你硬盘上的目录结构。往下一层走，为的就是消灭这个绝对路径。

---

## 三个文件换掉那个路径

一个 bundle 就是三个文件（`docs/user/develop/basic/publish.md:26-31`）：

```
hello-plugin/
├── package.json
├── cordis.patch.yml
└── index.js
```

`package.json` 逐字如下（`docs/user/develop/basic/publish.md:35-43`）：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`index.js`（`docs/user/develop/basic/publish.md:48-54`）：

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

`cordis.patch.yml`（`docs/user/develop/basic/publish.md:58-62`）：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

绝对路径没了，位置上换成了**包名**，剩下的交给 Node 的模块解析。就这么点事。

### `dsh.bundle.patch` 到底是怎么被读的

`loadProfile` 对 `dsh.profile.bundles` 里的每个名字做四件事（`packages/boot/app-boot/src/profile.ts:388-397`）：解析包目录，读它的 `package.json`，取出 `dsh.bundle.patch`，然后 `join(packageDir, declared)` 当成必需 overlay 解析。

这条链是直的，但沿途有三个地方会当场抛错：

```mermaid
flowchart TD
    A["<b>bundles 里的一个包名</b>"]
    B["<b>resolveBundleDir</b><br/>解析出包目录"]
    C["<b>读这个包的 package.json</b>"]
    D{"<b>有 dsh.bundle.patch 吗</b>"}
    E["<b>join 包目录 与 声明的路径</b><br/>普通文件路径，不走 exports 映射"]
    F{"<b>文件读得到吗</b>"}
    G{"<b>顶层是 YAML 数组吗</b>"}
    OK["<b>这一层的 patch 条目</b>"]
    X1["<b>declares no dsh.bundle</b>"]
    X2["<b>failed to read overlay</b><br/>多半是 files 漏了这个文件"]
    X3["<b>must be a top-level YAML array</b><br/>空文件和纯注释也算不是数组"]

    A --> B --> C --> D
    D -- "没有" --> X1
    D -- "有" --> E --> F
    F -- "读不到" --> X2
    F -- "读到了" --> G
    G -- "不是" --> X3
    G -- "是" --> OK

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class B,C,D,E,F,G main
    class OK data
    class A entry
    class X1,X2,X3 danger
```

这四步推出三个你迟早会撞上的事实。

第一，`patch` 是**相对包根目录的普通文件路径**，走的是文件系统 `join`，**不走 `exports` 映射**。仓库自带 bundle 里那条 `"./cordis.patch.yml": "./cordis.patch.yml"` 导出（`packages/bundle/base/package.json:25`）跟 profile 加载没关系——2026-08-14 全仓 grep 过，没有任何代码 import 这个子路径。你的包不写这条导出照样能被加载。

第二，`files` 里必须列上 `cordis.patch.yml`（自带 bundle 的写法见 `packages/bundle/base/package.json:29-34`）。漏了它，包能装上、`dsh.bundle.patch` 也还在，但读文件那步会抛 `dsh: failed to read overlay <路径>: ...`（`packages/boot/app-boot/src/index.ts:303`）。这是典型的"本地目录能跑、发布装上就炸"，因为本地目录压根不经过 `files` 过滤。

第三，用的是 `loadOverlayPatches` 这个必需版，文件读不到就抛（`packages/boot/app-boot/src/index.ts:298-306`）；内容必须是**顶层 YAML 数组**，否则报 `overlay <file> must be a top-level YAML array of loader patch entries`（`packages/boot/app-boot/src/index.ts:329-331`）。空文件、或者只剩注释的文件，解析结果都不是数组，一样抛错。想让这层什么都不做，写 `[]`（`packages/boot/app-boot/README.md:43`）。

### 你的 patch 能干的两件事：插新行，改别人的行

补丁条目的具名字段就这些（`vendor/include/src/index.ts:145-156`）：`id` / `insert` / `name` / `config` / `group` / `disabled` / `inject` / `intercept` / `isolate`。但它还带一条索引签名 `[key: string]: any`（`:155`），别的键也写得进来，并且会被逐键写到目标行上（`:121-124`）。换句话说键名打错不会报错，只会静静地给那行加一个没人读的字段——查这种问题很费时间。

`applyEntryPatches` 的完整处理规则（`vendor/include/src/index.ts:58-128`）：

| 写法 | 行为 | 出处 |
|---|---|---|
| `- insert: [...]`（无 `id`） | 追加到根 entry 列表末尾 | `vendor/include/src/index.ts:93-95` |
| `- id: X` + `insert:` | 插进 id 为 X 的 **group** 行；X 不存在或不是 group → 只告警跳过 | `:80-92` |
| `- id: X` + 其它键 | 逐键覆盖到 X 行上（`config` 是一整个键，所以是整体替换） | `:121-124` |
| `- id: X` 但树里没有 X | 告警 `patch: entry "X" not found`，跳过 | `:110-113` |
| 没有 `id` 又没有 `insert` | 告警 `patch: id is required for non-insert patches` | `:105-107` |
| `- id: X` + `name: Y`（Y ≠ 现有 name） | **整条跳过**并告警 name mismatch | `:116-119` |

这张表其实是一棵判定树，分岔口就是有没有 `insert`。带 `insert` 的走这一支：

```mermaid
flowchart TD
    P["<b>带 insert 的条目</b>"]
    Q{"<b>同时写了 id 吗</b>"}
    A1["<b>追加到根 entry 列表末尾</b><br/>base 把核心行一次铺开用的就是这种"]
    Q2{"<b>那行存在，而且是 group 吗</b>"}
    A2["<b>插进这个 group 的 config 里</b>"]
    X["<b>只告警跳过</b><br/>not found 或 is not a group"]
    IDX["<b>插进来的行登记进索引</b><br/>靠后的层可以按 id 改它"]

    P --> Q
    Q -- "没写" --> A1
    Q -- "写了" --> Q2
    Q2 -- "是" --> A2
    Q2 -- "否" --> X
    A1 --> IDX
    A2 --> IDX

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class Q,Q2,A1,A2 main
    class IDX data
    class P entry
    class X danger
```

不带 `insert` 的走另一支，覆盖真正落下去之前要连过三道关卡：

```mermaid
flowchart TD
    P["<b>不带 insert 的条目</b>"]
    Q1{"<b>写了 id 吗</b>"}
    X1["<b>id is required for non-insert patches</b>"]
    Q2{"<b>树里找得到这个 id 吗</b>"}
    X2["<b>patch: entry X not found</b>"]
    Q3{"<b>写了 name，而且跟现有的对不上</b>"}
    X3["<b>整条跳过并告警 name mismatch</b><br/>确认没改错目标的保险"]
    A["<b>逐键覆盖到那一行</b><br/>config 是一整个键，整体替换不深合并"]

    P --> Q1
    Q1 -- "没写" --> X1
    Q1 -- "写了" --> Q2
    Q2 -- "找不到" --> X2
    Q2 -- "找到了" --> Q3
    Q3 -- "对不上" --> X3
    Q3 -- "没写 name 或对得上" --> A

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class Q1,Q2,Q3 main
    class A data
    class P entry
    class X1,X2,X3 danger
```

最后一条是个好用的保险。写上 `name` 等于声明"我确认这行确实是那个插件才改"，改错目标时它会明说，而不是默默生效在一行你根本没想动的配置上。

`insert` 进来的行会被登记进索引（`vendor/include/src/index.ts:101`），所以**同一条链上靠后的层可以按 id 修改前面层刚插入的行**。`dsh-web-app` 覆盖 `dsh-base` 走的正是这条路：base 用一条 `- insert:` 把全部核心行铺开（整个文件只有这一个顶层条目，`packages/bundle/base/cordis.patch.yml:15-17`），web-app 再按 id 逐行改：

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: hmr
  disabled: true
```

（`packages/bundle/web-app/cordis.patch.yml:16-23`；被它顶掉的 base 原行在 `packages/bundle/base/cordis.patch.yml:429-432`，那里 `persona: ''`。）

覆盖时最容易踩的坑是 `config` **整体替换、不深合并**。你改别人一行，就得把这行需要的键全部重写一遍；只写你关心的那个键，其余键会被抹成默认值（`docs/user/develop/basic/publish.md:123-126`、`packages/boot/app-boot/README.md:60`）。这条反过来对你同样成立——用户能在自己 profile 的 `cordis.patch.yml` 里覆盖你的行，不用碰你的包。所以选默认值时优先挑"用户大概率不会改"的那个，其余交给 schema。

### 如果你的 bundle 自带一条命令行

提供可运行 app 的 surface bundle（像 `dsh-headless` 那样）要多插一行 provider 插件。现成样板就是 headless 自己的 startup：`export const inject = ['cmdlineArgs']`，用 `@deepseek-ai/dsh-cmdline` 的 `parseCmdline` 解析自己的 commander program，再把结果 `ctx.provide` 成一个服务（`packages/bundle/headless/src/startup.ts:16`、`:56`、`:10`）。需要这些 flag 的行 inject 这个服务，在 `!!js` 惰性表达式里读它（`!!js` 是 loader 的延迟求值标签，见 [09 章](./09-插件配置与Schema.md)）：

```yaml
- insert:
    - id: headless-startup
      name: '@deepseek-ai/dsh-headless/startup'

    - id: headless-runner
      name: '@deepseek-ai/dsh-headless'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
```

（`packages/bundle/headless/cordis.patch.yml:22` 那条 `- insert:` 下的 `:27-35`，同一条 insert 里还有一行 `code-runtime`，这里略去；写法说明见 `docs/user/develop/basic/publish.md:130-151`。）

之所以要绕这一圈，是因为启动器完全不认识 `--resume` 这类 flag。它只解析自己的旗标，遇到第一个不认识的 token 之后全部原样交给被启动的 profile（`apps/cli/src/args.ts:8-11`、`apps/cli/reference/README.md:17`）。app 参数不是第四层 patch，它得靠服务传进来。

---

## `dsh plugin` 其实是 pnpm 的转发器

一条 `add` 命令的全程是这个形状：初始化、转发、按结果决定要不要回写那张表。

```mermaid
flowchart TD
    C["<b>dsh plugin --profile n add pkg</b>"]
    R["<b>相对路径参数先重写成绝对路径</b><br/>按你敲命令时所在的目录，file: 与 link: 前缀保留"]
    I["<b>没有 package.json 就 initProfile</b><br/>用同名模板，没模板退到 dsh-base"]
    S["<b>以 profile 目录为 cwd 跑 pnpm</b><br/>stdio inherit，add remove why update 原样可用"]
    Q{"<b>pnpm 退出码是 0 吗</b>"}
    RC["<b>reconcile</b><br/>按安装后的实际状态重算 bundles"]
    PJ["<b>profile 的 package.json</b>"]
    F["<b>什么都不同步</b><br/>只多打一句是哪一个 pnpm-workspace.yaml"]

    C --> I --> S --> Q
    R -- "参数" --> S
    Q -- "是" --> RC
    Q -- "否" --> F
    RC -- "写" --> PJ

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class I,S,Q,RC main
    class PJ data
    class C,R entry
    class F danger
```

`dsh plugin --profile <name> <args...>` 只做三步（`apps/cli/src/plugin.ts:120-158`）。profile 目录没有 `package.json` 就先 `initProfile`，用同名模板，没模板就退到 `['@deepseek-ai/dsh-base']`（`apps/cli/src/plugin.ts:121-125`，常量在 `packages/boot/app-boot/src/profile.ts:114-117` 与 `:125`）。然后以 **profile 目录为 cwd** 执行 `spawnSync('pnpm', args)`，`stdio: 'inherit'`（`apps/cli/src/plugin.ts:129-133`），所以 `add` / `remove` / `why` / `update` 这些 pnpm 动词原样可用（`apps/cli/src/args.ts:175`、`apps/cli/reference/README.md:43`）；pnpm 不在 PATH 上会直接退 127 并给提示（`apps/cli/src/plugin.ts:136-138`）。最后，**只有 pnpm 退出码为 0** 才做 reconcile（`apps/cli/src/plugin.ts:143-144`）。

reconcile 的口径是关键：它按**安装后的实际状态**算，不按命令行参数 diff（`apps/cli/src/plugin.ts:59-91`）。遍历 `dependencies`，凡是能解析到、且 manifest 里有 `dsh.bundle.patch` 的包，就追加进 `dsh.profile.bundles`；本次新增却没有 `dsh.bundle` 的包，打一次告警：

```
dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
```

（`apps/cli/src/plugin.ts:71-74`）反过来，依赖被删了、或者新版本拿掉了 `dsh.bundle`，那一层自动退出（`:77-87`）。两个顺带的推论：`update` 到一个新增了 `dsh.bundle` 的版本会自动激活它（`apps/cli/src/plugin.ts:7-9`）；而模板自带的 in-box bundle 不是 dependency，永远不会被摘掉（`:79-81`）。

这段口径摊平就是一次遍历、三种落点，判据全在"这个包现在长什么样"上：

```mermaid
flowchart TD
    D["<b>遍历安装后的 dependencies</b>"]
    Q1{"<b>能解析到，且有 dsh.bundle.patch 吗</b>"}
    A1["<b>追加进 dsh.profile.bundles</b>"]
    Q2{"<b>是本次新增的吗</b>"}
    W["<b>告警一次 declares no dsh.bundle</b><br/>装成了普通依赖，不是层"]
    N["<b>不动</b>"]
    B2["<b>曾是依赖、现在不再是 bundle</b><br/>那一层自动退出"]
    T["<b>模板自带的 in-box bundle 不是 dependency</b><br/>永远不会被摘掉"]

    D --> Q1
    Q1 -- "是" --> A1
    Q1 -- "否" --> Q2
    Q2 -- "是" --> W
    Q2 -- "否" --> N
    D --> B2
    B2 -- "不适用" --> T

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class Q1,Q2,B2 main
    class A1 data
    class D entry
    class W,N,T note
```

还有一处不显眼但少了就要出事的处理：相对路径参数会先按**你敲命令时所在的目录**重写成绝对路径（`apps/cli/src/plugin.ts:104-112`，cwd 取自 `:129`）。没有这一步，`add .` 会因为 cwd 已经是 profile 目录，把 profile 自己链接给自己。`file:` / `link:` 前缀则保留原样，因为 pnpm 对这两者的 link-vs-copy 语义不同。

---

## profile 目录里那几个文件，各归各管

跑完 `dsh plugin --profile demo add ./hello-plugin`（`docs/user/develop/basic/publish.md:80`），`$DSH_HOME/profiles/demo/` 里躺着 `initProfile` 写的三个文件，外加 pnpm 自己的 `node_modules/` 和 lockfile。`cordis.yml` 要等第一次启动或第一次 dump 才出现。

| 文件 | 谁写的 | 内容 |
|---|---|---|
| `package.json` | `initProfile` 建、`dsh plugin` 维护 | 依赖 + `dsh.profile.bundles` 顺序表 |
| `cordis.patch.yml` | `initProfile` 写模板，之后归**你** | 用户层补丁，模板是三行说明注释加一个空数组 `[]`（`packages/boot/app-boot/src/profile.ts:127-131`） |
| `pnpm-workspace.yaml` | `initProfile` 生成一次 | `packages: - .` / `nodeLinker: hoisted` / `autoInstallPeers: false`（`:138-143`） |
| `cordis.yml` | 每次**启动或 dump** 时重写（`apps/cli/src/profile-boot.ts:101`、`apps/cli/src/dump-config.ts:31`） | 三行说明注释加空数组 `[]` |

`package.json` 长这样（`docs/user/develop/basic/publish.md:85-101`）：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"]
    }
  }
}
```

`cordis.yml` 值得单独说一句，因为它长得像"主配置文件"，很容易被当成该改的地方。它**每次启动都被覆盖**成空列表（`apps/cli/src/profile-boot.ts:98-103`），文件头上就写着 "Edit cordis.patch.yml, not this file"（`:60-64`）。之所以还要在磁盘上留这么个空文件，是 loader 需要一个真实的 include root 来把 `baseUrl` 锚在 profile 目录；之所以每次重写，是 Loader 的 tree write-back 有可能把已经组合出来的行倒灌回文件，下次启动就会把每条 bundle insert 复制一遍（`:88-93`）。在这个文件里写东西等于白写。

`initProfile` 的三个文件都是 `if (!existsSync)` 才写，重复跑是幂等的（`packages/boot/app-boot/src/profile.ts:152-168`）。`web` 和 `headless` 两个名字有出厂模板、首次使用自动初始化；其它名字不存在时直接 fail loud（`packages/boot/app-boot/src/profile.ts:376-384`）：

```
dsh: profile "tui" does not exist; create it with 'dsh plugin --profile tui add <package>'
```

---

## 名字是怎么被找到的

### bundle 名：先问安装目录，再问 profile 目录

`resolveBundleDir` 的循环体只有一行值得看（`packages/boot/app-boot/src/profile.ts:347`）：

```ts
for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
```

`installAnchor` 是 dsh 自己那个包的 `package.json` 绝对路径（`apps/cli/src/profile-boot.ts:54`）。这个顺序就是契约：**in-box bundle（随 dsh 安装包一起发出去的那三个）永远来自"正在运行的这个 dsh"，不会被 profile 目录里的同名副本顶掉**（`packages/boot/app-boot/src/profile.ts:332-343`、`apps/cli/reference/README.md:11`）。你写 bundle 时可以放心假定 `@deepseek-ai/dsh-base` 一定在，而且版本跟 dsh 对得上（`docs/user/develop/basic/publish.md:128`）。

写成图就是一条两级回退链，先后顺序决定了谁赢：

```mermaid
flowchart TD
    N["<b>bundles 里的一个包名</b>"]
    A1{"<b>锚点一：dsh 自己那个包的 package.json</b>"}
    H1["<b>用它</b><br/>in-box bundle 永远来自正在运行的这个 dsh"]
    A2{"<b>锚点二：profile 目录的 package.json</b>"}
    H2["<b>用它</b><br/>pnpm 装进 profile 的外部 bundle"]
    X["<b>cannot resolve profile bundle</b><br/>报错里直接给出该跑的 install 命令"]

    N --> A1
    A1 -- "找到" --> H1
    A1 -- "没找到" --> A2
    A2 -- "找到" --> H2
    A2 -- "没找到" --> X

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    class A1,A2 main
    class H1,H2 data
    class N entry
    class X danger
```

两个锚点都落空时的报错会直接告诉你下一步跑什么（`packages/boot/app-boot/src/profile.ts:351-354`），就是 `dsh plugin --profile <name> install`。

解析实现绕开了 `require.resolve`，改成遍历 `require.resolve.paths()` 找存在 `package.json` 的目录（`packages/boot/app-boot/src/profile.ts:322-330`）。好处落在你身上：你的包不必在 `exports` 里暴露 `./package.json`。

### `$DSH_HOME/profiles/node_modules`：一层扁平软链

profile 自己的 `node_modules` 由 pnpm 管，里面只有**外部**插件。可 patch 行里还写着 `@deepseek-ai/dsh-tools` 这种 in-box 插件名（base 就是这么写的，`packages/bundle/base/cordis.patch.yml:424-425`），pnpm 根本没装过它。它靠的是 Node 沿父目录上溯，走到兄弟目录 `profiles/node_modules`。

这个目录由 `healProfilesModuleFallback` 维护，**每次启动都跑一遍**（`apps/cli/src/profile-boot.ts:99`），幂等地补齐或重指软链。内容是"dsh app 可达依赖闭包里每个包一条软链，各自指向真实位置"（`packages/boot/app-boot/src/profile.ts:223-255`）；已消失的包留下的悬空链不清理，等同名包回来时再被重指（`:217-219`）。

三个设计细节解释了它为什么长这样。走的是 **BFS 闭包**而不是直接依赖，因为外部插件的 peer 会点名 `dsh-compaction`、`dsh-invariants` 这类 Service Definition 包（只声明服务接口、实现另在别的包里），app 只能通过 Provider 包间接够到它们（`packages/boot/app-boot/src/profile.ts:211-214`）。`dependencies` 和 `peerDependencies` 都参与展开（`:239`），因为 Service Definition 包永远是实现包的 peer、不是普通依赖。软链只需要一层，被软链的包解析自己的依赖时是从**真实目录**出发的（Node 默认跟随软链，`:215-217`）。

profile 那份 `pnpm-workspace.yaml` 里的几行也不是随手写的（`packages/boot/app-boot/src/profile.ts:133-143`）。`nodeLinker: hoisted` 让外部插件拿到扁平 `node_modules`，缺的 peer（cordis 那一票）就顺势落到这个 fallback 上，于是**所有插件共用安装目录里那一份 cordis 实例**，而不是各自复制一份。复制一份意味着进程里有两个 cordis，`Service` 身份对不上号——源码注释只写到前半句，后半句是推论。

配套还有两条硬约束：profile 名字不许叫 `node_modules`（`packages/boot/app-boot/src/profile.ts:105-109`）；`profiles/node_modules/<pkg>` 位置上如果是个真目录而不是软链，dsh 拒绝接管并报错（`:180-183`）。

---

## 从零到发布，完整走一遍

```
① 建包                mkdir hello-plugin && cd hello-plugin
② 三个文件            package.json（含 dsh.bundle.patch）/ cordis.patch.yml / index.js
③ 本地装              dsh plugin --profile demo add ./hello-plugin
④ 不启动先验          dsh --profile demo --dump-config
⑤ 启动                dsh --profile demo
⑥ 发布                pnpm publish   或   pnpm pack
⑦ 别人装              dsh plugin --profile demo add dsh-hello-plugin
```

第 ④ 步最省时间，建议养成习惯。`--dump-config` 把 bundle 层、profile 层、home 层和 `--patch` 全部离线组合后打印（`apps/cli/src/dump-config.ts:32-48`），用的是与 boot **同一个** `applyEntryPatches`（`packages/boot/app-boot/src/index.ts:349-356`、`packages/boot/app-boot/src/profile.ts:413-420`），所以你看到的行组合就是实际会挂载的那份。输出里每一段前面带 `# == <来源>` 注释，来源是 bundle 的包名，被后续层改过还会追加 `, patched by <层>`（`packages/boot/app-boot/src/index.ts:454`、`:462-464`，层标签取自 `apps/cli/src/dump-config.ts:33`；文档里的示例输出见 `docs/user/develop/basic/publish.md:106`）。

有两处它给不了你：`!!js` 表达式保持未求值，app 命令行参数解析出来的值也不在里面——dump 不跑 provider，而且直接拒绝携带 app 参数（`apps/cli/src/args.ts:95-97`）。另外，打不中任何行的补丁走 stderr 告警，别只盯着 stdout。只想看 bundle 层就用 `--dump-default-config`（`apps/cli/reference/README.md:39`）。

第 ⑥ 步有三条路，代价不一样（`docs/user/develop/basic/publish.md:155-178`）：

| 分发方式 | 用户命令 | 要不要构建授权 |
|---|---|---|
| npm（`lib/` 在 publish 时构建好） | `dsh plugin --profile demo add your-package` | 不要 |
| tarball（`pnpm pack`） | `dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz` | 不要 |
| git | `dsh plugin --profile demo add github:you/hello-plugin` | **要** |

git 那条要单独说。它拉的是**源码不是产物**：没人跑你的 `build`，TypeScript 包会因为缺 `lib/` 直接加载失败。两边各要做一件事——作者侧提供一个自足的 `prepare` 脚本，不能假设旁边有 monorepo checkout；用户侧在 profile 的 `pnpm-workspace.yaml` 里放行（`docs/user/develop/basic/publish.md:161-171`）：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

首次 `add` 一定会失败，这是设计如此。参数里带 `github:` / `git+` / `.git` 时，dsh 会在 pnpm 自己的报错之后额外指出是**哪一个** `pnpm-workspace.yaml`（`apps/cli/src/plugin.ts:149-155`），省掉一次找文件的功夫。

官方对这件事的定性没有绕弯子：这是**允许该包在你机器上、在 agent 沙箱之外执行代码**。只放行你信得过的源，并把版本钉到 commit（`github:you/hello-plugin#<sha>`），免得对方一次 push 就悄悄换掉正在跑的东西（`docs/user/develop/basic/publish.md:173`）。

---

## 发布时的元数据：topic 与 README

给插件仓库打上 `dsh-plugin` 这个 **GitHub topic**（`README.md:40`、`CONTRIBUTING.md:15`）。注意是**仓库 topic**，不是 npm keyword——2026-08-14 数过，全仓 248 个 git 跟踪的 `package.json`（其中 `packages/*/*/` 占 226 个）没有一个声明 `keywords`，文档里也没有 npm 侧的收录约定。

scoped 包要公开发布，得写 `"publishConfig": { "access": "public" }`，自带 bundle 都是这么写的（`packages/bundle/base/package.json:5-7`）。

README 这块有个可以蹭的现成结构。仓库对**自己的** workspace 包有一套强制模板：末尾必须是 `## Model Experience`（下含 `What the model sees` / `Token effect` / `KV Cache effect`）接 `## Known Limitations and Deferred Work`，见 `docs/cookbook/adding-a-package.md:73-107`，由 `scripts/verify-package-readme-model-experience.ts` 与 `scripts/verify-package-readme-limitations.ts` 校验。这套模板只约束仓库内部包，对外部插件没有任何强制力。但它问的那几个问题——这个包让模型多看到什么、花多少 token、会不会打断 KV cache、有哪些已知缺口——恰好是别人装你插件前最想知道的，结构值得照抄。

还有一件文档没规定、但从上面的覆盖规则倒推出来的：把你插了哪些 id、覆盖了哪些 id、每行 config 有哪些字段写清楚。用户想改你的行就必须知道 id，不写等于逼人去翻你的 `cordis.patch.yml`。

> 想知道其它 agent 系统在插件分发这一点上怎么做，见 [五个 agent 系统源码解剖](../2026-08_五个agent系统源码解剖/00-总览与阅读指南.md)。

---

## 常见报错对照

| 现象 | 原因 | 出处 |
|---|---|---|
| `profile bundle "X" declares no dsh.bundle in its package.json` | 它被列进了 `bundles` 但不是 bundle | `packages/boot/app-boot/src/profile.ts:391-394` |
| `cannot resolve profile bundle "X" from the dsh installation or <dir>` | 两个锚点都没找到；跑 `dsh plugin --profile <n> install` | `:351-354` |
| `failed to read overlay <path>` | 声明了 `dsh.bundle.patch`，但包里没这个文件（多半是 `files` 漏了） | `packages/boot/app-boot/src/index.ts:303` |
| `warning: X declares no dsh.bundle — installed as a plain dependency` | 装成了普通库，没激活成层；不是错误 | `apps/cli/src/plugin.ts:71-74` |
| `overlay <f> must be a top-level YAML array of loader patch entries` | patch 文件写成了 map，或空文件/纯注释（profile 与 home 自己的 `cordis.patch.yml` 走另一个入口，同一句里 `overlay` 变成 `patches`） | `packages/boot/app-boot/src/index.ts:329-331` |
| `<link> exists and is not a symlink; remove it so dsh can manage the installation fallback` | `profiles/node_modules/<pkg>` 被人手动建成了真目录 | `packages/boot/app-boot/src/profile.ts:180-183` |
| `dsh: invalid profile name "node_modules"` | profile 名撞上了扁平 fallback 目录 | `:105-109` |
| `error: plugin needs pnpm arguments to forward (e.g. add <package>)` | `dsh plugin --profile x` 后面什么都没写 | `apps/cli/src/args.ts:179` |
| profile 里改了 `cordis.yml` 但毫无效果 | 它每次启动被重写成 `[]` | `apps/cli/src/profile-boot.ts:98-103` |

有一处**文档与实现对不上**，照文档抄会直接被拒。`docs/user/develop/basic/publish.md:177-178` 写的是 `dsh plugin add your-package`，但 `plugin` 子命令把 `--profile` 声明成了 `requiredOption`（`apps/cli/src/args.ts:173`），少了它 commander 直接拒掉。按实际语法写：`dsh plugin --profile <name> add <spec>`。

另有一条藏得比较深的自动改写，**只对名为 `headless` 的 profile 生效**。如果它的 bundles 恰好是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']` 这个历史三元组，`loadProfile` 会把它规整回出厂模板 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']` 并**写回磁盘**。任何其它列表——多一项、少一项、顺序不同——都被判定为用户自有，原样保留（`packages/boot/app-boot/src/profile.ts:119-122`、`:297-312`、`:385`）。

---

## 一句话带走

**bundle 是"包名 + 一层 patch"，profile 是"一份 bundles 顺序表"，`dsh plugin` 只是个把 pnpm 装出来的实际状态反向同步进这张表的转发器。**

你要做的全部工作，就是让 `package.json` 里有 `dsh.bundle.patch`、让 `files` 带上那个 patch 文件、让 patch 的顶层是个数组。

下一章讲 [headless 与 SDK](./23-headless与SDK.md)，那是本章 surface bundle 那一节的完整展开。

---

## 本章未确认

- ⚠️ 本章所有命令、目录结构、报错文案都是从源码与官方文档逐行读出的，**没有实际执行过**（仓库未安装依赖）。`dsh plugin add` 之后 profile `package.json` 的确切样子（包括 `link:` 这个依赖写法）引自 `docs/user/develop/basic/publish.md:85-101`，未在本机复现。
- ⚠️ npm / pnpm 侧的行为——`files` 决定 publish 打进哪些文件、pnpm ≥10 拦住 git 依赖的 `prepare` 直到 `allowBuilds` 放行——是包管理器语义与官方文档的说法（`docs/user/develop/basic/publish.md:161-171`）；本仓库代码里能核到的只有 dsh 那句提示文案（`apps/cli/src/plugin.ts:149-155`）。
- ⚠️ `turtle-ui`（`docs/user/develop/basic/publish.md:163`、`apps/cli/reference/README.md:46`）被官方举为"自足 `prepare` 脚本"的范例，它是仓库外的 GitHub 项目，本章未克隆核对其内容。
- ⚠️ 关于"bundle README 该写哪些内容"的建议，除仓库内部模板（`docs/cookbook/adding-a-package.md:73-107`）外的部分是从 patch 覆盖规则推导的实践建议，**不是官方规定**。
- ⚠️ `pnpm publish` / `pnpm pack` 的具体产物内容取决于你自己的 `files` 与构建脚本；仓库只给了这两条命令名（`docs/user/develop/basic/publish.md:177-178`），没有给出面向外部插件作者的完整发布脚本模板。
- ⚠️ npm 上的 `0.1.0-rc.6` 与本章依据的 `0.1.0-rc.5`（commit `47f9438`）之间若有 profile/bundle 契约变更，本章未覆盖。
