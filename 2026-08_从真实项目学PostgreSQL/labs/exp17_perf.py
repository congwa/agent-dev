import psycopg, threading, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
N_THREADS=16; PER=100
def reset():
    with psycopg.connect(DSN,autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS users")
        c.execute("CREATE TABLE users(id int primary key, balance numeric(20,6))")
        c.execute("INSERT INTO users VALUES (1, 1000000)")
def bench(fn,label):
    reset(); t0=time.time()
    ts=[threading.Thread(target=fn) for _ in range(N_THREADS)]
    [t.start() for t in ts]; [t.join() for t in ts]
    dt=time.time()-t0
    with psycopg.connect(DSN,autocommit=True) as c:
        bal=c.execute("SELECT balance FROM users WHERE id=1").fetchone()[0]
    exp=1000000-N_THREADS*PER
    print(f"{label}\n   {N_THREADS*PER} 次扣款耗时 {dt:.2f}s  ({N_THREADS*PER/dt:.0f} 次/秒)  余额 {bal} (应为 {exp}) {'✅' if bal==exp else '❌'}\n")

def atomic():
    with psycopg.connect(DSN,autocommit=True) as c:
        for _ in range(PER):
            c.execute("UPDATE users SET balance=balance-1 WHERE id=1 AND balance>=1")

def select_for_update():
    with psycopg.connect(DSN) as c:
        for _ in range(PER):
            c.execute("BEGIN")
            bal=c.execute("SELECT balance FROM users WHERE id=1 FOR UPDATE").fetchone()[0]
            if bal>=1: c.execute("UPDATE users SET balance=%s WHERE id=1",(bal-1,))
            c.commit()

def serializable_retry():
    with psycopg.connect(DSN) as c:
        done=0
        while done<PER:
            try:
                c.execute("BEGIN ISOLATION LEVEL SERIALIZABLE")
                bal=c.execute("SELECT balance FROM users WHERE id=1").fetchone()[0]
                if bal>=1: c.execute("UPDATE users SET balance=%s WHERE id=1",(bal-1,))
                c.commit(); done+=1
            except Exception:
                c.rollback()   # 序列化失败，重试

print(f"{N_THREADS} 个并发连接，各扣 {PER} 次，全部打在同一行上\n")
bench(atomic,              "[A] 单条原子 UPDATE（sub2api 的写法）")
bench(select_for_update,   "[B] SELECT ... FOR UPDATE + UPDATE（两条语句，一个事务）")
bench(serializable_retry,  "[C] SERIALIZABLE + 失败重试")
