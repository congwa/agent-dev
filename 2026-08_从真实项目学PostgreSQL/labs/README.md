# 实验脚本

文档里出现的每一个数字都来自这里的脚本，在 **PostgreSQL 16.13** 上实际跑出来的。

没有一个数字是抄来的，也没有一个是估的——想不信任哪条结论，就去跑对应的那个脚本。

## 准备

```bash
# 起一个实验库
docker run -d --name pglab -e POSTGRES_PASSWORD=pg -p 5433:5432 postgres:16

# Python 脚本需要 psycopg3
pip install "psycopg[binary]"

# 连接串（所有 .py 脚本都读这个环境变量）
export PG_DSN="host=localhost port=5433 user=postgres password=pg dbname=postgres"

# psql 脚本用标准 PG* 变量
export PGHOST=localhost PGPORT=5433 PGUSER=postgres PGPASSWORD=pg PGDATABASE=postgres
```

⚠️ **实验会 DROP/CREATE 表，请务必用一个专用的空库，不要连生产。**

## 脚本清单

一共 28 个脚本，按 exp 编号排列，加粗的四行是重点：`exp2` 是第 3 篇的核心，`exp30`／`exp31`／`exp32` 是第 5 篇的机制三件套。其余的按需取用，从哪一篇过来就跑哪一篇的。

| 脚本 | 对应章节 | 验证什么 |
|---|---|---|
| `exp1_lost_update.py` | 第 3 篇 | 丢失更新：读-改-写 vs FOR UPDATE vs 原子 UPDATE |
| `exp2_epq.py` | **第 3 篇（核心）** | EvalPlanQual：条件写在 WHERE 里 vs 写在应用层 |
| `exp3_mvcc.sql` | 第 1、2 篇 | xmin/xmax/ctid，物理行版本，膨胀 |
| `exp4_hot.sql` | 第 2 篇 | HOT 更新：给热更新列建索引的代价 |
| `exp5_queue_skiplocked.py` | 第 5、7 篇 | SKIP LOCKED vs FOR UPDATE vs 不加锁 |
| `exp6.sql` | 第 12 篇 | float vs numeric 存钱；numeric 精度不足的坑 |
| `exp7_writeskew.py` | 第 4 篇 | 写偏斜：RR 挡不住，SERIALIZABLE 能挡 |
| `exp8_vacuum.py` | 第 9 篇 | 长事务导致表膨胀翻倍 |
| `exp9_index.sql` | 第 8 篇 | 四种索引的执行计划对比（1000 倍差距） |
| `exp10_idem_barrier.py` | 第 4、6 篇 | 幂等：有/无唯一索引的并发结果 |
| `exp11_deadlock.py` | 第 5 篇 | 死锁：加锁顺序不一致 |
| `exp12_conn.py` | 第 1、10 篇 | 连接数打满、默认超时参数 |
| `exp13_ddl.py` | 第 8、11 篇 | CREATE INDEX vs CONCURRENTLY 的阻塞时长 |
| `exp14.py` | 第 5、9 篇 | idle in transaction 占着什么；ALTER TABLE 锁队列 |
| `exp15.py` | 第 5、9 篇 | 什么样的空闲事务拖住 VACUUM；count(\*)；advisory lock |
| `exp16_snapshot.py` | 第 2 篇 | 快照：RC vs RR |
| `exp17_perf.py` | 第 3 篇 | 三种并发写法的吞吐对比 |
| `exp18_anomaly.py` | 第 4 篇 | 各隔离级别的读异常；SSI 冲突率随并发上升 |
| `exp19_locks.py` | 第 5 篇 | 行锁冲突矩阵；外键的 FOR KEY SHARE；表锁级别 |
| `exp20_seqgap.py` | 第 6 篇 | 序列非事务导致的永久丢消息 |
| `exp21_queue_index.sql` | 第 7 篇 | 队列表：部分索引 48kB vs 全量索引 56MB |
| `exp22_index2.sql` | 第 8 篇 | 表达式索引、text_pattern_ops、pg_trgm、JSONB GIN |
| `exp23_bloat.sql` | 第 9 篇 | 膨胀、REINDEX、VACUUM FULL、TOAST |
| `exp24_conn.py` | 第 10 篇 | 建连接成本；连接数与吞吐的曲线 |
| `exp25_ddl2.py` | 第 11 篇 | 各种 ALTER 的耗时和锁级别 |
| `exp30_rowlock_storage.py` | **第 5 篇（机制）** | 行锁写在 `t_xmax`/`t_infomask` 上；MultiXact 成员；锁 100 万行 `pg_locks` 纹丝不动 |
| `exp31_locktable_capacity.sh` | **第 5 篇（机制）** | 锁表容量公式、`out of shared memory` 的真实触发点、fast path 的 16 个槽 |
| `exp32_wait_events.py` | **第 5 篇（机制）** | 等行锁 = 等 `Lock:transactionid` + `Lock:tuple`，以及队列顺位 |

## 跑法

```bash
python3 exp2_epq.py           # Python 脚本
psql -f exp9_index.sql        # SQL 脚本
```

## 说明

**别把时间数字当承诺。** 毫秒、秒这类数字在你的机器上一定和文档里不一样，**看的是数量级和相对关系，不是绝对值**。

**有几个脚本挺重。** `exp9`、`exp21`、`exp22`、`exp23`、`exp25` 会插入几百万行数据，需要几 GB 磁盘和 1~2 分钟。

**并发实验本来就飘。** `exp1`、`exp10`、`exp17` 的结果有随机性，多跑几次看趋势。`exp1` 的"丢失次数"每次都不一样——这不是脚本不稳，这本身就是"丢失更新"的特征。

**前置依赖：**

| 脚本 | 需要 |
|---|---|
| `exp3_mvcc.sql`、`exp30` | `pageinspect` 扩展 |
| `exp22` | `pg_trgm` 扩展 |
| `exp23` | `pgstattuple` 扩展 |
| `exp31_locktable_capacity.sh` | 本机装了 `initdb` / `pg_ctl` |

上面三个扩展，官方 docker 镜像都自带（`postgresql-contrib`），不用额外装。

`exp31_locktable_capacity.sh` 是个例外：它根本不连你的实验库，而是用 `initdb` 现起一个用完即扔的小集群（跑完自动删），所以它要的是本机的 `initdb` / `pg_ctl`，不是数据库里的扩展。

**版本上有一处不齐。** `exp30`、`exp31`、`exp32` 于 2026-08-05 在 PostgreSQL 16.6 上跑出第 5 篇里引用的那批输出，其余脚本的数字来自 16.13。
