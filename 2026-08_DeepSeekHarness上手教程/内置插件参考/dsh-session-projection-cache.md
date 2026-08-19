# session-projection-cache

> `@deepseek-ai/dsh-session-projection-cache` · bundle：`web-app` · 配置树 id：`session-projection-cache` · v0.1.0-rc.5（commit `47f9438`）2026-08-14 核对

**一句话**：给 [session-projection](./dsh-session-projection.md) 的投影值做耐久检查点（`ctx.sessionProjectionCache`），一个会话一条记录，让会话列表能零 I/O 读到投影值、冷读会话不必整份加载日志。

## 它在树上长什么样

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

出处 `packages/bundle/web-app/cordis.patch.yml:76`。

注意这行**只在 web-app bundle 里**，base 和 headless 都没有。

还有一处反直觉的：两个字段都**必填无默认**（`src/index.ts:49`–`52` 里两个 `.required()`）。理由是刷写节奏属于部署选择，没有普适正确值，所以强制由组合层显式写出来（`packages/session/session-projection-cache/README.md:26`）。

## 它注册了什么

| 类型 | 名字 | 说明 |
|---|---|---|
| service | `ctx.sessionProjectionCache`（`SessionProjectionCache`） | `src/index.ts:71`、`80`；`static inject = ['storageDomain', 'sessionProjections', 'sessionPersistence', 'sessions']`（`src/index.ts:72`） |
| storage domain | `session_projcache`，表 `sessions` | 在 `Service.init` 里 open（`src/index.ts:84`–`87`，spec 在 `src/spec.ts:66`–`70`）；shipped 的 json 后端落到 `<root>/session_projcache.json`，和 `workspace.json` 并列（`src/spec.ts:6`–`8`），web-app 的 root 是 `dshHomePath('storages')`（`cordis.patch.yml:57`） |
| 事件监听 | `session/event`（**emit**） | `turn/end` 直接强制写；否则累加脏计数，撞 `writeEveryEvents` 立即写，否则起一个 `writeIntervalMs` 定时器（`src/index.ts:205`–`220`） |
| 事件监听 | `session/disposed`（**emit**） | 第二个强制写点（live→cold 的那一刻），写完清脏状态（`src/index.ts:226`–`230`） |

两个事件的派发模式见 `docs/event-producer-consumer.md:42`–`43`。不注册工具、命令、prompt 段。

## 配置项

| 字段 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `writeEveryEvents` | `number`（自然数，≥1） | 无默认，web-app 给 `200` | 两个强制写点之间，每会话提交多少条事件就强制一次耐久检查点 |
| `writeIntervalMs` | `number`（自然数，≥1） | 无默认，web-app 给 `5000` | 一个脏检查点最长能不写多久（毫秒） |

写策略一共四个触发点（`README.md:19`–`24`），关键区别是前两个**是策略不是旋钮**，永远会触发：

| 触发点 | 性质 | 为什么 |
|---|---|---|
| `turn/end` | 强制，不可关 | 冷读最想要的就是回合终值 |
| 会话摘离 | 强制，不可关 | live→cold 的那一刻 |
| 计数阈值 | 可配节流 | `writeEveryEvents` |
| 间隔阈值 | 可配节流 | `writeIntervalMs` |

`session/event` 那条监听里的取舍写成伪代码是这样：

```
on session/event(e):
    if e is turn/end:
        写盘()                       // 强制，配置管不着
        return
    脏计数 += 1
    if 脏计数 >= writeEveryEvents:
        写盘()                       // 撞阈值，立即写
    else:
        起一个定时器(writeIntervalMs)  // 兜底，最长不写这么久
```

四个触发点最后都收拢到同一次写盘动作：

```mermaid
flowchart TD
    A["<b>session/event 到达</b>"]
    B["<b>turn/end 事件</b>"]
    C["<b>脏计数达到 writeEveryEvents</b>"]
    D["<b>writeIntervalMs 定时器到期</b>"]
    E["<b>session/disposed</b><br/>live→cold 那一刻"]
    F["<b>写耐久检查点</b><br/>session_projcache 表 sessions"]

    A -- "强制，不可关" --> B
    A -- "可配节流" --> C
    A -- "可配节流" --> D
    B --> F
    C --> F
    D --> F
    E -- "强制，不可关" --> F

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    class A,E entry
    class B,C,D main
    class F data
```

## 四条不可动摇的性质

**一行缓存是折叠捷径，永远不是权威。** 它可能陈旧——`seq` 会精确说明陈旧了多少——但绝不会错（`README.md:7`）。

**`ver` 与活单元的 `stateVersion` 不匹配就丢弃、绝不迁移**，该 key 从日志重折（`README.md:10`）。

**日志领先，缓存跟随。** `write()` 的顺序是先取注册表切面，再 `ctx.sessions.flush(session)`，最后才落缓存行：

```
write():
    切面 = 取注册表切面()
    ctx.sessions.flush(session)   // 日志先落地
    落缓存行(切面)                 // 缓存才跟上
```

所以崩溃可能让缓存落后于日志（代价是多重放一段尾巴），但绝不会领先（凭空折出没有日志支撑的值）。实现在 `src/index.ts:141`–`151`。

**记录绑定日志生命周期，而非仅绑 id。** 每条记录会存下它折自的 header 身份（`createdAt`、`cwd`），读的时候校验。于是删了又重建的同名 id、或者在缓存存活期间被换掉的持久化 store，都会让整条记录被丢弃（`src/spec.ts:30`–`42`、`src/index.ts:291`–`298`）。

另外，所有后台写都是 fail-soft：失败只打一条 warning、缓存保持陈旧，下一次写或冷读自愈（`src/index.ts:246`–`252`）。

## 两条读路径

一条零 I/O，一条走完整梯子。

**`cachedSnapshot(meta)`——零 I/O 那一级。** 直接从身份匹配的记录里 view 出整值，只取版本匹配的 key。没有可用记录就返回 `undefined`。

这里唯一需要停下来想的是 `asOfSeq` 的取法：

```
asOfSeq = min(所供给的每一行的水位)   // 取最低，不是最高
```

取最低是为了让客户端按 higher-seq-wins 播种时，陈旧的列表块永远盖不掉更新的 push 帧。函数在 `src/index.ts:119`，`asOfSeq` 那步在 `:128`。

**`coldSnapshot(id, signal?)`——冷读梯子**，顺路的好处是零全量日志加载。梯子五级：

```
缓存行
  → sessionProjections.restoreFloor
  → 持久化 readFrom(id, floor)
  → sessionProjections.restore
  → fail-soft 写回
```

地板锚在最低可用水位**下方一条**（`packages/session/session-projection/src/index.ts:309`）。这一条之差是有意的，它让"日志被崩溃修复截短"变得可证：

```
if 地板越界:
    从 seq 0 全量重读一次     // 恰好一次，不是每次
else:
    正常按 floor 往后读
```

也就是说越界会触发**恰好一次**从 seq 0 的全量重读，而不是供出幽灵值（`src/index.ts:184`–`194`）。没有持久化日志的会话，按 seam 的 `not found` 拒绝。函数在 `src/index.ts:166`。

并排看更清楚谁快谁慢：

```mermaid
flowchart LR
    subgraph CACHED["cachedSnapshot：零 I/O"]
        CA["<b>身份匹配的缓存记录</b><br/>只取版本匹配的 key"]
        CB["<b>直接 view 出整值</b><br/>asOfSeq 取最低水位"]
        CA --> CB
    end
    subgraph COLD["coldSnapshot：冷读梯子"]
        DA["<b>缓存行</b>"]
        DB["<b>sessionProjections.restoreFloor</b>"]
        DC["<b>持久化 readFrom(id, floor)</b>"]
        DD["<b>sessionProjections.restore</b>"]
        DE["<b>fail-soft 写回</b>"]
        DA --> DB --> DC --> DD --> DE
    end

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    class CA,CB data
    class DA,DB,DC,DD,DE main
```

## 模型看得见什么

**什么都看不见。**

README 原文：`None, as the cache only persists and restores host-side read models of already-logged session state and touches no prompt, message, schema, stream, or tool result.`（`README.md:52`）KV Cache 同为 None。

## 什么时候你会想换掉它 / 怎么换

没有替代实现。可做的是三件事。

### 1. 加到别的 profile 上

base/headless 没有这一行。往 profile 的 `cordis.patch.yml` 加行只有 `insert` 一条路（`vendor/include/src/index.ts:80`–`95`）。

这里有个坑：顶层裸写 `- id: … name: …` 会被当成针对**既有行**的 patch，报 `patch: entry not found` 之后跳过（同文件 `:110`–`113`）——不报错、不生效，很难发现。所以必须这么写：

```yaml
- insert:
    - id: session-projection-cache
      name: '@deepseek-ai/dsh-session-projection-cache'
      config:
        writeEveryEvents: 200
        writeIntervalMs: 5000
```

还要注意它硬性 inject `storageDomain`，而 `storage` / `storage-json` / `storage-domain` 三行同样只在 web-app（`packages/bundle/web-app/cordis.patch.yml:51`–`62`），得一起补。

### 2. 调节流

会话很长又想让列表更新，就调小 `writeEveryEvents`；写盘吃紧就调大两者。两个强制写点不受影响。

### 3. 禁用它（`disabled: true`）

投影系统退化成 live-only（水位缓存），冷读只能回落到 carrier 各自实现的全量日志加载（`README.md:48`）。

## 坑与边界

来自 `README.md:58`–`62`：

- **没有淘汰或保留策略**：记录按会话累积，清理属于带外运维，和会话持久化本身同一立场。
- **间隔节流是每会话的粗粒度**：定时器在一次干净写之后的第一条脏事件时装上，稳定的低于阈值的涓流是"每个间隔写一次"，不是滑动窗口。
- **`coldSnapshot` 不去重**：同一会话的两个并发冷读各跑一遍梯子，最后写回者胜（行等价），在列表级调用频率下可接受。

读源码补充：定时器随插件卸载一起清理，因为它们的会话可能比缓存活得久（`src/index.ts:233`–`238`）。
