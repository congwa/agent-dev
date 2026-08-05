# -*- coding: utf-8 -*-
"""
雪花 ID 生成 + 基因法分库分表路由 模拟器
配套文档：14-分库分表.md 的「动手实验」一节
零依赖，python3 snowflake_sharding_demo.py 直接跑。

集群设定：2 个库 × 16 张表 = 32 个分片。
改一下下面的 USER_ID 就能看到路由跟着变。
"""

import time
import random

USER_ID = 10086          # 模拟下单的用户
NUM_DBS = 2              # 库数
TABLES_PER_DB = 16       # 每库表数
NUM_SHARDS = NUM_DBS * TABLES_PER_DB   # 32 = 2^5 → 基因 5 bit

# 自定义纪元：2026-01-01 00:00:00 UTC（一旦上线永不能改）
EPOCH_MS = 1767225600000


# ──────────────────────────────────────────────────────────
# 一、标准雪花：1 + 41 + 10 + 12
# ──────────────────────────────────────────────────────────

class Snowflake:
    """标准位分配：41 时间戳 / 10 机器号 / 12 序列号"""

    def __init__(self, machine_id):
        assert 0 <= machine_id < 1024
        self.machine_id = machine_id
        self.last_ts = -1
        self.seq = 0

    def next_id(self):
        ts = int(time.time() * 1000)
        if ts == self.last_ts:
            self.seq = (self.seq + 1) & 0xFFF
            if self.seq == 0:          # 本毫秒 4096 个用完，自旋等下一毫秒
                while ts <= self.last_ts:
                    ts = int(time.time() * 1000)
        else:
            self.seq = 0
        self.last_ts = ts
        return ((ts - EPOCH_MS) << 22) | (self.machine_id << 12) | self.seq


def decode_standard(sid):
    return {
        "timestamp": (sid >> 22) + EPOCH_MS,
        "machine": (sid >> 12) & 0x3FF,
        "seq": sid & 0xFFF,
    }


def fmt_ts(ms):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ms / 1000)) + f".{ms % 1000:03d}"


def show_standard_id(sid):
    b = f"{sid:064b}"
    print(f"生成的雪花 ID（十进制）:  {sid}")
    print(f"生成的雪花 ID（二进制）:  {b}")
    print()
    print("  按位切开：")
    print(f"    {b[0]}        {b[1:42]}  {b[42:52]}  {b[52:]}")
    print("    ↑        ↑" + " " * 41 + "↑           ↑")
    print("    符号1位  时间戳41位" + " " * 33 + "机器号10位  序列号12位")
    d = decode_standard(sid)
    print()
    print("  反解结果：")
    print(f"    时间戳  = {d['timestamp']}  →  {fmt_ts(d['timestamp'])}")
    print(f"    机器号  = {d['machine']}")
    print(f"    序列号  = {d['seq']}   （这一毫秒内的第 {d['seq']} 个 ID）")


# ──────────────────────────────────────────────────────────
# 二、基因版雪花：1 + 41 + 6 + 11 + 5
#    序列号和机器号各让几位，把最低 5 位腾给"基因"
# ──────────────────────────────────────────────────────────

GENE_BITS = 5            # 2^5 = 32 分片
SEQ_BITS = 11            # 2048/ms
MACHINE_BITS = 6         # 64 台


class GeneSnowflake:
    """基因版位分配：41 时间戳 / 6 机器号 / 11 序列号 / 5 基因"""

    def __init__(self, machine_id):
        assert 0 <= machine_id < (1 << MACHINE_BITS)
        self.machine_id = machine_id
        self.last_ts = -1
        self.seq = 0

    def next_id(self, user_id):
        gene = user_id % NUM_SHARDS            # ← 基因：从 user_id 直接抄低 5 位
        ts = int(time.time() * 1000)
        if ts == self.last_ts:
            self.seq = (self.seq + 1) & ((1 << SEQ_BITS) - 1)
            if self.seq == 0:
                while ts <= self.last_ts:
                    ts = int(time.time() * 1000)
        else:
            self.seq = 0
        self.last_ts = ts
        return (((ts - EPOCH_MS) << (MACHINE_BITS + SEQ_BITS + GENE_BITS))
                | (self.machine_id << (SEQ_BITS + GENE_BITS))
                | (self.seq << GENE_BITS)
                | gene)


def decode_gene(oid):
    return {
        "timestamp": (oid >> (MACHINE_BITS + SEQ_BITS + GENE_BITS)) + EPOCH_MS,
        "machine": (oid >> (SEQ_BITS + GENE_BITS)) & ((1 << MACHINE_BITS) - 1),
        "seq": (oid >> GENE_BITS) & ((1 << SEQ_BITS) - 1),
        "gene": oid & ((1 << GENE_BITS) - 1),
    }


def route(key):
    """中间件的路由算法：slot → (库, 表)"""
    slot = key % NUM_SHARDS
    return slot, f"ds_{slot // TABLES_PER_DB}", f"t_order_{slot % TABLES_PER_DB:02d}"


# ──────────────────────────────────────────────────────────
# 演示开始
# ──────────────────────────────────────────────────────────

def line(title=""):
    print()
    print("=" * 66)
    if title:
        print(title)
        print("=" * 66)


line("一、真实生成的雪花 ID，逐位拆开")
sf = Snowflake(machine_id=7)
show_standard_id(sf.next_id())

print()
print("连续生成 5 个，验证递增：")
print()
prev = None
for _ in range(5):
    i = sf.next_id()
    note = "" if prev is None else "  ↑ 比上一个大" if i > prev else "  ✗ 没有递增？！"
    print(f"  {i}   序列={decode_standard(i)['seq']}{note}")
    prev = i

line("二、写入路径：一条订单是怎么落到具体某张表的")
print(f"场景：user_id = {USER_ID} 下单 99 元。集群 = {NUM_DBS} 库 × {TABLES_PER_DB} 表 = {NUM_SHARDS} 分片")
print()
gene = USER_ID % NUM_SHARDS
print("Step 1｜先算基因")
print(f"    gene = user_id % {NUM_SHARDS} = {USER_ID} % {NUM_SHARDS} = {gene}")
print(f"    {gene} 的二进制 = {gene:05b}   ← 这 5 位待会儿要塞进 ID 的最低位")
print()

gsf = GeneSnowflake(machine_id=7)
order_id = gsf.next_id(USER_ID)
b = f"{order_id:064b}"
print("Step 2｜生成带基因的 order_id（位分配：41 时间戳 / 6 机器 / 11 序列 / 5 基因）")
print()
print(f"    order_id = {order_id}")
print()
print(f"    {b[0]}        {b[1:42]}  {b[42:48]}  {b[48:59]}  {b[59:]}")
print("    ↑        ↑" + " " * 41 + "↑       ↑            ↑")
print("    符号1位  时间戳41位" + " " * 33 + "机器6位 序列11位     ★基因5位")
d = decode_gene(order_id)
print()
print(f"    反解: 时间={fmt_ts(d['timestamp'])}  机器={d['machine']}  序列={d['seq']}  基因={d['gene']} ({d['gene']:05b})")
ok = "✅" if d["gene"] == gene else "❌"
print(f"    {ok} 基因位 = {d['gene']}，和 user_id % {NUM_SHARDS} = {gene} {'完全一致' if d['gene'] == gene else '不一致！'}")
print()

slot, db, tbl = route(order_id)
print("Step 3｜中间件算路由")
print(f"    slot = order_id % {NUM_SHARDS} = {slot}")
print(f"    库   = slot // {TABLES_PER_DB} = {slot // TABLES_PER_DB}  →  {db}")
print(f"    表   = slot %  {TABLES_PER_DB} = {slot % TABLES_PER_DB}  →  {tbl}")
print()
print("Step 4｜SQL 被改写")
print("  ┌──────────────────────────────────────────────────────────────┐")
print("  │ 逻辑 SQL（你写的）:                                          │")
print("  │     INSERT INTO t_order (id, user_id, amount)                │")
print(f"  │     VALUES ({order_id}, {USER_ID}, 99.00)                │")
print("  ├──────────────────────────────────────────────────────────────┤")
print("  │ 真实 SQL（中间件改写后真正发给 MySQL 的）:                   │")
print(f"  │     INSERT INTO {db}.{tbl} (id, user_id, amount)        │")
print(f"  │     VALUES ({order_id}, {USER_ID}, 99.00)                │")
print("  └──────────────────────────────────────────────────────────────┘")
print()
print(f"  📍 数据最终落在:  {db}.{tbl}")

line("三、两条读取路径")
slot_u, db_u, tbl_u = route(USER_ID)
print("路径 A：点开「我的订单」")
print()
print(f"    SQL:  SELECT * FROM t_order WHERE user_id = {USER_ID}")
print(f"    路由:  slot = {USER_ID} % {NUM_SHARDS} = {slot_u}  →  {db_u}.{tbl_u}")
print(f"    真实:  SELECT * FROM {db_u}.{tbl_u} WHERE user_id = {USER_ID}")
print(f"    🎯 只访问 1 个分片（共 {NUM_SHARDS} 个）")
print()
slot_o, db_o, tbl_o = route(order_id)
print("路径 B：点开订单详情页（关键）")
print()
print(f"    SQL:  SELECT * FROM t_order WHERE id = {order_id}")
print()
print("    ⚠️  这次 WHERE 里根本没有 user_id！")
print()
print(f"    但 order_id 的低 5 位 = {order_id & 0x1F:05b} = {order_id & 0x1F}")
print(f"    slot = order_id % {NUM_SHARDS} = {slot_o}  →  {db_o}.{tbl_o}")
print(f"    真实:  SELECT * FROM {db_o}.{tbl_o} WHERE id = {order_id}")
print("    🎯 也只访问 1 个分片！")
print()
print("  ┌──────────────────────────────────────────────────────────────┐")
print("  │ 恒等式验证                                                   │")
print(f"  │     user_id  % {NUM_SHARDS} = {slot_u:<2}                                       │")
print(f"  │     order_id % {NUM_SHARDS} = {slot_o:<2}                                       │")
print(f"  │     两者相等？ {slot_u == slot_o}   →  同一个分片，一次命中               │")
print("  └──────────────────────────────────────────────────────────────┘")

line("四、对照组：不用基因法会怎样")
plain_id = sf.next_id()
plain_slot, plain_db, plain_tbl = route(plain_id)
print("用普通雪花生成的 order_id，它的低 5 位来自序列号，和 user_id 毫无关系：")
print()
print(f"    普通雪花: order_id = {plain_id}")
print(f"    低 5 位 = {plain_id & 0x1F:05b} = {plain_id & 0x1F}")
print()
print(f"    user_id {USER_ID} 的数据其实在 {db_u}.{tbl_u}")
print(f"    但 order_id % {NUM_SHARDS} = {plain_slot} → 算出 {plain_db}.{plain_tbl}"
      + ("" if plain_slot == slot_u else " ← 错的位置！"))
print()
print("所以按 order_id 查详情时，只能全分片广播：")
print()
for r in range(0, NUM_SHARDS, 4):
    cells = []
    for s in range(r, min(r + 4, NUM_SHARDS)):
        cells.append(f"ds_{s // TABLES_PER_DB}.t_order_{s % TABLES_PER_DB:02d}")
    print("    " + "  ".join(cells))
print()
print(f"    💥 一次查询打了 {NUM_SHARDS} 个分片，慢 {NUM_SHARDS} 倍，还占满了连接池。")

line("五、跑 1 万条随机数据验证")
print(f"{'user_id':>12} {'order_id':>21} {'uid%32':>8} {'oid%32':>8}  一致?")
random.seed(42)
counter = [0] * NUM_SHARDS
bad = 0
for n in range(10000):
    uid = random.randint(1, 10**9)
    oid = gsf.next_id(uid)
    a, b2 = uid % NUM_SHARDS, oid % NUM_SHARDS
    if a != b2:
        bad += 1
    counter[b2] += 1
    if n < 5:
        print(f"{uid:>12} {oid:>21} {a:>8} {b2:>8}      {'✓' if a == b2 else '✗'}")
print()
print(f"10000 次测试中，恒等式不成立的次数: {bad}")
print("✅ 恒等式 100% 成立" if bad == 0 else "❌ 有不一致，位运算写错了")
print()
print("数据分布（看有没有热点）：")
print()
avg = 10000 / NUM_SHARDS
for s, c in enumerate(counter):
    bar = "█" * int(c / avg * 24)
    print(f"  slot {s:>2} (ds_{s // TABLES_PER_DB}.t_order_{s % TABLES_PER_DB:02d})  {bar} {c}")
print()
mx, mn = max(counter), min(counter)
print(f"  平均每片 {avg:.1f} 条，最多 {mx} 条（{mx / avg:.2f}×），最少 {mn} 条（{mn / avg:.2f}×）")
print(f"  最热分片只比平均高 {(mx / avg - 1) * 100:.1f}%  →  没有热点，分布均匀 ✓")
print()
