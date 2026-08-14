# typert

> `@deepseek-ai/dsh-typert-registry` · bundle：`base` · 配置树 id：`typert` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：一张进程内的表，存放构建期生成的包反射、Zod schema、Remote 调用描述符，以及 lookup / Context 提供者——所有登记都是 Cordis effect，随调用方 fiber 一起撤销。

README 开篇（`packages/typert/registry/README.md:5`）：“A contribution carries one package face's business reflection and optional live Zod schemas; `ctx.typert` registers both atomically and withdraws them with the calling Cordis fiber.”

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:30`：

```yaml
    - id: typert
      name: '@deepseek-ai/dsh-typert-registry'
```

没有 `inject`、没有 `config`——`docs/config-catalog.md:3151` 把它列在 Loadable plugins with no config 里。它是本组另外两个插件的 provider：[typert-loader](./dsh-typert-loader.md) 往里写，[typert-gateway](./dsh-api-gateway.md) 从里读。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.typert` | `TypertRegistry extends Service`，`super(ctx, 'typert')`（`packages/typert/registry/src/service.ts:446`、`:455`） |

没有事件监听（一个都没有），没有工具、prompt 段、命令。四个子注册表都是 getter：

| 子表 | 装什么 | 源码 |
|---|---|---|
| `ctx.typert.local` | 本环境的 `InvocationDescriptor`，只读视图（`get` / `hasSeen` / `list` / `subscribe`） | `packages/typert/registry/src/service.ts:467` |
| `ctx.typert.remotes` | 消费端显式选中的 Remote contribution（`register` / `get` / `list` / `subscribe`） | `packages/typert/registry/src/service.ts:478`、`:187` |
| `ctx.typert.lookups` | Host 对象查找：`register()` 由业务包给出稳定声明＋默认解析器，`configure()` 由 Host 组装层覆盖策略 | `packages/typert/registry/src/service.ts:483`、`:290`、`:263` |
| `ctx.typert.contexts` | 作用域 Context：`registerHost()` / `configureHost()` / `registerClient()` | `packages/typert/registry/src/service.ts:488`、`:402` |

加上包级 API：`register(contribution)`（`:499`）、`get` / `resolve` / `list`（`:527`、`:537`、`:558`）、`getPackage` / `listPackages`（`:568`、`:577`）、`toJSONSchema`（`:587`）。

三种身份格式，全是字符串拼的，别自己造：

| 形式 | 组成 | 源码 |
|---|---|---|
| 包面 | `<package>#<face>`，face 只能是 `host` / `client` | `packages/typert/registry/src/service.ts:58`、`:594` |
| schema | `<package>#<name>` | `packages/typert/registry/src/service.ts:48` |
| 端点 | `<namespace>/<method>` | `packages/typert/registry/src/service.ts:67` |

## 配置项

无配置项。它的内容 100% 由运行时调用方决定：默认树上写入者是 typert-loader（自动扫描 loader 条目），此外 `@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-session` 在构造函数里经 `ctx.inject(['typert'], ...)` 注册了 `agent` / `session` 两个 lookup（`packages/core/agent/src/index.ts:269`、`packages/core/session/src/index.ts:799`），`@deepseek-ai/dsh-api-remotes` 再用 `configure()` 覆盖它们的解析策略（`packages/api/remotes/src/agent-lookup.ts:205`）。

## 模型看得见什么

README 的 Model Experience 原文（`packages/typert/registry/README.md:24`）：

> None, as the registry contributes no prompt, tool, or session event; consumers such as `cordis_inspect` own any model-visible projection.

KV Cache effect（`packages/typert/registry/README.md:28`）：“No direct effect. A consumer that places reflection in a request owns the resulting prefix change.”

补一句核对结果：那个 `cordis_inspect` 消费者（`@deepseek-ai/dsh-tool-cordis`，其 API 目录里有 `key: 'typert'` 条目，`packages/extensions/tool-cordis/src/api-catalog.ts:1943`）**不在**默认三个 bundle 里，所以默认树上模型确实一个字都看不到。

## 什么时候你会想换掉它 / 怎么换

不建议换，也基本换不掉：Gateway 的 `static inject = ['typert']`，loader 的 `inject = ['typert', 'loader']`，关掉这一行会让两者一起停在 pending，`/api` 上的 Remote 调用全部落空。

真正的可替换点在它内部而非这一行：lookup 解析策略用 `ctx.typert.lookups.configure(key, resolver)` 覆盖，effect 生命周期结束就恢复业务包的默认策略（`packages/typert/registry/src/service.ts:263`，README `packages/typert/registry/README.md:12`）。想换一个存储实现，`register()` 也一直是公开的——README 说 “direct `ctx.typert.register()` supports other composition owners”（`packages/typert/registry/README.md:20`）。

浏览器侧另有一套：`./client` 子路径导出 `inject: []` 的同实现插件（`packages/typert/registry/src/client/index.ts:7`、`:13`），由 `dsh.client` 元数据声明（`packages/typert/registry/package.json:36`）——它和 base 这一行是两个进程里的两个实例，不共享内容。

## 坑与边界

README 的 Known Limitations（`packages/typert/registry/README.md:32`、`:33`）两条：注册表只存生成物，不合并 host/client 图、不解析 TypeScript 引用（那是 analyzer 与 emitter 的事）；schema key 不含 face，因为两个 face 跑在不同 context，同名 schema 从两个 face 注册进同一个 context 会被判重复。

读源码补充：

- **全批次原子**：包面、schema、invocation id、endpoint 任一重复，整个 contribution 被拒，什么都不写（`packages/typert/registry/src/service.ts:499`、`:120`、`:615`）。
- **`hasSeen` 是永不清空的历史集合**（`packages/typert/registry/src/service.ts:143`、`:169`）。端点撤销后它仍返回 true，Gateway 靠这个拒绝退化成 SRC（见 [typert-gateway](./dsh-api-gateway.md)）——这是有意的单向门，代价是这张表随进程生命周期只增不减。
- **lookup 的 wire 声明在本次进程内不可改**：同一 key 第二次 `register()` 若声明不一致直接抛 “changed its wire declaration during this registry lifetime”（`packages/typert/registry/src/service.ts:306`）。
- **`subscribe()` 不是 Cordis 事件**，是插件内部的 listener 集合（`packages/typert/registry/src/service.ts:83`）。监听器抛错只被 `ctx.logger.warn` 吞掉（`:456`），别指望用 Cordis 的事件工具观察它。
- 名字校验很严：包名/schema 名不能为空、不能含 `#`（`packages/typert/registry/src/service.ts:711`）；wire 字段只允许 `[A-Za-z0-9_$.-]`，且不能是 `.` 或 `..`（`:705`）。
- `toJSONSchema()` **不缓存**（`packages/typert/registry/src/service.ts:587`），每次调用重新投影一份。
