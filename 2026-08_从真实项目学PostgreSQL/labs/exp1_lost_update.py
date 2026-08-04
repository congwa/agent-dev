import psycopg, threading, sys
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")

def setup():
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS users")
        c.execute("CREATE TABLE users(id bigint primary key, balance numeric(20,6) not null)")
        c.execute("INSERT INTO users VALUES (1, 1000)")

def run(worker, n=100, threads=20):
    setup()
    ts=[threading.Thread(target=worker, args=(n//threads,)) for _ in range(threads)]
    [t.start() for t in ts]; [t.join() for t in ts]
    with psycopg.connect(DSN, autocommit=True) as c:
        return c.execute("SELECT balance FROM users WHERE id=1").fetchone()[0]

def bad(k):
    with psycopg.connect(DSN) as c:
        for _ in range(k):
            cur=c.execute("SELECT balance FROM users WHERE id=1")
            bal=cur.fetchone()[0]
            c.execute("UPDATE users SET balance=%s WHERE id=1", (bal-1,))
            c.commit()

def good(k):
    with psycopg.connect(DSN) as c:
        for _ in range(k):
            c.execute("UPDATE users SET balance=balance-1 WHERE id=1")
            c.commit()

def forupdate(k):
    with psycopg.connect(DSN) as c:
        for _ in range(k):
            cur=c.execute("SELECT balance FROM users WHERE id=1 FOR UPDATE")
            bal=cur.fetchone()[0]
            c.execute("UPDATE users SET balance=%s WHERE id=1", (bal-1,))
            c.commit()

print("期望值: 1000 - 100 = 900")
print("A) 读-改-写 (SELECT then UPDATE, 无锁)      最终余额 =", run(bad))
print("B) SELECT ... FOR UPDATE 后再写            最终余额 =", run(forupdate))
print("C) UPDATE ... SET balance = balance - 1    最终余额 =", run(good))
