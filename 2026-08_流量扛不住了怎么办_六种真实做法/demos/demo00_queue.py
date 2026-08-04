"""
demo00: 亲眼看见「队列不会创造产能」

场景：一个奶茶店，1 个店员，做一杯平均 1 秒。
      我们让客人以不同的速度进店，看看队伍和等待时间怎么变。

不需要装任何东西，直接 python3 demo00_queue.py
"""
import random
import heapq

SERVICE_TIME = 1.0          # 店员做一杯平均要 1 秒 → 产能 μ = 1 杯/秒
SIM_SECONDS = 300000         # 模拟 30 万秒，够长才能让高负载收敛


def simulate(arrival_rate):
    """arrival_rate = λ，每秒来几个客人。返回 (平均排队人数 L_q, 平均总耗时 W)"""
    random.seed(42)                     # 固定随机种子，你跑出来的数字和我一样

    clock = 0.0
    queue = []                          # 排队的人，存他们的到店时间
    busy_until = 0.0                    # 店员忙到什么时候
    waits = []                          # 每个人的总耗时（排队 + 制作）
    area = 0.0                          # 用来算「平均队伍长度」的积分面积
    last_t = 0.0
    events = []                         # 事件堆：(时间, 类型)

    # 生成所有客人的到店时间
    t = 0.0
    while t < SIM_SECONDS:
        t += random.expovariate(arrival_rate)
        heapq.heappush(events, (t, "arrive"))

    while events:
        clock, kind = heapq.heappop(events)
        if clock > SIM_SECONDS:
            break
        # 累计「队伍长度 × 时间」，最后除以总时间就是平均队伍长度
        area += len(queue) * (clock - last_t)
        last_t = clock

        if kind == "arrive":
            queue.append(clock)
        # 店员空了就叫下一位
        while queue and busy_until <= clock:
            arrived = queue.pop(0)
            start = max(arrived, busy_until, clock)
            dur = random.expovariate(1 / SERVICE_TIME)
            busy_until = start + dur
            waits.append(busy_until - arrived)
            heapq.heappush(events, (busy_until, "done"))

    if not waits:
        return 0, 0
    return area / SIM_SECONDS, sum(waits) / len(waits)


print(f"店员产能 μ = {1/SERVICE_TIME:.0f} 杯/秒\n")
print(f"{'客流 λ':>8} {'利用率 ρ':>10} {'队伍人数 L_q':>12} {'总耗时 W':>12} {'理论 1/(μ-λ)':>14}")
print("-" * 62)
for lam in [0.5, 0.8, 0.9, 0.95, 0.99]:
    L, W = simulate(lam)
    theory = 1 / (1 / SERVICE_TIME - lam)
    print(f"{lam:>8.2f} {lam:>10.2f} {L:>12.1f} {W:>11.1f}s {theory:>13.1f}s")

print("""
读法：
  客流从 0.9 涨到 0.99，只多了 10%，等待时间却从 ~10 秒涨到 ~100 秒。
  这就是 1/(1-ρ) 这个式子的威力 —— 它在 ρ=1 处是一个「极点」，直接飞到无穷。

  如果 λ > μ（客人来得比做得快），这个模拟根本不会收敛：
  队伍每秒净增 (λ-μ) 个人，永远不会停。
  这时候你加长护栏（扩大队列）没有任何用，加人（扩容）才有用。
""")
