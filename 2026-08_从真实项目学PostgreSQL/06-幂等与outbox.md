# 第 6 篇 · 幂等与 outbox：重试不该扣两次钱

> 前面解决的是"并发下算得对"。这一篇解决"**同一个操作被投递多次时，只生效一次**"，以及"**改数据库和发消息怎么保持一致**"。源码坐标收在文末脚注，可照抄的完整代码收在文末附录。

---

## 一、重复投递是必然，不是意外

一个 API 网关的计费链路上，同一次调用可能被重复处理的原因有一大把：

- 客户端 SDK 自动重试（超时、5xx、连接重置）
- 你的网关有重试逻辑
- 消息队列的 at-least-once 语义
- 上游返回慢，你的 HTTP 客户端超时了但请求其实成功了
- 用户狂点提交按钮
- 发布时的滚动重启，处理到一半的请求被重新分配

这六条里没有一条是可以靠"写得更小心"消灭的。

**你无法消灭重复投递，只能让重复投递无害。** 这就是幂等。

---

## 二、sub2api 的幂等实现

整篇的骨架先摆出来：一张只管"这次请求算没算过账"的窄表，一个唯一索引，抢到键才干活，键和所有副作用在同一个事务里提交。

先看表结构：这张幂等表只有 5 个列——自增主键 `id`、`request_id`、`api_key_id`、`request_fingerprint`、`created_at`——外加一个覆盖 `(request_id, api_key_id)` 组合的唯一索引[^1]。完整定义照抄附录 A。

再看用法：`Apply()` 拿到一次计费命令后，先在一个事务里抢占幂等键；抢不到，说明这次请求已经算过账了，直接返回；抢到了，才真正执行所有计费副作用——扣余额、累加订阅用量、累加 API Key 配额、累加限流计数……最后把幂等键和所有副作用在同一个事务里提交[^2]。完整实现照抄附录 B。

抢占逻辑用的是一条 `INSERT ... ON CONFLICT (request_id, api_key_id) DO NOTHING RETURNING id`：插进去成功就是抢到了；插不进去（`ON CONFLICT` 命中）就说明已经有一条同 key 的记录，这时候还要多查一步——比对已存的 `request_fingerprint` 和这次的是否一致，不一致就报冲突，一致就是正常重放，静默跳过[^2]。

两段逻辑合起来只有三条出口：

1. 抢到键 → 执行全部副作用（扣钱、加配额、记流水、写 outbox）→ COMMIT。这是真的算了一次账。
2. 抢不到键，且旧指纹和本次指纹不同 → 报 `ErrUsageBillingRequestConflict`。这是同 ID 不同内容的撞车或攻击。
3. 抢不到键，但指纹相同 → 静默返回"未生效"。这是正常重放。

一句话：**抢到键的人才有资格花钱，抢不到的人只需要判断"你和之前那位是不是同一个人"**[^2]。

把抢占键、比对指纹、执行副作用这几步画成一张图：

```mermaid
flowchart TD
    A["<b>请求进来</b><br/>带 request_id 与内容指纹"]
    B["<b>INSERT 幂等键</b><br/>ON CONFLICT DO NOTHING"]
    C["<b>抢占成功</b><br/>RETURNING 出新 id"]
    D["<b>已存在记录</b><br/>说明是重放"]
    E["<b>比对 fingerprint</b><br/>查已存的指纹"]
    F["<b>指纹相同</b><br/>静默跳过"]
    G["<b>指纹不同</b><br/>返回冲突错误"]
    H["<b>执行业务副作用</b><br/>扣钱/加配额/记流水/写outbox"]
    I["<b>同事务 COMMIT</b><br/>原子提交"]

    A --> B
    B -- "抢占成功" --> C
    B -- "已存在" --> D
    C --> H
    H --> I
    D --> E
    E -- "同请求重放" --> F
    E -- "撞车或攻击" --> G

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class A entry
    class B,C,H main
    class I data
    class D,E note
    class F data
    class G danger
```

这段代码有 4 个设计决策值得逐一拆解。

---

### 决策 1：用唯一索引，不用"先查后插"

**这是唯一可靠的做法。** 第 4 篇已经用实测证明过[^3]：

```
[B1] dedup 表上有唯一索引
   余额 990（应为 990）  被数据库挡下的事务 7 个   ✅ 只扣了一次

[B2] 没有唯一索引，只靠应用代码里的 SELECT 判断
   余额 920（应为 990）  幂等表行数 8              ❌ 重复扣款 8 次
```

画成对比图，一眼就能看出两条路径的分野：

```mermaid
flowchart LR
    subgraph B1["唯一索引方案"]
        B1a["8个并发事务<br/>INSERT ON CONFLICT"]
        B1b["数据库物理层拦截<br/>7个被挡下"]
        B1c["余额990<br/>只扣一次"]
        B1a --> B1b --> B1c
    end

    subgraph B2["先查后插方案"]
        B2a["8个并发事务<br/>先SELECT查重"]
        B2b["未提交的INSERT互相不可见<br/>8个都判定没记录"]
        B2c["余额920<br/>重复扣款8次"]
        B2a --> B2b --> B2c
    end

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class B1a,B2a entry
    class B1b,B2b note
    class B1c data
    class B2c danger
```

**为什么"先 SELECT 查重再 INSERT"必然漏？**

因为在 READ COMMITTED 下，一个还未提交的 INSERT 对别的事务**不可见**。8 个并发事务的 SELECT 全都看到"没有记录"，于是 8 个全都往下走。

**只有唯一索引能拦住它** —— 因为唯一索引的检查不走快照，它检查的是"物理上有没有一个未被判定为死的索引项"，包括其他事务未提交的插入（此时会阻塞等待对方结束，再决定报错还是放行）。

> **`ON CONFLICT DO NOTHING` 和捕获 duplicate key 异常，哪个更好？**
>
> 两者都对，但 `ON CONFLICT` 更好：捕获异常会让**整个事务进入 aborted 状态**，后续语句全部报 `current transaction is aborted`，你必须用 SAVEPOINT 才能继续。而 `ON CONFLICT` 不会中止事务。
>
> 在 sub2api 这种"幂等键和扣款在同一个事务里"的设计下，这个区别是决定性的。

---

### 决策 2：幂等键和副作用必须在同一个事务里

正确写法是把抢锁、扣钱、加配额、记流水绑进同一个事务：

```go
tx.Begin()
  INSERT INTO usage_billing_dedup ... ON CONFLICT DO NOTHING RETURNING id   -- 抢锁
  UPDATE users SET balance = balance - cost ...                             -- 扣钱
  UPDATE api_keys SET quota_used = quota_used + cost ...                    -- 加配额
  INSERT INTO usage_logs ...                                                -- 记流水
tx.Commit()
```

如果把幂等键单独提交会怎样？

```go
// 危险写法
db.Exec("INSERT INTO dedup ... ON CONFLICT DO NOTHING")   // 事务 1，独立提交
if 插入成功 {
    db.Exec("UPDATE users SET balance = balance - $1")     // 事务 2
}
```

拆开成两个事务，无论哪个在前，崩溃点都落在中间那道缝里：

| 拆分顺序 | 崩溃在中间时 | 后果 |
|---|---|---|
| 先写键、后扣钱 | 幂等键留下了，钱没扣 | 重试被幂等键挡住 → **永久漏账** |
| 先扣钱、后写键 | 钱扣了，键没写 | 重试再走一遍 → **重复扣款** |

把两种崩溃时机画出来，对比就很直观：

```mermaid
flowchart TD
    S["<b>分两个独立事务提交</b><br/>幂等键和扣款不在一起"]
    P1["<b>先写键后扣钱</b><br/>之间进程崩溃"]
    P2["<b>先扣钱后写键</b><br/>之间进程崩溃"]
    Bad1["<b>键已存在钱未扣</b><br/>永久漏账"]
    Bad2["<b>钱已扣键未写</b><br/>重复扣款"]
    Same["<b>同一个事务提交</b><br/>键与副作用绑在一起"]
    Good["<b>要么都成功要么都回滚</b><br/>没有中间态"]

    S --> P1
    S --> P2
    P1 --> Bad1
    P2 --> Bad2
    Same --> Good

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class S,Same entry
    class P1,P2 note
    class Bad1,Bad2 danger
    class Good data
```

只有放在**同一个事务**里，才有"要么全成功、要么全回滚"的保证。这也是 outbox 模式的核心思想（下面会讲）。

---

### 决策 3：加 fingerprint 防"同 ID 不同内容"

`request_id` 是客户端给的，客户端可能：

- 用了一个碰撞的 UUID 生成器；
- 复用了 request_id（比如把它当成会话 ID）；
- 恶意重放：拿一次 $0.001 的请求 ID，去顶掉一次 $10 的计费。

所以 sub2api 额外存了一个 `request_fingerprint`（请求内容的哈希）。

| 情况 | 判定 | 行为 |
|---|---|---|
| 同 ID 同指纹 | 正常重放 | 静默跳过 |
| 同 ID 不同指纹 | 撞车或攻击 | 返回 `ErrUsageBillingRequestConflict`，让上层决定怎么处理 |

不做指纹校验会怎样？攻击者可以用一个已经计过费的 request_id 发起无限次高消耗请求，全部被"幂等"掉，平台白白承担上游成本——这是一个真实可利用的漏洞，不是理论风险。

---

### 决策 4：窄表 + BRIN + 归档，控制幂等表的膨胀

幂等表是纯追加写的，每个请求一行。一天几千万请求就是几千万行。

换句话说，这张"辅助表"很容易长成库里最大的那张。sub2api 用三层处理压住它。

**① 窄表**：迁移文件的注释写得很清楚——"将*是否已扣费*从 `usage_logs` 解耦出来"。幂等表只有 5 个列，行小、索引小、写入快。如果把幂等标记塞在宽大的 `usage_logs` 上，每次幂等检查都要触碰一张宽表[^1]。

**② BRIN 索引做时间范围清理**：`usage_billing_dedup` 是按时间追加写入的窄表，一条按 `created_at` 建的 BRIN 索引就能支撑按保留期做批量清理，而且用 `CONCURRENTLY` 建索引避免在热表上长时间阻塞写入[^4]。完整定义照抄附录 C。

**BRIN（Block Range INdex）**只记录"每 128 个数据页里 `created_at` 的最小值和最大值"。对于**物理顺序和列值顺序天然一致**的追加表（时间戳列就是典型），它极其高效。

实测索引大小对比（100 万行）[^5]：

```
  i_brin           24 kB      ← BRIN
  i_full           30 MB      ← 普通 B-tree
  usage_logs_pkey  21 MB
```

**24 KB vs 30 MB，小了 1000 倍以上。** 代价是它只能做粗粒度的范围过滤（"这批页里可能有符合条件的行"），不能做精确定位——但清理任务恰好只需要范围过滤。

**③ 归档表**：老数据挪到一张只留 `request_id`、`api_key_id`、`request_fingerprint`、`created_at`、`archived_at` 五列的冷归档表，主键是 `(request_id, api_key_id)`[^6]。完整定义照抄附录 D。

热表只留最近 N 天，老的挪到归档表。检查幂等时先查热表、再查归档表——**慢一点，但不丢历史去重能力**。

查询路径和清理路径画成一张图：

```mermaid
flowchart TD
    Req["<b>幂等检查请求</b><br/>进来一个 request_id"]
    Hot["<b>热表查询</b><br/>窄表 + BRIN 索引"]
    Cold["<b>归档表查询</b><br/>冷数据按主键查"]
    Done["<b>返回判定结果</b>"]
    Job["<b>定时清理任务</b><br/>按 BRIN 定位过期范围"]

    Req --> Hot
    Hot -- "命中" --> Done
    Hot -- "未命中" --> Cold
    Cold --> Done
    Job -- "扫描过期范围" --> Hot
    Job -- "老数据迁移" --> Cold

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class Req entry
    class Hot,Cold main
    class Done data
    class Job note
```

幂等键能不能设个 TTL 直接删掉？可以，但 TTL 必须显著大于"重试可能发生的最长时间"——设太短会撞上这样的场景：一条消息在死信队列里躺了 3 天后被人工重投，而幂等键 24 小时前就被清掉了，于是重复扣款。而且这类事故极难排查，因为它发生在"运维手工操作"之后，日志上下文早就断了。

---

## 三、Outbox 模式：数据库改了，消息也得发出去

### 问题

计费成功后要做几件事：清缓存、通知调度器、给用户发欠费提醒。分开各自提交是经典的错误写法：

```go
tx.Begin()
  UPDATE users SET balance = ...
tx.Commit()
redis.Del(cacheKey)        // 如果这里失败了呢？
mq.Publish(event)          // 如果这里失败了呢？
```

- Commit 成功但 `redis.Del` 失败 → **缓存里是旧余额，用户拿着过期的额度继续用**；
- 更糟：**把 `redis.Del` 放进事务里** → 事务持有行锁的时间被网络 I/O 拉长，热点行被锁成串行（回到第 2 篇讲的长事务问题）。

**这是分布式系统里的"双写问题"：两个存储系统，没有共同的事务。**

先看没有 outbox 时会发生什么：

```mermaid
sequenceDiagram
    participant App as 业务代码
    participant DB as 数据库
    participant Cache as Redis缓存

    App->>DB: UPDATE users 扣款
    DB-->>App: COMMIT 成功
    App->>Cache: 删除缓存
    Cache-->>App: 网络超时，删除失败
    Note over App,Cache: 事务已提交无法回滚，缓存清理没有兜底
    Note over Cache: 缓存里仍是旧余额，用户读到脏数据
```

再看加上 outbox 之后的样子：

```mermaid
sequenceDiagram
    participant App as 业务代码
    participant DB as 数据库
    participant Worker as 后台Worker

    App->>DB: 开启事务
    App->>DB: UPDATE users 扣款
    App->>DB: INSERT outbox 消息
    DB-->>App: COMMIT 原子提交
    Note over App,DB: 改库和写消息绑在同一个事务里

    Worker->>DB: 轮询领取待投递消息
    DB-->>Worker: 返回消息
    Worker->>Worker: 投递消息，清缓存/发通知
    Worker->>DB: 标记完成
    Note over Worker: 投递失败会退避重试，不影响已提交的业务事务
```

### 解法：把"要发的消息"也写进数据库

sub2api 的 `auth_cache_invalidation_outbox` 表只有几个关键列：自增主键、`cache_key`（限定成 64 位十六进制哈希）、`created_at`、`available_at`（支持延迟投递和退避重试）、`delivery_stage`（两态开关）、`attempts`、`last_error`，以及一对租约字段 `claimed_at`/`claimed_by`（记录被谁、什么时候领走）。索引只给"待领取"的行建——一个部分索引，已处理的行不占索引空间[^7]。完整定义照抄附录 E。

写入侧甚至做到了**触发器自动入队**——业务代码根本不用记得写 outbox：一个数据库函数把明文 key 算成 SHA-256 后插进 outbox 表[^7]。完整函数照抄附录 E。

（注意：只存 key 的 SHA-256，**明文凭证不出 `api_keys` 表**。安全设计顺手做进了 schema。）

于是流程变成：

```go
tx.Begin()
  UPDATE users SET balance = ...
  INSERT INTO auth_cache_invalidation_outbox(cache_key) VALUES (...)  -- 同一个事务
tx.Commit()                          // ← 原子的：要么都成功，要么都没发生

// 另一个后台 worker 独立地把 outbox 里的消息投递出去，失败就重试
```

画成一张流程图更直观：

```mermaid
flowchart TD
    Tx["<b>业务事务开始</b>"]
    U["<b>UPDATE 业务表</b><br/>扣款/改状态"]
    O["<b>INSERT outbox 消息</b><br/>同一个事务里"]
    Commit["<b>COMMIT</b><br/>原子提交"]
    Worker["<b>独立 worker 轮询</b>"]
    Claim["<b>FOR UPDATE SKIP LOCKED</b><br/>领取一批消息"]
    Deliver["<b>投递消息</b><br/>清缓存/发通知"]
    Mark["<b>标记完成</b>"]
    Retry["<b>退避重试</b><br/>租约过期可被重领"]

    Tx --> U --> O --> Commit
    Commit --> Worker --> Claim --> Deliver
    Deliver -- "成功" --> Mark
    Deliver -- "失败" --> Retry
    Retry --> Claim

    classDef main fill:#ede9fe,stroke:#a78bfa,color:#1f2937
    classDef data fill:#dcfce7,stroke:#86efac,color:#14532d
    classDef entry fill:#f3f4f6,stroke:#d1d5db,color:#374151
    classDef danger fill:#fee2e2,stroke:#fca5a5,color:#7f1d1d
    classDef note fill:#fef9c3,stroke:#fde047,color:#713f12
    class Tx entry
    class U,O,Worker,Claim,Deliver main
    class Commit,Mark data
    class Retry note
```

消费侧的核心是一条 CTE + UPDATE 组合的 SQL——用 `FOR UPDATE SKIP LOCKED` 挑出候选行，同一条语句里就把它们标记为已被领取，一次数据库往返完成"选 + 认领"两件事[^8]。完整语句照抄附录 F。

这条 SQL 里有 4 个设计点，第 7 篇会逐个拆解：`FOR UPDATE SKIP LOCKED`、租约超时重领、`ORDER BY id` 保序、CTE + UPDATE 一次往返完成"领取 + 标记"。

### outbox 保证的是什么？

**保证 at-least-once（至少一次），不保证 exactly-once。**

- 消息一定会被投递（数据库事务保证它被记下来了，worker 会一直重试）；
- 但可能被投递多次（worker 投递成功后、标记完成前崩溃）。

**所以消费端必须幂等。** 这就回到了本篇的前半部分——**幂等 + at-least-once = 事实上的 exactly-once**。这两个东西是一对，缺一个都不成立。

---

## 四、一个非常隐蔽的坑：序列号是非事务的

sub2api 的 outbox 清理代码里有一段注释，值得单独拎出来讲，这段注释来自清理任务的实现代码本身[^9]：

```go
// created_at < NOW() - INTERVAL '10 seconds' 防御 PG 序列号在事务内提前分配但
// 提交延迟的竞争：若某 Tx 在 watermark 推进前持有 id=N（未提交），watermark
// 跨过 N 后该 Tx 才提交，此时 row N 已经"低于 watermark"但从未被 poll；10s
// 宽限期让此类慢事务有机会提交后被消费，再被 cleanup 删除。
```

这段话在说一个**真实存在、极难复现、后果是永久丢消息**的 bug。

先把它写成伪代码看清楚——问题出在消费者用一个单调递增的 id 水位线记进度：

```
watermark = 0                       # 消费者的进度，只增不减

每轮轮询:
    rows = SELECT * FROM outbox WHERE id > watermark   # 只看得见已提交的行
    处理(rows)
    watermark = max(rows.id)        # ← 致命的一步：假设"小 id 一定先可见"
```

那个假设是错的。实测[^10]：

```
=== 序列号是非事务的：id 先分配，事务后提交 ===
  慢事务已经拿到 id=1，但还没提交
  快事务拿到 id=2，并且已经提交
  此刻消费者看到: [(2, '快事务的消息')]
  ❌ 消费者把水位线推进到 2，认为 <= 2 的都处理过了
  慢事务提交后表里: [(1, '慢事务的消息'), (2, '快事务的消息')]
  → id=1 这条消息【永远不会被消费】，因为水位线已经越过它了
```

把这个时间线画出来会更清楚：

```mermaid
sequenceDiagram
    participant Slow as 慢事务
    participant Fast as 快事务
    participant Consumer as 消费者水位线

    Slow->>Slow: INSERT 拿到 id等于1，未提交
    Fast->>Fast: INSERT 拿到 id等于2，已提交
    Consumer->>Consumer: 查询可见数据，只看到 id等于2
    Consumer->>Consumer: 水位线推进到2
    Slow->>Slow: 事务提交，id等于1 落盘
    Note over Consumer: 水位线已经越过 id等于1
    Note over Consumer: 这条消息永远不会被消费
```

**根因**：`bigserial` 背后是一个 sequence，而 **sequence 的取值不受事务控制**（它必须如此，否则并发插入就要互相排队）。所以：

- id 是**在 INSERT 执行时**分配的，不是在 COMMIT 时；
- 一个慢事务可能持有一个**小 id**，却在很多**大 id** 之后才提交；
- 任何"按 id 单调推进水位线"的消费者，都会跳过这条记录。

三种解法各有取舍：

| 解法 | 做法 | 取舍 |
|---|---|---|
| 加宽限期（sub2api 的做法） | 只清理 `created_at < NOW() - 10 秒` 的行，给慢事务留出提交窗口 | 简单有效，代价是清理有延迟 |
| 不用水位线，用状态字段 | `WHERE processed_at IS NULL`（配合部分索引），消息不会因为 id 顺序被跳过 | 多数场景推荐这个 |
| 用 `pg_current_snapshot()` 判断可见性边界 | Debezium 之类的 CDC 工具用的思路 | 复杂但精确 |

不处理会怎样？几万条消息里丢那么一两条。因为量极小，监控发现不了；因为是"慢事务 + 高并发"的巧合，测试环境复现不出来；等到有人发现"这个用户的缓存怎么一直是旧的"，已经是几个月后了。

### 附带的一个常识：序列不回滚

```
=== 序列不回滚：ROLLBACK 也会消耗序列号 ===
  回滚前序列 last_value=2，回滚后=3  → 序列号被消耗掉了，id 出现空洞
```

**推论**：

- `bigserial` 主键**一定有空洞**，不能当"订单总数"用；
- **不能拿它当需要连续的业务编号**（发票号、合同号），那些要单独用一张带行锁的计数表，或者接受空洞并在业务上说明；
- `MAX(id)` 不等于行数，`COUNT(*)` 才是。

---

## 五、幂等实现的选型

| 方案 | 适用 | 注意 |
|---|---|---|
| **唯一索引 + `ON CONFLICT DO NOTHING`** | 通用首选 | 幂等键必须和副作用同事务 |
| **唯一索引 + `ON CONFLICT DO UPDATE`（upsert）** | "重放要更新为最新状态" | 注意并发 upsert 仍可能死锁，要按序处理 |
| **业务状态机**（`WHERE state='pending'`） | 有明确状态流转的实体 | `UPDATE ... WHERE id=$1 AND state='pending'`，0 行 = 已处理 |
| **版本号 / 乐观锁**（`WHERE version=$1`） | 覆盖式更新 | 0 行 = 有人先改了，要重读重试 |
| **Redis SETNX** | 只做"防抖"，降低数据库压力 | **绝不能当唯一保障**——Redis 会丢数据、会 failover |

最后一条值得多说一句：见过太多"用 Redis 分布式锁保证不重复扣款"的设计。Redis 主从切换时未同步的写会丢，锁就跟着失效。**钱的幂等必须落在数据库的唯一约束上**，Redis 只能做前置的性能优化。

---

## 六、把这一篇串起来

- 抢不到幂等键就是重放——这是决策一里"唯一索引才拦得住并发"的直接后果，`SELECT` 查重必然漏，因为未提交的 INSERT 对其他事务不可见；
- 幂等键和副作用必须绑进同一个事务——决策二画出的两种拆分方式，无论哪种，崩溃点落在中间那道缝里都会留下漏账或重复扣款；
- fingerprint 不是可选项——决策三里"同 ID 不同内容"是能被利用的真实漏洞，不是理论假设；
- 幂等表要窄、要归档、用 BRIN——决策四的三层处理是因为这张"辅助表"天生会追着 `usage_logs` 长成库里最大的那张；
- outbox 把"改库"和"发消息"绑进同一个事务——这是在消灭双写问题，拆开提交必然有一条路径会漏；
- at-least-once 加幂等才等于事实上的 exactly-once——outbox 本身从没承诺过精确一次，承诺精确一次的是幂等自己；
- 别拿 `id` 做水位线——序列号在事务外分配，一个慢事务足以让水位线跳过一整条消息，这就是四、里那个隐蔽坑的根子。

一句话收尾：幂等的正确性只能建立在数据库的唯一约束上，其余一切——Redis 锁、应用层查重、消息去重——都只是性能优化，不是保障。

---

**下一篇** → [07 任务队列：SKIP LOCKED 与租约](./07-任务队列.md)

---

## 附录：可以照抄的模板

### A. 幂等键表结构

```sql
-- 窄表账务幂等键：将"是否已扣费"从 usage_logs 解耦出来
CREATE TABLE IF NOT EXISTS usage_billing_dedup (
    id                  BIGSERIAL PRIMARY KEY,
    request_id          VARCHAR(255) NOT NULL,
    api_key_id          BIGINT NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_billing_dedup_request_api_key
    ON usage_billing_dedup (request_id, api_key_id);
```

### B. 抢占幂等键 + 执行副作用

```go
func (r *usageBillingRepository) Apply(ctx context.Context, cmd *service.UsageBillingCommand) (...) {
	tx, err := r.db.BeginTx(ctx, nil)
	defer func() { if tx != nil { _ = tx.Rollback() } }()

	// ① 先抢占幂等键。抢不到 → 说明这次请求已经算过账了，直接返回
	applied, err := r.claimUsageBillingKey(ctx, tx, cmd)
	if !applied {
		return &service.UsageBillingApplyResult{Applied: false}, nil
	}

	// ② 抢到了，才真正执行所有计费副作用
	//    扣余额、累加订阅用量、累加 API Key 配额、累加限流计数……
	if err := r.applyUsageBillingEffects(ctx, tx, cmd, result); err != nil {
		return nil, err
	}

	// ③ 幂等键和所有副作用【在同一个事务里】提交
	if err := tx.Commit(); err != nil { return nil, err }
	tx = nil
	return result, nil
}
```

```go
err := tx.QueryRowContext(ctx, `
	INSERT INTO usage_billing_dedup (request_id, api_key_id, request_fingerprint)
	VALUES ($1, $2, $3)
	ON CONFLICT (request_id, api_key_id) DO NOTHING
	RETURNING id
`, requestID, apiKeyID, requestFingerprint).Scan(&id)

if errors.Is(err, sql.ErrNoRows) {
	// 已经存在 → 这次是重放
	// 但还要检查：是不是【同一个请求】的重放，还是 request_id 撞车了？
	var existingFingerprint string
	tx.QueryRowContext(ctx, `SELECT request_fingerprint FROM usage_billing_dedup
	                         WHERE request_id=$1 AND api_key_id=$2`,
	                   requestID, apiKeyID).Scan(&existingFingerprint)
	if existingFingerprint != requestFingerprint {
		return false, service.ErrUsageBillingRequestConflict   // 同 ID 不同内容 → 报冲突
	}
	return false, nil                                          // 正常重放 → 静默跳过
}
```

### C. BRIN 索引做时间范围清理

```sql
-- usage_billing_dedup 是按时间追加写入的幂等窄表。
-- 使用 BRIN 支撑按 created_at 的批量保留期清理，尽量降低写放大。
-- 使用 CONCURRENTLY 避免在热表上长时间阻塞写入。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_billing_dedup_created_at_brin
    ON usage_billing_dedup USING BRIN (created_at);
```

### D. 冷归档表

```sql
-- 冷归档旧账务幂等键，缩小热表索引与清理范围，同时不丢失长期去重能力。
CREATE TABLE IF NOT EXISTS usage_billing_dedup_archive (
    request_id VARCHAR(255) NOT NULL,
    api_key_id BIGINT NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (request_id, api_key_id)
);
```

### E. outbox 表结构与自动入队触发器

```sql
CREATE TABLE auth_cache_invalidation_outbox (
    id             BIGSERIAL PRIMARY KEY,
    cache_key      CHAR(64) NOT NULL CHECK (cache_key ~ '^[0-9a-f]{64}$'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    available_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- 延迟投递 / 退避重试
    delivery_stage SMALLINT NOT NULL DEFAULT 0 CHECK (delivery_stage IN (0,1)),
    attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error     TEXT,
    claimed_at     TIMESTAMPTZ,                          -- 租约：什么时候被领走的
    claimed_by     TEXT                                  -- 租约：被谁领走的
);

-- 只给"待领取"的行建索引 —— 部分索引，已处理的行不占索引空间
CREATE INDEX idx_auth_cache_invalidation_outbox_available
    ON auth_cache_invalidation_outbox (available_at, id) WHERE claimed_at IS NULL;
CREATE INDEX idx_auth_cache_invalidation_outbox_lease
    ON auth_cache_invalidation_outbox (claimed_at) WHERE claimed_at IS NOT NULL;
```

```sql
CREATE OR REPLACE FUNCTION enqueue_auth_cache_invalidation(raw_key TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF raw_key IS NULL OR raw_key = '' THEN RETURN; END IF;
    INSERT INTO auth_cache_invalidation_outbox (cache_key)
    VALUES (encode(sha256(convert_to(raw_key, 'UTF8')), 'hex'));
END; $$;
```

### F. 消费侧：领取待投递消息

```sql
WITH candidates AS (
    SELECT id FROM auth_cache_invalidation_outbox
    WHERE available_at <= NOW()
      AND (claimed_at IS NULL OR claimed_at < NOW() - ($3 * INTERVAL '1 second'))  -- 租约过期可重领
    ORDER BY id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
)
UPDATE auth_cache_invalidation_outbox AS o
SET claimed_at = NOW(), claimed_by = $1
FROM candidates AS c
WHERE o.id = c.id
RETURNING o.id, o.cache_key, o.attempts, o.delivery_stage, o.created_at
```

---

## 出处

[^1]: 幂等键表结构：`backend/migrations/071_add_usage_billing_dedup.sql`。
[^2]: 抢占幂等键与执行副作用的实现：`backend/internal/repository/usage_billing_repo.go`。
[^3]: 唯一索引 vs 先查后插的对比实测脚本：`labs/exp10c.py`（第 4 篇）。
[^4]: BRIN 索引迁移：`072_add_usage_billing_dedup_created_at_brin_notx.sql`。
[^5]: 索引大小对比实测脚本：`labs/exp9_index.sql`。
[^6]: 冷归档表定义：`073_add_usage_billing_dedup_archive.sql`。
[^7]: outbox 表结构与自动入队触发器：`migrations/184_auth_cache_invalidation_outbox.sql`。
[^8]: 消费侧领取查询的实现：`backend/internal/repository/auth_cache_invalidation_outbox_repo.go`。
[^9]: outbox 清理任务的宽限期注释：`scheduler_outbox_repo.go`。
[^10]: 序列号非事务性的实测脚本：`labs/exp20_seqgap.py`。
