#!/usr/bin/env python3
"""
第 5 篇 · 实验 32：等一把行锁的时候，你到底在等什么

行锁不在锁表里，那"等锁"这件事是怎么发生的？答案是：
排队排的是重量级锁 —— transactionid（等持有者的事务结束）和 tuple（等前面的人先走）。
"""
import threading
import time

import os

import psycopg

DSN = os.environ.get("PG_DSN",
                     "host=localhost port=5433 user=postgres password=pg dbname=postgres")


def setup():
    with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS w")
        cur.execute("CREATE TABLE w(id int PRIMARY KEY, v int)")
        cur.execute("INSERT INTO w VALUES (1, 0)")


def waiter(name, hold=3.0):
    def run():
        with psycopg.connect(DSN) as c, c.cursor() as cur:
            cur.execute(f"SET application_name = '{name}'")
            cur.execute("SELECT * FROM w WHERE id = 1 FOR UPDATE")
            time.sleep(hold)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def snapshot(obs, title):
    print(f"\n--- {title} ---")
    with obs.cursor() as cur:
        cur.execute("""
            SELECT application_name, state,
                   coalesce(wait_event_type,'-') || ':' || coalesce(wait_event,'-'),
                   pg_blocking_pids(pid)
            FROM pg_stat_activity
            WHERE datname = current_database() AND application_name LIKE 'sess%'
            ORDER BY application_name
        """)
        print(f"  {'会话':<8} {'状态':<22} {'等待事件':<26} 被谁挡着")
        for app, state, ev, blockers in cur.fetchall():
            print(f"  {app:<8} {state:<22} {ev:<26} {blockers}")
        cur.execute("""
            SELECT l.locktype, l.mode, l.granted, a.application_name
            FROM pg_locks l JOIN pg_stat_activity a USING (pid)
            WHERE a.datname = current_database() AND a.application_name LIKE 'sess%'
              AND l.locktype IN ('transactionid', 'tuple')
            ORDER BY a.application_name, l.locktype
        """)
        print(f"\n  {'locktype':<14} {'mode':<18} {'已授予':<8} 持有/等待者")
        for lt, mode, granted, app in cur.fetchall():
            print(f"  {lt:<14} {mode:<18} {str(granted):<8} {app}")


def main():
    setup()
    obs = psycopg.connect(DSN, autocommit=True)

    # A 先抢到行锁并一直握着
    a = psycopg.connect(DSN)
    with a.cursor() as cur:
        cur.execute("SET application_name = 'sessA'")
        cur.execute("SELECT * FROM w WHERE id = 1 FOR UPDATE")

    snapshot(obs, "① 只有 A 持锁：没人等，也没有 tuple 锁")

    # B、C 依次来抢同一行
    waiter("sessB")
    time.sleep(0.5)
    waiter("sessC")
    time.sleep(0.5)

    snapshot(obs, "② B、C 排队抢同一行")
    print("""
  读法：
    B 等的是 transactionid —— 它在等 A 的事务结束（行头上的 xmax 就是 A 的 xid）
    C 等的是 tuple —— 这是"号码牌"锁，保证 B 先于 C 拿到行
    行锁本身依然不在 pg_locks 里，你看到的全是为了排队而借用的重量级锁""")

    a.rollback()
    time.sleep(1.0)
    snapshot(obs, "③ A 回滚之后")
    obs.close()


if __name__ == "__main__":
    main()
