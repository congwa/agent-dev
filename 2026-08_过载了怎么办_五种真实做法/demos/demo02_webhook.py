"""
demo02: 第三方 webhook 回调 —— 三种接法的下场

场景：支付平台给你推回调。它的规矩（GitHub 是 10 秒，Stripe/Svix 是 15 秒）：
      「你必须在超时前返回 2xx，否则我当你挂了，然后按退避表重推。」

      你的处理逻辑（写库 + 发通知）要 100ms。
      对方峰值推 200 条/秒，你只有 5 个 worker → 处理能力 50 条/秒。

三种接法：
  A. 收到就处理完再返回        → ACK 变慢 → 对方超时 → 重推 → 雪崩
  B. 立即 ACK + 无界队列        → ACK 很快，但队列涨到天上，数据越来越陈旧
  C. 立即 ACK + 有界队列(满则503) → ACK 很快，队列封顶，压力还给对方

跑法：python3 demo02_webhook.py
"""
import asyncio
import time

WORK_TIME = 0.1         # 处理一条回调要 100ms
WORKERS = 5             # 5 个后台 worker → 处理能力 50 条/秒
SENDER_TIMEOUT = 0.3    # 对方等你 300ms（真实世界是 10~15 秒，这里等比缩小）
INCOMING = 200          # 对方每秒推 200 条
DURATION = 3
QUEUE_MAX = 200         # C 方案的队列上限


class Receiver:
    def __init__(self, mode):
        self.mode = mode                       # "sync" | "unbounded" | "bounded"
        maxsize = QUEUE_MAX if mode == "bounded" else 0    # 0 = 无上限
        self.q = asyncio.Queue(maxsize=maxsize)
        self.pool = asyncio.Semaphore(WORKERS)  # A 方案里，HTTP handler 也得抢这 5 个坑
        self.peak_qlen = 0
        self.processed = 0
        self.rejected = 0                      # 主动返回 503，让对方重推

    async def _process(self, event):
        await asyncio.sleep(WORK_TIME)
        self.processed += 1

    async def on_webhook(self, event):
        """这就是你的 HTTP handler。返回值 = HTTP 状态码"""
        if self.mode == "sync":
            async with self.pool:              # ← 罪魁祸首：处理完才返回，还要排队抢 worker
                await self._process(event)
            return 200

        try:
            self.q.put_nowait(event)           # 不阻塞地塞进队列
        except asyncio.QueueFull:
            self.rejected += 1
            return 503                         # 明确告诉对方「我满了，等会再推」
        self.peak_qlen = max(self.peak_qlen, self.q.qsize())
        return 202                             # Accepted：收到了，稍后处理

    async def worker(self):
        while True:
            event = await self.q.get()
            await self._process(event)
            self.q.task_done()


async def run(mode):
    rcv = Receiver(mode)
    workers = [asyncio.create_task(rcv.worker()) for _ in range(WORKERS)]

    stats = {"acked": 0, "timeout": 0, "retried": 0, "gave_up": 0}
    ack_times = []

    async def sender(event, attempt=1):
        """模拟对方的推送逻辑：超时或非 2xx 就重推，最多 3 次"""
        t0 = time.monotonic()
        try:
            code = await asyncio.wait_for(rcv.on_webhook(event), SENDER_TIMEOUT)
            ack_times.append(time.monotonic() - t0)
            if 200 <= code < 300:
                stats["acked"] += 1
                return
        except asyncio.TimeoutError:
            ack_times.append(time.monotonic() - t0)
            stats["timeout"] += 1
        # 走到这里说明这次没送达
        if attempt >= 3:
            stats["gave_up"] += 1
            return
        stats["retried"] += 1
        await asyncio.sleep(0.2 * attempt)     # 退避后重推
        await sender(event, attempt + 1)

    tasks = []
    interval = 1 / INCOMING
    t0 = time.monotonic()
    for i in range(INCOMING * DURATION):
        tasks.append(asyncio.create_task(sender(i)))
        await asyncio.sleep(max(0, t0 + i * interval - time.monotonic()))
    await asyncio.gather(*tasks)

    # 再给 worker 一点时间收尾，看看积压要多久才能消化
    drain_start = time.monotonic()
    try:
        await asyncio.wait_for(rcv.q.join(), timeout=10)
        drain = time.monotonic() - drain_start
        drained = f"{drain:.1f}s"
    except asyncio.TimeoutError:
        drained = f">10s（还剩 {rcv.q.qsize()} 条没处理完）"
    for w in workers:
        w.cancel()

    ack_times.sort()
    p99 = ack_times[int(len(ack_times) * 0.99)] if ack_times else 0
    names = {"sync": "A. 收到就处理完再返回",
             "unbounded": "B. 立即 ACK + 无界队列",
             "bounded": f"C. 立即 ACK + 有界队列(上限 {QUEUE_MAX})"}
    print(f"\n【{names[mode]}】对方共推了 {INCOMING*DURATION} 条")
    print(f"  ACK 的 P99 耗时 : {p99*1000:>6.0f} ms   (对方的耐心是 {SENDER_TIMEOUT*1000:.0f}ms)")
    print(f"  对方判定超时     : {stats['timeout']:>6}")
    print(f"  你主动回 503     : {rcv.rejected:>6}")
    print(f"  触发重推         : {stats['retried']:>6}   ← 这些是被你逼出来的额外流量")
    print(f"  对方彻底放弃     : {stats['gave_up']:>6}   ← 数据永久丢失")
    print(f"  队列峰值长度     : {rcv.peak_qlen:>6}")
    print(f"  停止推送后清空积压耗时 : {drained}")


async def main():
    cap = int(WORKERS / WORK_TIME)
    print(f"你的处理能力 = {WORKERS} worker / {WORK_TIME}s = {cap} 条/秒")
    print(f"对方在推 {INCOMING} 条/秒，是你能力的 {INCOMING/cap:.0f} 倍\n")
    for mode in ["sync", "unbounded", "bounded"]:
        await run(mode)
    print("""
读法：
  A 的问题：ACK 耗时被处理逻辑绑架，一旦超过对方的超时阈值，
     对方就开始重推 —— 你越慢，它推得越多，你更慢。这是个正反馈，会一路烧到底。

  B 的问题：ACK 很快（好），对方不重推（好），但队列长度没有上限。
     队列涨到几千条时，一条回调从「收到」到「真正被处理」要等好几分钟。
     用户付完款十分钟收不到货，跟丢了没区别。而且进程一重启，内存里的全没了 ——
     可你已经回过 202 了，对方不会再推。这是最阴险的一种丢数据。

  C 的做法：队列封顶。满了就老老实实回 503，让对方按它的退避表重推。
     你保住了自己的内存和延迟，代价是把压力还给了上游 —— 这才是「有界」的意义。

  注意 C 也有「彻底放弃」的条数：那是因为这个 demo 里对方只重试 3 次、
  退避 0.2/0.4 秒。真实世界的退避表是「立刻 / 5秒 / 5分钟 / 30分钟 / 2小时 /
  5小时 / 10小时 / 10小时」（Svix 的默认表，前后跨 5 天），
  尖峰过去之后这些回调几乎都能补回来。所以 C 的丢失是「暂时的」，
  而 B 的丢失（进程重启后内存队列清零，但你已经回过 202）是永久且无声的。
""")


asyncio.run(main())
