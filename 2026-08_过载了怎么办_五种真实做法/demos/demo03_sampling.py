"""
demo03: IoT / 行情 / 链路追踪 —— 采样为什么必须「一致」，以及采样后怎么还原

第一部分：一条请求经过 4 个服务。每个服务都要决定「这条要不要记录」。
          随手写 random.random() < 0.1 会发生什么？
第二部分：埋点上报只上报 1%，后台怎么把真实量级算回来？

跑法：python3 demo03_sampling.py
"""
import random
import secrets

TRACES = 10000
random.seed(1)
SERVICES = 4            # 一条请求经过 4 个微服务
RATE = 0.10             # 想采 10%


# ---------- 第一部分：一致性采样 ----------

def naive_sample():
    """错误示范：每个服务自己掷骰子，谁也不知道别人掷出了什么"""
    return random.random() < RATE


def consistent_sample(trace_id):
    """
    正确做法：把 traceID 本身当随机数用。
    OpenTelemetry 的官方做法就是这个 —— 取 traceID 的后 8 字节当一个整数，
    小于门槛就留下。不掷骰子，所以每个服务算出来必然一样。
    """
    # traceID 是 16 字节。取后 8 字节（=低 64 位）当作一个大整数
    low64 = int.from_bytes(trace_id[8:], "big")
    threshold = int(RATE * (1 << 64))
    return low64 < threshold


print("=" * 62)
print("第一部分：同一条链路，4 个服务各自决定采不采")
print("=" * 62)

for name, decide in [("每个服务自己掷骰子", "naive"), ("按 traceID 一致性判定", "consistent")]:
    full, partial, dropped = 0, 0, 0
    total_spans = 0
    for i in range(TRACES):
        tid = secrets.token_bytes(16)          # 128 位的 traceID，和真实系统一样
        if decide == "naive":
            votes = [naive_sample() for _ in range(SERVICES)]
        else:
            votes = [consistent_sample(tid) for _ in range(SERVICES)]
        kept = sum(votes)
        total_spans += kept
        if kept == SERVICES:
            full += 1
        elif kept == 0:
            dropped += 1
        else:
            partial += 1

    print(f"\n【{name}】共 {TRACES} 条链路")
    print(f"  完整保留（4 段全在）: {full:>6}  ← 只有这些能拿来排查问题")
    print(f"  残缺（断成几截）    : {partial:>6}  ← 存了但没用，还占存储")
    print(f"  完全丢弃            : {dropped:>6}")
    print(f"  实际存下来的 span 数: {total_spans:>6}  (两种方案花的钱其实差不多)")

print("""
结论：两种方案存储成本几乎一样，但「有用的链路」差了几百倍。
      掷骰子的方案里，一条链路要 4 个服务同时中奖才完整 —— 概率是 0.1^4 = 万分之一。
      一致性方案里，要么 4 段全留，要么全丢 —— 完整率就是 10%。
""")


# ---------- 第二部分：采样后的还原 ----------

print("=" * 62)
print("第二部分：埋点只上报 1%，后台怎么算回真实量级")
print("=" * 62)

random.seed(7)
REAL_EVENTS = 1_000_000
SAMPLE_RATE = 0.01

reported = 0
durations = []
real_durations = []
for _ in range(REAL_EVENTS):
    d = random.lognormvariate(3, 1)            # 假装是接口耗时（毫秒）
    real_durations.append(d)
    if random.random() < SAMPLE_RATE:          # 客户端按 1% 上报
        reported += 1
        durations.append(d)

real_durations.sort()
durations.sort()

print(f"\n真实发生的事件数        : {REAL_EVENTS:,}")
print(f"客户端实际上报的条数    : {reported:,}   ← 网络流量省了 99%")
print(f"服务端直接汇报（错误）  : {reported:,}   ← 监控大盘上 QPS 直接掉到 1/100，值班同学连夜排查")
print(f"服务端 ÷ 采样率（正确）  : {int(reported / SAMPLE_RATE):,}   ← 误差 "
      f"{abs(reported/SAMPLE_RATE - REAL_EVENTS)/REAL_EVENTS*100:.2f}%")

print(f"\n真实 P99 耗时           : {real_durations[int(len(real_durations)*0.99)]:.1f} ms")
print(f"采样后算出的 P99        : {durations[int(len(durations)*0.99)]:.1f} ms   ← 不用还原，直接就是对的")

print("""
读法：
  「数量」类指标（QPS、错误数、总请求数）必须除以采样率还原，否则量级全错。
    statsd 的线格式 `gorets:1|c|@0.1` 里的 @0.1 就是干这个的，
    服务端收到后会做 counters[key] += value * (1 / 0.1)。

  「分布」类指标（P50/P99 延迟、平均值）不用还原。
    抽 1% 的样本算出的分位数，和全量算出来的几乎一样 ——
    因为抽样不改变分布的形状，只改变样本数量。
    你要是给 P99 也乘 100，那就荒唐了。

  同理，gauge（当前 CPU 使用率 87%）也不能乘 —— 乘完变成 8700% 你自己看着办。
""")
