# 22 · 做一个 bundle 和 profile

> 基于 `deepseek-ai/deepseek-harness` v0.1.0-rc.5（commit `47f9438`），2026-08-14 核对。本章讲怎么把你写好的插件从"只有你本机能加载"变成"别人 `dsh plugin --profile <name> add` 一句话就能装上"。

**读完这章你会**：

- 分清 **plugin / bundle / profile** 三个东西各自是什么、各自由哪个 `package.json` 字段定义；
- 写出一个能发布的 bundle：`dsh.bundle.patch` + 自己的 `cordis.patch.yml`，既能往树里 `insert` 新行、也能按 `id` 改别人的行；
- 用 `dsh plugin --profile <name> add <spec>` 装本地目录 / tarball / git / npm 包，并看懂它改了 profile 的哪些文件；
- 说清 bundle 名字的两段式解析顺序，以及 `$DSH_HOME/profiles/node_modules` 那个扁平符号链接目录为什么必须存在；
- 走完一遍从空目录到 `pnpm publish` 的完整流程，并避开 git 安装的 `allowBuilds` 陷阱。

> 四层 patch 叠加的原理（bundle → profile → home → `--patch`）在 [03 章](./03-配置的四层结构.md) 已经讲过，本章只讲"怎么把自己塞进第一层"。

## 1. 三个名词，三种交付物

先把最容易混的三个词钉死。官方教程原话：bundle 是你写的、profile 是用户启动的，**没有东西同时是两者**（`docs/user/develop/basic/publish.md:13-16`）。

| | 是什么 | 靠什么被识别 | 住在哪 |
|---|---|---|---|
| **plugin** | 一个导出 `apply` 的模块 | 无（配置行里的 `name` 指向它） | 任意路径 / npm 包内 |
| **bundle** | 一个 npm 包，附带一层配置补丁 | `package.json` 里有 `dsh.bundle.patch`（`apps/cli/src/plugin.ts:44`） | npm / git / 本地目录 |
| **profile** | 一份可启动的组合 | 目录位置 + 目录里有 `package.json`；`dsh.profile.bundles` 决定它组合哪些 bundle | `$DSH_HOME/profiles/<name>/` |

注意 profile 这一格：`loadProfile` 只要求目录里有 `package.json`，`dsh` 段缺失时 bundles 按空列表处理（`packages/boot/app-boot/src/profile.ts:386-387`），并不会因此报错。

代码里这两个 manifest 是两个独立接口，挂在同一个 `dsh` 键下（`packages/boot/app-boot/src/profile.ts:42-62`，下面是去掉 doc 注释后的等价签名）：

```ts
export interface DshBundleManifest { patch: string }
export interface DshProfileManifest { bundles?: string[] }
export interface DshManifestSection { bundle?: DshBundleManifest; profile?: DshProfileManifest }
```

类型上一个包**可以**同时声明两者（源码注释原话 "A manifest may declare both roles"，`packages/boot/app-boot/src/profile.ts:53-56`），这与文档那句 "Nothing is both" 是"类型允许 / 实践不这么干"的关系。dsh 自带的三个 bundle 都只声明 `dsh.bundle`（`packages/bundle/base/package.json:36-40`、`web-app/package.json:41-45`、`headless/package.json:41-45`；`packages/bundle/` 下确实只有 base、web-app、headless 三个包）。

## 2. 第一层：本地插件，不打包

最原始的形态：写一个 `.ts`，用 `--patch` 挂进去。官方第一课的做法（`docs/user/develop/basic/index.md:50-54`）：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

（`docs/user/develop/basic/index.md:61`；`pnpm dsh` 是仓库源码运行方式，装好的 dsh 直接写 `dsh web --patch ...`。）

**路径必须是绝对的**：patch 文件只贡献配置，不改变 loader 解析模块路径的基准目录（`docs/user/develop/basic/index.md:56`）。这一步够你自己调试，但没法给别人——对方得知道你的绝对路径。往下一层走就是为了消灭这个绝对路径。

## 3. 第二层：做一个 bundle

一个 bundle 就是**三个文件**（`docs/user/develop/basic/publish.md:26-31`）：

```
hello-plugin/
├── package.json
├── cordis.patch.yml
└── index.js
```

`package.json`（`docs/user/develop/basic/publish.md:35-43`，逐字）：

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

绝对路径没了，换成**包名**——Node 的模块解析会找到装好的代码。

### 3.1 `dsh.bundle.patch` 是怎么被读的

`loadProfile` 对 `dsh.profile.bundles` 里的每个名字做四件事（`packages/boot/app-boot/src/profile.ts:388-397`）：解析包目录 → 读它的 `package.json` → 取 `dsh.bundle.patch` → `join(packageDir, declared)` 后当成必需 overlay 解析。

三个由此推出的事实：

- `patch` 是**相对包根目录的普通文件路径**，走文件系统 `join`，**不走 `exports` 映射**。仓库自带 bundle 里那条 `"./cordis.patch.yml": "./cordis.patch.yml"` 导出（`packages/bundle/base/package.json:25`）与 profile 加载无关；2026-08-14 全仓 grep 也没有任何代码 import 这个子路径，所以你的包不写这条导出照样能被 profile 加载。
- 但 **`files` 里必须列上 `cordis.patch.yml`**（自带 bundle 的 `files` 见 `packages/bundle/base/package.json:29-34`）。漏了它，包能装上、`dsh.bundle.patch` 也在，但读文件那步会抛 `dsh: failed to read overlay <路径>: ...`（`packages/boot/app-boot/src/index.ts:303`）——典型的"本地目录能跑、发布装上就炸"。
- 用的是 `loadOverlayPatches`（必需版），文件读不到就抛（`packages/boot/app-boot/src/index.ts:298-306`）；内容必须是**顶层 YAML 数组**，否则报 `overlay <file> must be a top-level YAML array of loader patch entries`（`packages/boot/app-boot/src/index.ts:329-331`）。空文件或只有注释的文件解析结果不是数组，同样抛错——要"这层什么都不做"就写 `[]`（`packages/boot/app-boot/README.md:43`）。

### 3.2 你的 patch 能干的两件事

补丁条目的具名字段是（`vendor/include/src/index.ts:145-156`）：`id` / `insert` / `name` / `config` / `group` / `disabled` / `inject` / `intercept` / `isolate`。它还带一条索引签名 `[key: string]: any`（`:155`），所以别的键也写得进来，并且会被逐键写到目标行上（`:121-124`）——写错键名不会报错，只会静静地给行加一个没人读的字段。`applyEntryPatches` 的处理规则是（`vendor/include/src/index.ts:58-128`）：

| 写法 | 行为 | 出处 |
|---|---|---|
| `- insert: [...]`（无 `id`） | 追加到根 entry 列表末尾 | `vendor/include/src/index.ts:93-95` |
| `- id: X` + `insert:` | 插进 id 为 X 的 **group** 行；X 不存在或不是 group → 只告警跳过 | `:80-92` |
| `- id: X` + 其它键 | 逐键覆盖到 X 行上（`config` 是一整个键，所以是整体替换） | `:121-124` |
| `- id: X` 但树里没有 X | 告警 `patch: entry "X" not found`，跳过 | `:110-113` |
| 没有 `id` 又没有 `insert` | 告警 `patch: id is required for non-insert patches` | `:105-107` |
| `- id: X` + `name: Y`（Y ≠ 现有 name） | **整条跳过**并告警 name mismatch | `:116-119` |

最后一条是个好用的保险：写 `name` 相当于"我确认这行确实是那个插件才改"，改错目标时会明说而不是默默生效。

`insert` 进来的行会被登记进索引（`vendor/include/src/index.ts:101`），所以**同一条链上后面的层可以按 id 改前面层刚插入的行**——这正是 `dsh-web-app` 覆盖 `dsh-base` 的机制：base 用一条 `- insert:` 铺了全部核心行（全文件只有这一个顶层条目，`packages/bundle/base/cordis.patch.yml:15-17`），web-app 再按 id 改：

```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: hmr
  disabled: true
```

（`packages/bundle/web-app/cordis.patch.yml:16-23`；被它覆盖的 base 原行在 `packages/bundle/base/cordis.patch.yml:429-432`，`persona: ''`）

**这里最容易踩的是**：`config` 整体替换，不深合并。你覆盖别人一行时必须把这行需要的键**全部重写一遍**，只写改动的那个键会把其余键抹成默认（`docs/user/develop/basic/publish.md:123-126`、`packages/boot/app-boot/README.md:60`）。反过来对你也成立：用户能在自己 profile 的 `cordis.patch.yml` 里覆盖你的行，你不必为此改包——所以默认值要选"用户大概率不会改"的那个。

### 3.3 如果你的 bundle 是一个"界面"

带自己命令行的 surface bundle（提供一个可运行 app 的 bundle，像 `dsh-headless` 那样）额外插一行 provider 插件。真实样板就是 headless 自己的 startup 插件：`export const inject = ['cmdlineArgs']`、用 `@deepseek-ai/dsh-cmdline` 的 `parseCmdline` 解析自己的 commander program、再把结果 `ctx.provide` 成服务（`packages/bundle/headless/src/startup.ts:16`、`:56`、`:10`）。需要这些 flag 的行 inject 该服务，并在 `!!js` 惰性表达式里读它（`!!js` 是 loader 的延迟求值标签，见 [09 章](./09-插件配置与Schema.md)）：

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

（`packages/bundle/headless/cordis.patch.yml:22` 那条 `- insert:` 下的 `:27-35`；同一条 insert 里还有一行 `code-runtime`，此处略去。这套写法的说明见 `docs/user/develop/basic/publish.md:130-151`。）

启动器完全不认识 `--resume` 这类 flag：它只解析自己的旗标，第一个不认识的 token 之后全部原样交给被启动的 profile（`apps/cli/src/args.ts:8-11`、`apps/cli/reference/README.md:17`）。

## 4. `dsh plugin`：它其实是 pnpm 的转发器

`dsh plugin --profile <name> <args...>` 做三步（`apps/cli/src/plugin.ts:120-158`）：

1. profile 目录没有 `package.json` → 先 `initProfile`，用同名模板、没模板就用 `['@deepseek-ai/dsh-base']`（`apps/cli/src/plugin.ts:121-125`，常量在 `packages/boot/app-boot/src/profile.ts:114-117` 与 `:125`）；
2. 以 **profile 目录为 cwd** `spawnSync('pnpm', args)`，`stdio: 'inherit'`（`apps/cli/src/plugin.ts:129-133`）——所以 `add` / `remove` / `why` / `update` 等 pnpm 动词全都原样可用（`apps/cli/src/args.ts:175`、`apps/cli/reference/README.md:43`）；pnpm 不在 PATH 上会直接退 127 并提示（`apps/cli/src/plugin.ts:136-138`）；
3. **只有 pnpm 退出码为 0** 才做 reconcile（`apps/cli/src/plugin.ts:143-144`）。

reconcile 的口径是"按安装后的实际状态"而不是"按命令行参数 diff"（`apps/cli/src/plugin.ts:59-91`）：遍历 `dependencies`，每个能解析到、且 manifest 里有 `dsh.bundle.patch` 的包就**追加**进 `dsh.profile.bundles`；本次新增却没有 `dsh.bundle` 的包打一次告警：

```
dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
```

（`apps/cli/src/plugin.ts:71-74`）反过来，依赖没了或新版本删掉了 `dsh.bundle`，那一层就自动退出（`:77-87`）。两个推论：**`update` 到一个新增了 `dsh.bundle` 的版本会自动激活它**（`apps/cli/src/plugin.ts:7-9`）；而模板自带的 in-box bundle 不是 dependency，永远不会被摘掉（`:79-81`）。

相对路径参数会先按**你敲命令时所在的目录**重写成绝对路径（`apps/cli/src/plugin.ts:104-112`，cwd 取自 `:129`）。没有这一步，`add .` 会因为 cwd 是 profile 目录而把 profile 自己链接给自己。`file:` / `link:` 前缀保留原样，因为 pnpm 对这两者的 link-vs-copy 语义不同。

## 5. profile 目录逐文件

`dsh plugin --profile demo add ./hello-plugin` 之后（`docs/user/develop/basic/publish.md:80`），`$DSH_HOME/profiles/demo/` 里是 `initProfile` 写的**三个**文件（外加 pnpm 自己的 `node_modules/` 与 lockfile）；`cordis.yml` 要等第一次启动或第一次 dump 才出现：

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

关于 `cordis.yml`：它**每次启动都被覆盖**成空列表（`apps/cli/src/profile-boot.ts:98-103`），文件里自带一行提醒"Edit cordis.patch.yml, not this file"（`:60-64`）。之所以要在磁盘上留这个空文件，是因为 loader 需要一个真实的 include root 来把 `baseUrl` 锚在 profile 目录；之所以每次重写，是因为 Loader 的 tree write-back 可能把已组合出来的行倒灌回文件，下次启动就会把每条 bundle insert 复制一遍（`:88-93`）。**在这个文件里写东西 = 白写。**

`initProfile` 三个文件都是 `if (!existsSync)` 才写，所以重复跑是幂等的（`packages/boot/app-boot/src/profile.ts:152-168`）。`web` / `headless` 两个名字有出厂模板、首次使用自动初始化，其它名字不存在时直接 fail loud（`packages/boot/app-boot/src/profile.ts:376-384`）：

```
dsh: profile "tui" does not exist; create it with 'dsh plugin --profile tui add <package>'
```

## 6. 名字怎么被解析：两段式 + 那个扁平软链目录

### 6.1 bundle 名：先安装目录，后 profile 目录

`resolveBundleDir` 的循环体只有一行值得看（`packages/boot/app-boot/src/profile.ts:347`）：

```ts
for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
```

`installAnchor` 是 dsh 自己那个包的 `package.json` 绝对路径（`apps/cli/src/profile-boot.ts:54`）。顺序即契约：**in-box bundle（随 dsh 安装包一起发出去的那三个）永远来自"正在运行的这个 dsh"，绝不会被 profile 目录里的同名副本顶掉**（`packages/boot/app-boot/src/profile.ts:332-343`、`apps/cli/reference/README.md:11`）。你写 bundle 时可以据此假定 base 一定在、且版本与 dsh 一致（`docs/user/develop/basic/publish.md:128`）。

两个锚点都找不到时的报错（`packages/boot/app-boot/src/profile.ts:351-354`）会直接告诉你跑 `dsh plugin --profile <name> install`。

解析实现不用 `require.resolve`，而是遍历 `require.resolve.paths()` 找存在 `package.json` 的目录（`packages/boot/app-boot/src/profile.ts:322-330`）——这样你的包**不必**在 `exports` 里暴露 `./package.json`。

### 6.2 `$DSH_HOME/profiles/node_modules`：一层扁平软链

profile 目录自己的 `node_modules` 由 pnpm 管，里面只有**外部**插件。可是 patch 行里写的 `@deepseek-ai/dsh-tools` 这种 in-box 插件名（base 就这么写，`packages/bundle/base/cordis.patch.yml:424-425`），pnpm 根本没装过——它靠 Node 的父目录上溯走到兄弟目录 `profiles/node_modules`。

`healProfilesModuleFallback` **每次启动都跑一遍**（`apps/cli/src/profile-boot.ts:99`），幂等地补齐 / 重指软链，内容是"dsh app 可达依赖闭包里每个包一条软链，各自指向真实位置"（`packages/boot/app-boot/src/profile.ts:223-255`）；已消失的包留下的悬空链不清理，等同名包回来时再被重指（`:217-219`）。三个设计细节：

- 走的是 **BFS 闭包**（从 app manifest 出发逐层展开依赖）而不是直接依赖，因为外部插件的 peer 会点名 `dsh-compaction`、`dsh-invariants` 这类 Service Definition 包（只声明服务接口、实现另在别的包里），app 只能通过 Provider 包间接够到它们（`packages/boot/app-boot/src/profile.ts:211-214`）；
- `dependencies` 和 `peerDependencies` 都参与（`:239`）——Service Definition 包永远是实现包的 peer，不是普通依赖；
- 软链只需一层：被软链的包解析自己的依赖时是从**真实目录**出发的（Node 默认跟随软链，`:215-217`）。

profile 的 `pnpm-workspace.yaml` 里那几行不是随手写的（`packages/boot/app-boot/src/profile.ts:133-143`）：`nodeLinker: hoisted` 让外部插件拿到扁平 `node_modules`，缺的 peer（cordis 等）就顺势落到这个 fallback 上，于是**所有插件共用安装目录里那一份 cordis 实例**而不是各自复制一份。复制一份就意味着进程里有两个 cordis，`Service` 身份对不上号（源码注释只写到前半句，后半句是推论）。

配套的两个硬约束：profile 名字不许叫 `node_modules`（`packages/boot/app-boot/src/profile.ts:105-109`）；`profiles/node_modules/<pkg>` 位置上如果是个真目录而不是软链，dsh 拒绝接管并报错（`:180-183`）。

## 7. 从零到发布：完整走查

```
① 建包                mkdir hello-plugin && cd hello-plugin
② 三个文件            package.json（含 dsh.bundle.patch）/ cordis.patch.yml / index.js
③ 本地装              dsh plugin --profile demo add ./hello-plugin
④ 不启动先验          dsh --profile demo --dump-config
⑤ 启动                dsh --profile demo
⑥ 发布                pnpm publish   或   pnpm pack
⑦ 别人装              dsh plugin --profile demo add dsh-hello-plugin
```

第 ④ 步是最省时间的一步：`--dump-config` 把 bundle 层 + profile 层 + home 层 + `--patch` 全部离线组合后打印（`apps/cli/src/dump-config.ts:32-48`），用的是与 boot **同一个** `applyEntryPatches`（`packages/boot/app-boot/src/index.ts:349-356`、`packages/boot/app-boot/src/profile.ts:413-420`），所以行的组合结果与实际挂载一致。输出里每一段前面会有 `# == <来源>` 注释，来源就是 bundle 的包名，被后续层改过还会追加 `, patched by <层>`（`packages/boot/app-boot/src/index.ts:454`、`:462-464`，层标签取自 `apps/cli/src/dump-config.ts:33`；文档里的示例输出见 `docs/user/develop/basic/publish.md:106`）。两点保留：`!!js` 表达式保持未求值，app 命令行参数解析出来的值也不在里面（dump 不跑 provider，且直接拒绝携带 app 参数，`apps/cli/src/args.ts:95-97`）；打不中任何行的补丁走 stderr 告警。`--dump-default-config` 则只打印 bundle 层（`apps/cli/reference/README.md:39`）。

第 ⑥ 步三条路，代价不同（`docs/user/develop/basic/publish.md:155-178`）：

| 分发方式 | 用户命令 | 要不要构建授权 |
|---|---|---|
| npm（`lib/` 在 publish 时构建好） | `dsh plugin --profile demo add your-package` | 不要 |
| tarball（`pnpm pack`） | `dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz` | 不要 |
| git | `dsh plugin --profile demo add github:you/hello-plugin` | **要** |

git 安装拉的是**源码不是产物**：没人跑你的 `build`，TypeScript 包会因为缺 `lib/` 直接加载失败。作者侧要提供一个自足的 `prepare` 脚本（不能假设旁边有 monorepo checkout）；用户侧要在 profile 的 `pnpm-workspace.yaml` 里放行（`docs/user/develop/basic/publish.md:161-171`）：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

首次 `add` 会失败；参数里带 `github:` / `git+` / `.git` 时，dsh 会在 pnpm 自己的报错之后额外指出是**哪一个** `pnpm-workspace.yaml`（`apps/cli/src/plugin.ts:149-155`）。官方把这件事说得很直白：这是**允许该包在你机器上、在 agent 沙箱之外执行代码**，只放行你信得过的源，并把版本钉到 commit（`github:you/hello-plugin#<sha>`），免得对方一次 push 就换掉跑的东西（`docs/user/develop/basic/publish.md:173`）。

## 8. 发布时的元数据：topic 与 README

- **GitHub topic**：给插件仓库打 `dsh-plugin`（`README.md:40`、`CONTRIBUTING.md:15`）。这是**仓库 topic**，不是 npm keyword——2026-08-14 数过，全仓 248 个 git 跟踪的 `package.json`（其中 `packages/*/*/` 占 226 个）没有一个声明 `keywords`，文档里也没有 npm 侧的收录约定。
- **scoped 包**：公开发布需要 `"publishConfig": { "access": "public" }`，自带 bundle 都这么写（`packages/bundle/base/package.json:5-7`）。
- **README**：仓库对**自己的** workspace 包有一套强制模板——末尾必须是 `## Model Experience`（下含 `What the model sees` / `Token effect` / `KV Cache effect`）接 `## Known Limitations and Deferred Work`（见 `docs/cookbook/adding-a-package.md:73-107`，由 `scripts/verify-package-readme-model-experience.ts` 与 `scripts/verify-package-readme-limitations.ts` 校验）。这套模板**只约束仓库内部包**，对外部插件没有任何强制；但其中"这个包让模型多看到什么 / 花多少 token / 会不会打断 KV cache / 有哪些已知缺口"几个问题恰好是别人装你插件前最想知道的，值得照抄结构。至于"我这个 bundle 插了哪些 id、覆盖了哪些 id、每行 config 有哪些字段"——文档没规定要写，但从第 3.2 节的覆盖规则看，用户想改你的行就必须知道 id，不写等于让人去翻 `cordis.patch.yml`。

> 想知道这一点上 Pi / Codex / LangChain 怎么做，见 [五个 agent 系统源码解剖](../2026-08_五个agent系统源码解剖/00-总览与阅读指南.md)。

## 9. 常见报错对照

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

还有一个**文档与实现不一致**的坑：`docs/user/develop/basic/publish.md:177-178` 写的是 `dsh plugin add your-package`，但 `plugin` 子命令把 `--profile` 声明成了 `requiredOption`（`apps/cli/src/args.ts:173`），少了它会被 commander 直接拒掉。照实际语法写：`dsh plugin --profile <name> add <spec>`。

另有一条隐藏的自动改写，**只对名为 `headless` 的 profile 生效**：如果它的 bundles 恰好是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']` 这个历史三元组，`loadProfile` 会把它规整回出厂模板 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']` 并**写回磁盘**；任何其它列表（多一项、少一项、顺序不同）都被判定为用户自有，原样保留（`packages/boot/app-boot/src/profile.ts:119-122`、`:297-312`、`:385`）。

## 10. 本章未确认

- ⚠️ 本章所有命令、目录结构、报错文案都是从源码与官方文档逐行读出的，**没有实际执行过**（仓库未安装依赖）。`dsh plugin add` 之后 profile `package.json` 的确切样子（包括 `link:` 这个依赖写法）引自 `docs/user/develop/basic/publish.md:85-101`，未在本机复现。
- ⚠️ npm / pnpm 侧的行为——`files` 决定 publish 打进哪些文件、pnpm ≥10 拦住 git 依赖的 `prepare` 直到 `allowBuilds` 放行——是包管理器语义与官方文档的说法（`docs/user/develop/basic/publish.md:161-171`）；本仓库代码里能核到的只有 dsh 那句提示文案（`apps/cli/src/plugin.ts:149-155`）。
- ⚠️ `turtle-ui`（`docs/user/develop/basic/publish.md:163`、`apps/cli/reference/README.md:46`）被官方举为"自足 `prepare` 脚本"的范例，它是仓库外的 GitHub 项目，本章未克隆核对其内容。
- ⚠️ 第 8 节关于"bundle README 该写哪些内容"的建议中，除仓库内部模板（`docs/cookbook/adding-a-package.md:73-107`）外的部分是从 patch 覆盖规则推导的实践建议，**不是官方规定**。
- ⚠️ `pnpm publish` / `pnpm pack` 的具体产物内容取决于你自己的 `files` 与构建脚本；仓库只给了这两条命令名（`docs/user/develop/basic/publish.md:177-178`），没有给出面向外部插件作者的完整发布脚本模板。
- ⚠️ npm 上的 `0.1.0-rc.6` 与本章依据的 `0.1.0-rc.5`（commit `47f9438`）之间若有 profile/bundle 契约变更，本章未覆盖。
