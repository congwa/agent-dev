"""
demo04: 行情推送 / 弹幕 / 监控指标 —— 「丢旧留新」到底救了什么

场景：服务端每 1ms 推一次最新股价（1000 次/秒）。
      客户端渲染一次要 10ms（只能消费 100 次/秒）。快了 10 倍。

三种缓冲策略：
  A. 无界队列        —— 一条都不丢，但客户端显示的价格越来越旧
  B. 有界队列，丢新的 —— 内存保住了，但客户端一直在看几秒前的老价格
  C. 只留最新一条     —— 中间的全丢掉，客户端永远显示当前价

跑法：python3 demo04_conflate.py
"""
import asyncio
import time
from collections import deque

TICK_INTERVAL = 0.001    # 每 1ms 一个新价格
RENDER_TIME = 0.01       # 客户端渲染一次要 10ms
DURATION = 2.0           # 跑 2 秒


class Buffer:
    """三种策略共用一个壳，区别只在 push 的那几行"""

    def __init__(self, mode):
        self.mode = mode
        if mode == "unbounded":
            self.q = deque()
        elif mode == "drop_new":
            self.q = deque()
            self.cap = 100
        else:  # conflate：只留最后一条，就是 ZeroMQ 的 ZMQ_CONFLATE
            self.q = deque(maxlen=1)
        self.dropped = 0
        self.peak = 0

    def push(self, item):
        if self.mode == "unbounded":
            self.q.append(item)
        elif self.mode == "drop_new":
            if len(self.q) >= self.cap:
                self.dropped += 1              # 满了，新的直接不要
                return
            self.q.append(item)
        else:
            if len(self.q) == 1:
                self.dropped += 1              # 旧的被顶掉了
            self.q.append(item)                # deque(maxlen=1) 自动踢掉旧的
        self.peak = max(self.peak, len(self.q))

    def pop(self):
        return self.q.popleft() if self.q else None


async def run(mode):
    buf = Buffer(mode)
    stop = False
    ages = []          # 客户端每次渲染时，这条数据已经「多老了」
    price_errors = []  # 客户端显示的价格 和 真实当前价 差多少
    latest_price = [100.0]

    async def producer():
        t0 = time.monotonic()
        i = 0
        while not stop:
            i += 1
            latest_price[0] = 100.0 + i * 0.01          # 价格一路上涨，方便看误差
            buf.push((time.monotonic(), latest_price[0]))
            await asyncio.sleep(max(0, t0 + i * TICK_INTERVAL - time.monotonic()))

    async def consumer():
        while not stop:
            item = buf.pop()
            if item is None:
                await asyncio.sleep(0.001)
                continue
            ts, price = item
            await asyncio.sleep(RENDER_TIME)             # 渲染
            ages.append(time.monotonic() - ts)
            price_errors.append(abs(latest_price[0] - price))

    p = asyncio.create_task(producer())
    c = asyncio.create_task(consumer())
    await asyncio.sleep(DURATION)
    stop = True
    await asyncio.gather(p, c)

    ages.sort()
    names = {"unbounded": "A. 无界队列（一条不丢）",
             "drop_new": "B. 有界队列，满了丢新的（上限 100）",
             "conflate": "C. 只留最新一条（丢旧留新）"}
    n = len(ages)
    print(f"\n【{names[mode]}】")
    print(f"  客户端渲染了      : {n} 帧")
    print(f"  丢弃的行情条数    : {buf.dropped}")
    print(f"  队列峰值长度      : {buf.peak}")
    print(f"  数据陈旧度 中位数 : {ages[n//2]*1000:>7.0f} ms")
    print(f"  数据陈旧度 最差   : {ages[-1]*1000:>7.0f} ms")
    print(f"  显示价格的平均误差: {sum(price_errors)/len(price_errors):>7.2f} 元")


async def main():
    print(f"服务端 {int(1/TICK_INTERVAL)} 条/秒，客户端只能消费 {int(1/RENDER_TIME)} 条/秒")
    for mode in ["unbounded", "drop_new", "conflate"]:
        await run(mode)
    print("""
读法：
  A「一条都不丢」听起来最负责，实际最没用：
    队列越涨越长，客户端渲染的是 1 秒前、2 秒前的价格。
    对于行情/弹幕，显示一个 2 秒前的价格，比什么都不显示更危险。
    而且队列还在无限吃内存。

  B「丢新的」是很多人下意识写的 `if len(q) >= cap: return`，
    结果是队列里永远塞着一堆老数据，客户端一直在啃旧的。
    这是三个方案里最糟的 —— 既丢了数据，又没换来新鲜度。
    （Docker 的日志 ring buffer 就是这个策略，但日志要按顺序看，所以那里是对的。）

  C「丢旧留新」几乎不占内存，陈旧度永远只有一个渲染周期。
    代价是中间的价格跳变看不到了 —— 但对「只关心当前值」的场景，这正是你要的。

  一句话：数据便宜、实时性 >> 完整性的时候，
         队列不该是「攒着慢慢发的缓冲区」，而该是「只框住现在的取景框」。
""")


asyncio.run(main())
