"""
demo01: 秒杀场景 —— 「让所有人排队」 vs 「超了就立刻拒绝」

场景：一个接口，后端只能同时处理 20 个请求，每个请求耗时 50ms。
      → 理论产能 = 20 / 0.05 = 400 QPS
      现在瞬间来了 1200 QPS。用户等超过 1 秒就走人（关页面 / 超时）。

跑法：python3 demo01_failfast.py
"""
import asyncio
import time

CONCURRENCY = 20        # 后端能同时处理多少个（想象成线程池大小 / 数据库连接数）
WORK_TIME = 0.05        # 每个请求真正干活要 50ms
CLIENT_TIMEOUT = 1.0    # 用户最多等 1 秒
QPS = 1200              # 洪峰流量
DURATION = 3            # 打 3 秒


class Server:
    def __init__(self, fail_fast: bool):
        self.fail_fast = fail_fast
        self.sem = asyncio.Semaphore(CONCURRENCY)
        self.inflight = 0        # 当前正在干活的请求数
        self.started = 0         # 一共有多少请求真正开始干活了
        self.finished = 0        # 其中有多少干完了

    async def _work(self):
        self.inflight += 1
        self.started += 1
        try:
            await asyncio.sleep(WORK_TIME)   # 假装在查数据库
            self.finished += 1
            return "ok"
        finally:
            self.inflight -= 1

    async def handle(self):
        if self.fail_fast:
            # 核心就这三行：满了不排队，立刻返回 429
            if self.inflight >= CONCURRENCY:
                return "rejected"
            return await self._work()
        else:
            # 没有保护：所有人乖乖排队，队伍要多长有多长
            async with self.sem:
                return await self._work()


async def run(fail_fast: bool):
    srv = Server(fail_fast)
    results = {"ok": 0, "rejected": 0, "timeout": 0}
    latencies = []
    tasks = []

    async def one_request():
        start = time.monotonic()
        try:
            r = await asyncio.wait_for(srv.handle(), CLIENT_TIMEOUT)
        except asyncio.TimeoutError:
            r = "timeout"
        results[r] += 1
        latencies.append(time.monotonic() - start)

    interval = 1 / QPS
    t0 = time.monotonic()
    for i in range(QPS * DURATION):
        tasks.append(asyncio.create_task(one_request()))
        await asyncio.sleep(max(0, t0 + i * interval - time.monotonic()))
    await asyncio.gather(*tasks)

    latencies.sort()
    p50 = latencies[len(latencies) // 2]
    p99 = latencies[int(len(latencies) * 0.99)]
    total = len(latencies)
    wasted = srv.started - srv.finished     # 占了坑、干到一半、用户却已经走了

    name = "快速失败 + 丢弃" if fail_fast else "全都排队（无保护）"
    print(f"\n【{name}】共 {total} 个请求")
    print(f"  成功拿到结果 : {results['ok']:>5}  ({results['ok']/total*100:.1f}%)   ← 这才是有效产出")
    print(f"  被明确拒绝   : {results['rejected']:>5}          ← 用户 50ms 内就知道结果")
    print(f"  等到超时     : {results['timeout']:>5}          ← 白等 1 秒，什么也没拿到")
    print(f"  白干的活     : {wasted:>5}          ← 占了后端坑位，产出却被丢掉")
    print(f"  P50 / P99    : {p50*1000:>5.0f} / {p99*1000:.0f} ms")


async def main():
    cap = int(CONCURRENCY / WORK_TIME)
    print(f"后端产能 = {CONCURRENCY} 并发 / {WORK_TIME}s = {cap} QPS")
    print(f"实际来了 {QPS} QPS，是产能的 {QPS/cap:.0f} 倍")
    await run(fail_fast=False)
    await run(fail_fast=True)
    print("""
读法（重点看两个数）：
  1. 「成功拿到结果」—— 快速失败反而更多。
     因为无保护时，后端的坑位被一堆「用户已经走了的请求」占着，
     等它们排到队头时早就没意义了。这些坑位本来可以服务真正还在等的人。
  2. 「P99 延迟」—— 从 1 秒掉到几十毫秒。
     拒绝一个请求几乎不花钱，让人排队却要付出全额的等待成本。

  产能不会因为排队而变多。排队只是把「一部分人被拒绝」
  变成了「所有人都等很久，然后大部分人还是失败」。
""")


asyncio.run(main())
