# 流量扛不住了怎么办：从「为什么调大队列没用」到六种真实做法

一套写给「会写接口但没扛过高并发」的人的教程。

每一篇的结构都一样：

**先跑一个能看到数字的 demo → 再拆几个高星开源项目的源码 → 最后给你能抄的 Python / Go / TS 写法。**

---

## 怎么读

**按顺序读。**

第 00 篇是地基。不理解「队列不会创造产能」这件事，后面六篇你只能当配置手册抄——遇到没见过的场景就不会推了。

每篇开头都有一行 `python3 demos/xxx.py`。**先跑再读**，数字比文字有说服力。

跑之前不用准备任何东西：

| 项 | 要求 |
|---|---|
| Python | 3.8+ |
| 第三方依赖 | 无，demo 全部只用标准库 |
| 每篇的入口 | 文章开头那行 `python3 demos/xxx.py` |

---

## 目录

| 篇 | 场景 | 招式 | 一句话 |
|---|---|---|---|
| [00 · 接口超时，把队列调大，反而 OOM](00-接口超时把队列调大反而OOM-队列不会创造产能.md) | — | 排队论 | 队列不会创造产能，它只借时间 |
| [01 · 快速失败与丢弃](01-秒杀抢票热点查询-快速失败与丢弃.md) | 秒杀、抢票、热点查询 | 快速失败 + 丢弃 | 拒绝一个人，比让一百个人一起等，服务的人更多 |
| [02 · 立即 ACK 与有界队列](02-第三方webhook回调-立即ACK与有界队列.md) | 第三方 webhook 回调 | 立即 ACK + 有界队列 | HTTP handler 是前台，不是后厨 |
| [03 · 丢弃与采样](03-IoT设备上报行情推送-丢弃与采样.md) | IoT 上报、行情推送 | 丢弃 + 采样 | 同一个东西，在任何地方都要得出同一个答案 |
| [04 · 丢旧留新](04-监控指标埋点弹幕-丢旧留新.md) | 监控指标、埋点、弹幕 | 丢旧留新 | 队列不该是缓冲区，该是取景框 |
| [05 · 扩容及其极限](05-稳定超载的系统-扩容以及它救不了的情况.md) | 稳定超载的系统 | 扩容 | 先掐回路，再丢负载，最后扩容 |
| [06 · 时间轮与延迟消息](06-1000万订单超时未付自动关单-时间轮与延迟消息.md) | 1000 万订单超时未付自动关单 | 时间轮 + 延迟消息 | 别去找到期的任务，让它自己走到你面前 |
| [07 · 总结与决策清单](07-告警响了先扩容还是先限流-全系列总结与决策清单.md) | 告警响了，先扩容还是先限流 | 一个公式 + 三个问题 + 六条军规 | 先掐回路，看有效产出，最后扩容 |

---

## demo 一览

| 文件 | 跑多久 | 你会看到 |
|---|---|---|
| `demos/demo00_queue.py` | ~6s | 客流涨 10%，等待时间涨 8 倍 |
| `demos/demo01_failfast.py` | ~7s | 拒绝 2414 个请求，成功数反而**翻倍** |
| `demos/demo02_webhook.py` | ~25s | 同步处理 webhook，600 条推送里 585 条永久丢失 |
| `demos/demo03_sampling.py` | ~2s | 同样的存储成本，有用的链路差 494 倍 |
| `demos/demo04_conflate.py` | ~6s | 数据陈旧度从 912ms 掉到 11ms |
| `demos/demo05_metastable.py` | ~1s | 尖峰只有 10 秒，2 分钟后系统还是坏的 |
| `demos/timingwheel.html` | 浏览器打开 | 分层时间轮动画：延迟 140s 的任务从第三层一层层降级到执行 |

一次跑完：

```bash
cd demos
for f in demo*.py; do echo "=== $f ==="; python3 "$f"; done
```

---

## 这套教程覆盖的开源项目

| 项目 | Stars | 用来讲什么 |
|---|---|---|
| [alibaba/Sentinel](https://github.com/alibaba/Sentinel) | 23.1k | BBR 自适应限流：用利特尔法则实时估算容量 |
| [Netflix/concurrency-limits](https://github.com/Netflix/concurrency-limits) | 3.6k | 用 RTT 梯度自动调并发上限（TCP Vegas 搬到 RPC 层） |
| [envoyproxy/envoy](https://github.com/envoyproxy/envoy) | 28.3k | adaptive concurrency filter + circuit breaker |
| [go-kratos/aegis](https://github.com/go-kratos/aegis) | 239 | Go 版 BBR，带丢弃滞回 |
| [getsentry/sentry](https://github.com/getsentry/sentry) | 44.1k | webhook 落库 + 202，每一层都有上限 |
| [getsentry/sentry-python](https://github.com/getsentry/sentry-python) | 2.2k | 有界队列 + 满则丢的最小实现 |
| [celery/celery](https://github.com/celery/celery) | 28.5k | 默认配置为什么是无界的 |
| [OpenTelemetry collector-contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) | 4.7k | 一致性哈希采样 / tail sampling |
| [jaegertracing/jaeger](https://github.com/jaegertracing/jaeger) | 22.9k | 自适应采样：涨得慢、跌得快 |
| [emqx/emqx](https://github.com/emqx/emqx) | 16.4k | MQTT 队列满了丢最老的 |
| [nats-io/nats-server](https://github.com/nats-io/nats-server) | 20.0k | 75% 水位背压 → 100% 断连的两段式 |
| [redis/redis](https://github.com/redis/redis) | 74.9k | `client-output-buffer-limit` 的 hard / soft / seconds |
| [zeromq/libzmq](https://github.com/zeromq/libzmq) | 10.9k | `ZMQ_CONFLATE`：只留最后一条 |
| [prometheus/prometheus](https://github.com/prometheus/prometheus) | 64.1k | 告警队列砍队头 + 信号合并 |
| [kubernetes/client-go](https://github.com/kubernetes/client-go) | 9.8k | workqueue：不丢数据只丢通知 |
| [Terry-Mao/goim](https://github.com/Terry-Mao/goim) | 7.4k | 长连接推送：满了就丢 |
| [centrifugal/centrifugo](https://github.com/centrifugal/centrifugo) | 10.3k | `force_recovery_mode: cache`：重连只补最新一条 |
| [kedacore/keda](https://github.com/kedacore/keda) | 10.3k | 按队列长度扩容，把 ρ 直接当信号 |
| [knative/serving](https://github.com/knative/serving) | 6.1k | 用并发数当扩容指标 |

Stars 核实于 2026-08-04。

---

## 最后

如果你只记住三句话：

```
队列不会创造产能，它只借时间。
背压不会消灭排队，它只换地方。
重试不会提高成功率，它只放大流量。
```

真到出事的时候，动作是有顺序的：

```
on 告警响了:
    掐正反馈()      // 第一步，不是扩容
    丢负载()        // 第二步
    扩容()          // 最后一步
```

**先掐正反馈 → 再丢负载 → 最后扩容。**
