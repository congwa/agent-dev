"""
demo05: 为什么「稳定超载只能扩容」，以及为什么有时候扩容也来不及

第一部分：用利特尔法则反推「队列最多能设多长」「要几个副本」—— 一个小计算器
第二部分：元稳定失效模拟 —— 尖峰只有 10 秒，系统 2 分钟后还是坏的

跑法：python3 demo05_metastable.py
"""

# ========== 第一部分：队列上限和副本数怎么算 ==========

print("=" * 70)
print("第一部分：别拍脑袋设队列长度，用利特尔法则算")
print("=" * 70)


def plan(slo_ms, work_ms, concurrency, peak_qps):
    capacity = concurrency / (work_ms / 1000)          # 单实例产能 = 并发数 / 单请求耗时
    max_queue = int((slo_ms - work_ms) / 1000 * capacity)   # 排队预算 × 产能
    replicas = -(-peak_qps // int(capacity))           # 向上取整
    print(f"\n  单请求耗时 {work_ms}ms，单实例并发 {concurrency}，SLO {slo_ms}ms，峰值 {peak_qps} QPS")
    print(f"  → 单实例产能 = {concurrency} ÷ {work_ms/1000}s = {capacity:.0f} QPS")
    print(f"  → 队列上限   = ({slo_ms}-{work_ms})ms × {capacity:.0f} QPS = {max_queue} 个")
    print(f"  → 需要实例数 = {peak_qps} ÷ {capacity:.0f} = {replicas} 个")


plan(slo_ms=500, work_ms=50, concurrency=32, peak_qps=5000)
plan(slo_ms=200, work_ms=20, concurrency=16, peak_qps=3000)

print("""
  队列设成 10000 会怎样？排满时一个请求要等 10000÷640 ≈ 15.6 秒。
  你没有多服务一个人，只是把「立刻被拒绝」变成了「等 15 秒再失败」。

  验算 Google SRE 书里的例子：
  「队列长度 = 线程数的 10 倍，单请求 100ms，排满时一个请求要 1.1 秒」
    线程数 T → 产能 10T QPS，队列 10T 个 → 排队 10T÷10T = 1.0s，加干活 0.1s = 1.1s ✓
""")


# ========== 第二部分：元稳定失效 ==========

print("=" * 70)
print("第二部分：尖峰只持续 10 秒，为什么系统 2 分钟后还是坏的")
print("=" * 70)

CAPACITY = 100.0                    # 服务器每秒能处理 100 个
BASE_LOAD = 80.0                    # 日常流量 80 QPS（利用率 80%，健康）
SPIKE_LOAD = 300.0                  # 尖峰 300 QPS
SPIKE_FROM, SPIKE_TO = 20.0, 30.0   # 只持续 10 秒
TIMEOUT = 2.0                       # 客户端 2 秒不返回就放弃
MAX_ATTEMPTS = 3
DT = 0.1
TOTAL = 120.0


def simulate(retry_budget=None, queue_limit=None):
    """
    retry_budget : None = 无限重试；0.1 = 重试量不得超过成功量的 10%
    queue_limit  : None = 无界队列；整数 = 队列满了就立刻拒绝（快速失败）
    """
    queue = []              # 每项 = [进队时刻, 尝试次数, 是否已被处理]
    timeouts = []           # 每项 = (超时时刻, 请求引用)
    t, carry = 0.0, 0.0
    ok_ema, retry_ema = 1.0, 0.0
    timeline = []

    def submit(born, attempts):
        req = [born, attempts, False]
        if queue_limit is not None and len(queue) >= queue_limit:
            return None                     # 快速失败：连队都不让排
        queue.append(req)
        timeouts.append((born + TIMEOUT, req))
        return req

    while t < TOTAL:
        lam = SPIKE_LOAD if SPIKE_FROM <= t < SPIKE_TO else BASE_LOAD
        carry += lam * DT
        n_new = int(carry)
        carry -= n_new
        offered = 0
        for _ in range(n_new):
            submit(t, 1)
            offered += 1

        # 服务器干活：先进先出，它并不知道客户端是不是已经走了
        goodput = wasted = 0
        for _ in range(int(CAPACITY * DT)):
            if not queue:
                break
            born, attempts, _done = queue.pop(0)
            if t - born < TIMEOUT:
                goodput += 1               # 客户端还在等，这次是有效产出
            else:
                wasted += 1                # 客户端早走了，这份 CPU 白烧
            # 标记为已处理，避免它再触发超时重试
            for i, (_dl, r) in enumerate(timeouts):
                if r[0] == born and r[1] == attempts and not r[2]:
                    r[2] = True
                    break

        # 客户端侧：到点没收到响应就重试
        still = []
        for deadline, req in timeouts:
            if deadline > t:
                still.append((deadline, req))
                continue
            if req[2]:
                continue                    # 已经处理过了
            if req[1] >= MAX_ATTEMPTS:
                continue                    # 重试次数用完，放弃
            allowed = retry_budget is None or retry_ema < ok_ema * retry_budget
            if allowed:
                retry_ema += 1
                submit(t, req[1] + 1)
                offered += 1
        timeouts = still

        ok_ema = ok_ema * 0.99 + goodput
        retry_ema *= 0.99
        timeline.append((t, offered / DT, goodput / DT, wasted / DT, len(queue)))
        t += DT
    return timeline


def report(name, timeline):
    def avg(t0, t1, idx):
        v = [r[idx] for r in timeline if t0 <= r[0] < t1]
        return sum(v) / len(v) if v else 0

    print(f"\n【{name}】")
    print(f"  {'时间段':<20}{'打到服务的QPS':>14}{'有效产出QPS':>13}{'白烧QPS':>10}{'积压':>8}")
    for label, a, b in [("尖峰前   0-20s", 0, 20),
                        ("尖峰中  20-30s", 20, 30),
                        ("尖峰后  30-40s", 30, 40),
                        ("1分钟后 60-80s", 60, 80),
                        ("2分钟后100-120s", 100, 120)]:
        print(f"  {label:<20}{avg(a,b,1):>14.0f}{avg(a,b,2):>13.0f}"
              f"{avg(a,b,3):>10.0f}{avg(a,b,4):>8.0f}")


print(f"\n产能 {CAPACITY:.0f} QPS，日常 {BASE_LOAD:.0f} QPS。"
      f"第 {SPIKE_FROM:.0f}~{SPIKE_TO:.0f} 秒有个 {SPIKE_LOAD:.0f} QPS 的尖峰，之后立刻回到 {BASE_LOAD:.0f}。")

report("A. 无界队列 + 无限重试（大多数系统的默认状态）", simulate())
report("B. 加重试预算（重试量 ≤ 成功量的 10%）", simulate(retry_budget=0.10))
report("C. 加有界队列，满了立刻拒绝（队列上限 100）", simulate(queue_limit=100))

print("""
读法：
  A：注意「白烧 QPS」这一列。尖峰过去之后，流量早就回到 80 了，
     可服务器 100% 的产能都花在「客户端已经走掉的请求」上 ——
     有效产出接近 0，于是所有人都超时，于是所有人都重试，
     于是队列永远排满，于是继续白烧。这个循环自己养活自己。

     这就是论文里说的元稳定失效（metastable failure）：
     触发因素（尖峰）早就消失了，坏状态却靠正反馈活了下来。
     Google SRE 书的说法是：「10000 QPS 时健康，11000 QPS 时崩了，
     这时候把流量降回 9000 QPS，几乎肯定止不住崩溃。」

     这也是为什么「加机器」经常没用 —— 新机器一上线就被同一股重试洪水
     打进同一个坏状态。你得先把循环掐断。

  B：只加了一条「重试量不能超过成功量的 10%」，打到服务的流量立刻回到 80，
     积压从 1975 → 1274 → 473 一路在掉，系统在自己爬出来了 ——
     只是很慢，两分钟还没爬完，这期间有效产出仍然是 0。
     gRPC 的 retryThrottling（maxTokens / tokenRatio）、
     Google SRE 的「每分钟最多 60 次重试」都是这一招。
     它切断了放大，但没解决「队列里全是过期请求」这件事。

  C：只加了一条「队列超过 100 就直接拒绝」，恢复得更快。
     因为队列有上限 ⟹ 排队时延有上限 ⟹ 排到的人一定还在等 ⟹ 不会白烧。
     这正是前面几篇讲的「快速失败 + 有界队列」在最后收口的地方。

  真出事时的顺序：先掐正反馈（关重试 / 丢负载 / 重启清空队列），再扩容。
  反过来做，扩的容会被反馈回路直接吃掉。
""")
