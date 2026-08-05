# -*- coding: utf-8 -*-
"""
workerId（机器号）分配全路径 模拟器
配套文档：13-雪花算法真实项目调研.md 的「动手实验」一节
零依赖，python3 workerid_demo.py 直接跑。

演示五种 workerId 分配方案各自的行为和翻车方式，
以及"从一条脏数据反查是哪台机器生成的"这条反向路径。
"""

import time

EPOCH_MS = 1767225600000   # 2026-01-01 00:00:00 UTC


class Snowflake:
    def __init__(self, machine_id):
        self.machine_id = machine_id
        self.last_ts = -1
        self.seq = 0

    def next_id(self, fake_ts=None):
        ts = fake_ts if fake_ts is not None else int(time.time() * 1000)
        if ts == self.last_ts:
            self.seq = (self.seq + 1) & 0xFFF
        else:
            self.seq = 0
        self.last_ts = ts
        return ((ts - EPOCH_MS) << 22) | (self.machine_id << 12) | self.seq


def line(title=""):
    print()
    print("=" * 70)
    if title:
        print(title)
        print("=" * 70)


# ──────────────────────────────────────────────────────────
line("方案 1｜配置文件写死 —— 复现『运维复制配置』事故")
# ──────────────────────────────────────────────────────────

print("""
运维扩容时直接复制了一份 application.yml（里面写死 worker-id: 1）：
""")
fake_now = int(time.time() * 1000)
node_a = Snowflake(machine_id=1)     # 订单服务-A，配置里的 1
node_b = Snowflake(machine_id=1)     # 订单服务-B，复制来的同一个 1
id_a = node_a.next_id(fake_ts=fake_now)   # 同一毫秒（高并发下必然发生）
id_b = node_b.next_id(fake_ts=fake_now)
print(f"    机器              workerId    生成的 ID")
print(f"    {'-' * 58}")
print(f"    订单服务-A        1           {id_a}")
print(f"    订单服务-B        1           {id_b}")
print(f"    {'-' * 58}")
if id_a == id_b:
    print("    💥 两台机器在同一毫秒生成了完全相同的 ID")
    print("       → 后写入的那条报主键冲突")
    print("       → 或者更糟：落在不同分片上，两条数据都活着，数据永久错乱")

# ──────────────────────────────────────────────────────────
line("方案 2｜从 IP 推导 —— 复现 K8s 里的低位回绕碰撞")
# ──────────────────────────────────────────────────────────

print("""
常见写法：取 IP 后两段拼成一个数，再 & 1023 塞进 10 位机器号。
K8s 里 5 个 Pod，IP 由 CNI 动态分配：
""")

pods = [
    ("order-pod-1", "10.244.1.13"),
    ("order-pod-2", "10.244.2.47"),
    ("order-pod-3", "10.244.5.13"),
    ("order-pod-4", "10.244.3.88"),
    ("order-pod-5", "172.20.1.13"),
]

print(f"    {'Pod':<15} {'IP':<15} {'后两段':>6} {'& 1023':>8}    结果")
print(f"    {'-' * 62}")
seen = {}
collisions = 0
for name, ip in pods:
    p3, p4 = (int(x) for x in ip.split(".")[2:])
    raw = (p3 << 8) | p4
    wid = raw & 1023
    if wid in seen:
        collisions += 1
        verdict = f"💥 和 {seen[wid]} 撞了"
    else:
        seen[wid] = name
        verdict = f"✓  workerId={wid}"
    print(f"    {name:<15} {ip:<15} {raw:>6} {wid:>8}    {verdict}")
print(f"    {'-' * 62}")
print(f"    {len(pods)} 个 Pod 里有 {collisions} 个撞号。")
print("""
为什么撞？10 位只装得下 0~1023，而 IP 后两段最大 65535。
& 1023 只保留最低 10 位，高位信息被丢掉：

    10.244.1.13 → 269   → 269  & 1023 = 269
    10.244.5.13 → 1293  → 1293 & 1023 = 269   ← 撞上了
    172.20.1.13 → 269   → 269  & 1023 = 269   ← 也撞上了

规律：IP 第 3 段相差 4 的倍数（1024÷256），低 10 位就回绕重合。
💡 sonyflake 选 16 位机器号就是为了正好装下 IPv4 后两段（65536），
   一位信息都不丢——它是故意的，不是随便选的。""")

# ──────────────────────────────────────────────────────────
line("方案 3｜ZooKeeper 顺序节点（美团 Leaf 的做法，内存模拟）")
# ──────────────────────────────────────────────────────────


class FakeZooKeeper:
    """用 dict 模拟 ZK 的 PERSISTENT_SEQUENTIAL 节点"""

    def __init__(self):
        self.nodes = {}      # "ip:port" -> workerId
        self.next_seq = 0
        self.alive = True

    def get_or_create(self, key):
        if key in self.nodes:
            return self.nodes[key], "复用旧 workerId（重启不换号）"
        wid = self.next_seq
        self.next_seq += 1
        self.nodes[key] = wid
        return wid, "创建 SEQUENTIAL 节点"


zk = FakeZooKeeper()
local_cache = {}     # 模拟本地兜底文件 workerID.properties

print()
print(f"    {'节点':<20} {'ZK 操作':<28} workerId")
print(f"    {'-' * 60}")
for addr in ["10.0.1.5:8080", "10.0.1.6:8080", "10.0.1.7:8080"]:
    wid, op = zk.get_or_create(addr)
    local_cache[addr] = wid
    print(f"    {addr:<20} {op:<28} {wid}")

print()
print("【节点 10.0.1.6 重启】")
wid, op = zk.get_or_create("10.0.1.6:8080")
print(f"    → {op}，workerId = {wid}")
print("    ✅ 重启不换号（否则频繁重启会很快耗光 1024 个号）")

print()
print("【ZooKeeper 挂了】")
zk.alive = False
wid = local_cache["10.0.1.5:8080"]
print(f"    → ZK 连不上，从本地兜底文件读上次的号：workerId = {wid}，照常启动 ✅")
print()
print("Leaf 还有第三件套：每 3 秒向 ZK 上报本机时间戳；")
print("启动时如果 ZK 上记录的时间 > 当前系统时间 → 判定跨重启时钟回拨 → 拒绝启动。")

# ──────────────────────────────────────────────────────────
line("方案 4｜数据库自增，用完即弃（百度 UidGenerator 的做法）")
# ──────────────────────────────────────────────────────────


class FakeDB:
    """模拟 WORKER_NODE 表的自增主键"""

    def __init__(self):
        self.auto_inc = 0

    def insert(self, host):
        self.auto_inc += 1
        return self.auto_inc


db = FakeDB()
print()
print(f"    {'事件':<28} {'INSERT 返回的自增主键':<22} workerId")
print(f"    {'-' * 62}")
for event, host in [
    ("order-pod-1 首次启动", "10.0.1.5"),
    ("order-pod-2 首次启动", "10.0.1.6"),
    ("order-pod-1 崩溃重启", "10.0.1.5"),
    ("order-pod-3 扩容上线", "10.0.1.7"),
    ("order-pod-2 滚动更新", "10.0.1.6"),
]:
    wid = db.insert(host)
    note = "   ← 不是 1" if "崩溃重启" in event else ""
    print(f"    {event:<28} {wid:<22} {wid}{note}")
print(f"    {'-' * 62}")
print("""
注意 pod-1 重启后拿到的是 3，不是 1——号不复用，5 次启动消耗 5 个号。
这正好解释了百度反直觉的位分配：28 位秒级时间戳 + 22 位 workerId + 13 位序列。
22 位 = 420 万个号，就是为了支撑"每次重启换新号"的挥霍；
代价是时间戳只剩 28 位秒，只能用 8.7 年。""")

# ──────────────────────────────────────────────────────────
line("方案 5｜K8s StatefulSet 序号（2026 年推荐）")
# ──────────────────────────────────────────────────────────

print("""
StatefulSet（不是 Deployment）保证 Pod 名是 order-service-0/1/2...
且序号在 Pod 重建后保持不变。通过 Downward API 注入 POD_NAME：
""")
print(f"    {'Pod 名':<25} {'截取末尾':<10} workerId")
print(f"    {'-' * 50}")
for pod in ["order-service-0", "order-service-1", "order-service-2"]:
    wid = int(pod.split("-")[-1])
    print(f"    {pod:<25} {pod.split('-')[-1]:<10} {wid}")
print()
print("【Pod 2 被删除后重建】")
pod = "order-service-2"
print(f"    → 名字仍是 {pod} → workerId 仍是 {int(pod.split('-')[-1])} ✅")
print()
print("限制：必须 StatefulSet（Deployment 的 Pod 名带随机串，没法用）；副本 ≤ 1024。")

# ──────────────────────────────────────────────────────────
line("反向路径：从一条脏数据定位到机器")
# ──────────────────────────────────────────────────────────

mapping = {0: "order-service-0 (10.244.1.10)",
           7: "order-service-7 (10.244.2.77)",
           12: "order-service-12 (10.244.3.15)"}

dirty = Snowflake(machine_id=7).next_id()
wid = (dirty >> 12) & 1023
ts = (dirty >> 22) + EPOCH_MS
print(f"""
线上出了一条可疑订单，ID = {dirty}

Step 1  反解 workerId
        workerId = (id >> 12) & 1023 = {wid}

Step 2  反解时间戳
        timestamp = (id >> 22) + EPOCH = {ts}
                  → {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts / 1000))}.{ts % 1000:03d}

Step 3  查【号 ↔ 机器】映射表
        workerId {wid} → {mapping[wid]}

🎯 直接去捞这台机器这个时间点的日志

⚠️  Step 3 的前提是你【有】这张映射表：
    方案 1（配置写死）、方案 5（K8s 序号）→ 天然有
    方案 3（ZK）、方案 4（DB）→ 映射表就存在 ZK/DB 里
    方案 2（IP/MAC 推导）→ 没有映射表，号是算出来的，
       事后你根本不知道 {wid} 号是谁 —— 这是方案 2 常被忽略的隐性代价。""")
print()
