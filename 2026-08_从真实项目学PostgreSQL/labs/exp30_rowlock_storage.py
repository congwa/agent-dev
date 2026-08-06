#!/usr/bin/env python3
"""
第 5 篇 · 实验 30：行锁到底存在哪里

证明三件事：
  1. 行锁不进锁表(pg_locks)，它写在行自己的头部：t_xmax + t_infomask
  2. 多个事务同时锁一行时，t_xmax 装不下多个 xid，于是换成 MultiXactId
  3. 锁一百万行，pg_locks 里依然只有那几条表级锁 —— 所以 Postgres 不需要"锁升级"

需要 pageinspect 扩展与超级用户权限。
"""
import os

import psycopg

DSN = os.environ.get("PG_DSN",
                     "host=localhost port=5433 user=postgres password=pg dbname=postgres")

# 解码 t_infomask，只挑与行锁相关的位
FLAGS_SQL = """
SELECT lp,
       t_xmin::text AS xmin,
       t_xmax::text AS xmax,
       t_ctid::text AS ctid,
       array_to_string(
         array(SELECT f FROM unnest(
                (heap_tuple_infomask_flags(t_infomask, t_infomask2)).raw_flags
              ) AS f
               WHERE f LIKE 'HEAP_XMAX%' OR f IN ('HEAP_KEYS_UPDATED',
                                                  'HEAP_HOT_UPDATED',
                                                  'HEAP_ONLY_TUPLE')),
         ' | ') AS xmax_flags
FROM heap_page_items(get_raw_page('acct', 0))
WHERE t_xmin IS NOT NULL
ORDER BY lp;
"""


def show(obs, title):
    print(f"\n--- {title} ---")
    with obs.cursor() as cur:
        cur.execute(FLAGS_SQL)
        print(f"  {'lp':<3} {'xmin':<8} {'xmax':<10} {'ctid':<8} xmax 上的标志位")
        for lp, xmin, xmax, ctid, flags in cur.fetchall():
            print(f"  {lp:<3} {xmin:<8} {xmax:<10} {ctid:<8} {flags or '-'}")


def multixact_members(obs, xmax):
    with obs.cursor() as cur:
        cur.execute("SELECT * FROM pg_get_multixact_members(%s::text::xid)", (xmax,))
        return cur.fetchall()


def main():
    obs = psycopg.connect(DSN, autocommit=True)
    with obs.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS pageinspect")
        cur.execute("DROP TABLE IF EXISTS acct")
        cur.execute("CREATE TABLE acct(id int PRIMARY KEY, bal numeric, note text)")
        cur.execute("INSERT INTO acct VALUES (1, 100, 'a'), (2, 200, 'b')")

    show(obs, "① 刚插入：xmax 为空，没有任何人锁它")

    # ② 一个事务 FOR UPDATE
    a = psycopg.connect(DSN)
    with a.cursor() as cur:
        cur.execute("SELECT txid_current()")
        xid_a = cur.fetchone()[0]
        cur.execute("SELECT id FROM acct WHERE id = 1 FOR UPDATE")
    show(obs, f"② 会话 A（xid={xid_a}）执行 SELECT ... FOR UPDATE")
    print("   注意：xmax 就是 A 的 xid，LOCK_ONLY 表示这行只是被锁住、没被删改")

    with obs.cursor() as cur:
        cur.execute("SELECT count(*) FROM pg_locks WHERE locktype = 'tuple'")
        print(f"   此刻 pg_locks 里 locktype='tuple' 的条目数: {cur.fetchone()[0]}")
    a.rollback()

    # ③ 两个事务同时 FOR KEY SHARE -> MultiXact
    b = psycopg.connect(DSN)
    c = psycopg.connect(DSN)
    with b.cursor() as cur:
        cur.execute("SELECT txid_current()")
        xid_b = cur.fetchone()[0]
        cur.execute("SELECT id FROM acct WHERE id = 1 FOR KEY SHARE")
    with c.cursor() as cur:
        cur.execute("SELECT txid_current()")
        xid_c = cur.fetchone()[0]
        cur.execute("SELECT id FROM acct WHERE id = 1 FOR KEY SHARE")
    show(obs, f"③ 会话 B(xid={xid_b}) 和 C(xid={xid_c}) 同时 FOR KEY SHARE")

    with obs.cursor() as cur:
        cur.execute(FLAGS_SQL)
        row = cur.fetchall()[0]
        mxid = int(row[2])
    print(f"   xmax={mxid} 已经不是 xid，而是 MultiXactId。它的成员：")
    for xid, mode in multixact_members(obs, mxid):
        print(f"     xid={xid}  mode={mode}")
    b.rollback()
    c.rollback()

    # ④ 真正的 UPDATE
    d = psycopg.connect(DSN)
    with d.cursor() as cur:
        cur.execute("SELECT txid_current()")
        xid_d = cur.fetchone()[0]
        cur.execute("UPDATE acct SET bal = bal + 1 WHERE id = 1")
    show(obs, f"④ 会话 D(xid={xid_d}) 执行 UPDATE（改的是非键列 bal）")
    print("   旧版本 lp=1 的 xmax=D，没有 LOCK_ONLY（是真删了），HOT_UPDATED 指向新版本")
    print("   新版本 lp=3 是同一页里新写的一行 —— 这就是第 1、2 篇讲的 MVCC")
    d.rollback()

    # ⑤ 锁很多行，看锁表有没有涨
    with obs.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS many")
        cur.execute("CREATE TABLE many(id int PRIMARY KEY)")
        cur.execute("INSERT INTO many SELECT generate_series(1, 1000000)")
    e = psycopg.connect(DSN)
    with e.cursor() as cur:
        cur.execute("SELECT count(*) FROM (SELECT id FROM many FOR UPDATE) s")
        locked = cur.fetchone()[0]
    with obs.cursor() as cur:
        cur.execute("""
            SELECT locktype, mode, count(*)
            FROM pg_locks
            GROUP BY 1, 2 ORDER BY 3 DESC
        """)
        rows = cur.fetchall()
    print(f"\n--- ⑤ 一个事务锁住 {locked} 行之后，整个实例的 pg_locks ---")
    for locktype, mode, n in rows:
        print(f"  {locktype:<12} {mode:<22} {n}")
    print("  一百万把行锁，锁表里一条都没有 —— 因为它们全写在各自的行头上了")
    e.rollback()

    for conn in (a, b, c, d, e, obs):
        conn.close()


if __name__ == "__main__":
    main()
