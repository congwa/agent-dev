# typert-gateway

> `@deepseek-ai/dsh-api-gateway` · bundle：`base` · 配置树 id：`typert-gateway` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：把一次 `<namespace>/<method>` 调用落到活着的 Cordis 服务方法上——解析描述符、校验参数、把 id 换成 Host 对象、调用、再校验返回值；传输、相关性、信封全归 Connection。

README 首句：“Two-sided Typert RPC endpoint for Host and Client Cordis environments. The Host entry provides `ctx.typertGateway`, while `@deepseek-ai/dsh-api-gateway/client` provides `ctx.remote`”（`packages/api/gateway/README.md:5`）。**base 这一行装的是 Host 那一半**；`ctx.remote` 是浏览器侧另一个入口，由 `dsh.client` 元数据声明（`packages/api/gateway/package.json:36`），contribution 由 api-remotes 的 client 面调 `$mount()` 装配（`packages/api/remotes/src/client/index.ts:111`）。

## 它在树上长什么样

`packages/bundle/base/cordis.patch.yml:36`：

```yaml
    - id: typert-gateway
      name: '@deepseek-ai/dsh-api-gateway'
```

无 `inject`、无 `config`——`docs/config-catalog.md:3029` 把它列在无配置插件里并注明 `requires typert`，来自 `static inject = ['typert']`（`packages/api/gateway/src/index.ts:91`）。注意它**没有**注入 `connection`：那是运行期的软依赖（见下）。web 树里的 `connection` / `api-remotes` 两行在 `packages/bundle/web-app/cordis.patch.yml:156`、`:165`。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.typertGateway` | `TypertGatewayService extends Service`，`super(ctx, 'typertGateway')`（`packages/api/gateway/src/index.ts:90`、`:100`） |
| 事件监听 | `internal/service`（**emit**） | 只做一件事：清掉 SRC 端点认领缓存 `srcClaims`（`packages/api/gateway/src/index.ts:101`）。cordis 里该事件无 `@mode` 标注即 emit（`vendor/cordis/src/events.ts:341`），派发点 `vendor/cordis/src/reflect.ts:333`——**不是 waterfall，不参与任何决策** |
| RPC 拦截器 | Connection `/api` 通道 | `ctx.inject(['connection'], ...)` 里调 `connection.rpc.intercept('/api', matches, handler, { authority: 'trusted-host' })`（`packages/api/gateway/src/index.ts:104`–`:110`）。`intercept` 的语义是在共享 `/api` 通道的 fallback 之前拦下自己认领的端点（`packages/client/connection/src/rpc.ts:40`、`:47`），认领不到的落回 API Proxy（`docs/api-gateway.md:123`） |

没有工具、没有 prompt 段、没有命令。

认领规则（`packages/api/gateway/src/index.ts:114`）：端点必须正好两段且两段非空；然后满足以下任一——`ctx.typert.local.get(endpoint)` 有严格描述符、或 `hasSeen(endpoint)` 为真、或落在 SRC 标记扫描出的集合里（`:117`、`:122`）。

一次 `invoke()` 的顺序（`packages/api/gateway/src/index.ts:145`）：解析描述符 → `assertExactArguments`（`:148`、`:586`：多一个字段、少一个非可省字段都拒）→ 解析 receiver Context（`:359`，`@RemoteScope` 走 `contexts.getHost`，`:366`）→ 取服务并校验 `typertRemote` 绑定（`:158`、`:495`）→ 逐参数 decode / lookup 解析（`:407`）→ 有 `cancellation` 时把 signal 追加在业务参数之后（`:161`，缺 signal 时用一个永不 abort 的常量 `:41`）→ 调用 → 校验返回值（`:183`）。

## 配置项

无配置项。行为由三样东西决定：`ctx.typert` 里的描述符与提供者、当前活着的 Cordis 服务、以及 `connection` 是否存在。

## 模型看得见什么

README 的 Model Experience（`packages/api/gateway/README.md:29`）：

> None, as the package dispatches application calls and registers no prompt, tool, or session event.

KV Cache effect：“No direct effect; invoked business Services own any model-visible result.”（`packages/api/gateway/README.md:33`）源码核对一致——它服务的是浏览器 UI 的 RPC，不是模型的工具调用。

## 什么时候你会想换掉它 / 怎么换

- **CLI / headless 场景本来就只用了它的一半**：那些 profile 没有 `connection` 服务，`ctx.inject(['connection'], ...)` 的回调永不执行，`/api` 拦截器不装，只剩同进程直调 `ctx.typertGateway.invoke()`。你无需为此改配置。
- **想换错误映射或鉴权** → 换不了，那些在 Connection 层：`authority: 'trusted-host'` 是这行代码写死的常量（`packages/api/gateway/src/index.ts:109`），Connection 在 HTTP 桥之前做统一信任校验（`docs/api-gateway.md:123`）。
- **想换 lookup 解析策略**（比如禁掉冷会话自动恢复）→ 去 [typert](./dsh-typert-registry.md) 的 `lookups.configure(key, resolver)`，不要动 Gateway；解析器可以用 `TypertLookupFailure` 携带一个已有的 RPC 错误码原样透传（`packages/api/gateway/README.md:13`、源码 `packages/api/gateway/src/index.ts:478`）。
- **想让端点更严格** → 让包产出严格产物，由 [typert-loader](./dsh-typert-loader.md) 注册；SRC 只是从源码跑时的开发兜底。

## 坑与边界

README 的 Known Limitations（`packages/api/gateway/README.md:35`）要点：Connection 适配器把普通派发失败与业务异常一律压成 RPC `internal` 且 details 为空，结构化的 `TypertGatewayError` 分类只有同进程调用方看得到；SRC 只支持无解构、无默认值、无 rest 的唯一标识符参数，且只校验 JSON 安全性、从不推断可选字段；Client face 只能挂严格 contribution；只支持一元方法，增量 Session 数据走另一套流式协议；lookup 策略按 key 配置，单个参数或端点无法单独选择 live-only；转发事件到 `$on` 不做投影或脱敏，也不在重连后重放。

读源码补充：

- **错误码有 17 个**（`docs/subsystems/typert.md:158`），但过了 RPC 边界只剩三种形态：`cancelled`（业务在 signal abort 后抛错，`packages/api/gateway/src/index.ts:176`、`:472`）、`TypertLookupFailure` 原样透传（`:478`）、其余一律 `internal` 且 `details: {}`（`:481`）。排查时看 host 日志，别看浏览器拿到的码。
- **严格定义撤销后不会退化成 SRC**：`hasSeen` 命中就抛 `definition-unavailable`（`packages/api/gateway/src/index.ts:227`），README 的说法是 “Withdrawing an observed strict definition fails instead of weakening validation.”（`packages/api/gateway/README.md:11`）。热卸载一个包不会悄悄放松校验。
- **SRC 靠 `Function.prototype.toString()` 抠参数名**（`packages/api/gateway/src/index.ts:562`）：只接受唯一标识符形参，解构、默认值、rest、重名一律抛 `signature-invalid`（`:578`）。非 lookup 参数的 wire 字段名**就是**形参名（`:300`），所以压缩/转译改名不会触发 `signature-invalid`，而是让调用方的 `args` 对不上，落到 `arguments-invalid`（`:611`）。同一端点被两个活服务导出则抛 `ambiguous-endpoint`（`:256`）。
- **返回值也要过 JSON 安全检查**：非有限数、循环引用、稀疏数组、带 symbol 属性的对象、非 plain 原型对象全部判 `result-invalid`（`packages/api/gateway/src/index.ts:640`）。业务方法返回一个类实例会在边界上炸，而不是被静默序列化。
- **`undefined` 的规则不对称**：weak 描述符下 `undefined` 视为 void 直接返回，strict 描述符下必须是声明过的结果（`packages/api/gateway/src/index.ts:182`）。
- 每次调用都重新解析描述符与服务，不缓存业务对象（`docs/api-gateway.md:125`）——这是热重载安全的代价，也是它的设计意图。
