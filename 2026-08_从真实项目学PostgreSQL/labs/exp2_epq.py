import psycopg, threading, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")

def reset(bal=100):
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS users")
        c.execute("CREATE TABLE users(id bigint primary key, balance numeric(20,6) not null)")
        c.execute("INSERT INTO users VALUES (1,%s)", (bal,))

def scenario(iso, t2sql, label):
    reset(100)
    out={}
    def t2():
        time.sleep(0.3)
        with psycopg.connect(DSN) as c:
            c.execute(f"BEGIN ISOLATION LEVEL {iso}")
            try:
                cur=c.execute(t2sql)
                out['rows']=cur.rowcount
                c.commit()
            except Exception as e:
                out['err']=str(e).strip().splitlines()[0]
                c.rollback()
    th=threading.Thread(target=t2); th.start()
    with psycopg.connect(DSN) as c:   # T1: 并发把余额从 100 花到 50
        c.execute("BEGIN")
        c.execute("UPDATE users SET balance=50 WHERE id=1")
        time.sleep(1.0)               # T2 在这期间被行锁挡住
        c.commit()
    th.join()
    with psycopg.connect(DSN, autocommit=True) as c:
        final=c.execute("SELECT balance FROM users WHERE id=1").fetchone()[0]
    print(f"{label}\n   T2 结果: {out}   最终余额: {final}\n")

print("初始余额 100；T1 并发把它改成 50；T2 想扣 80\n")
scenario("READ COMMITTED",
  "UPDATE users SET balance=balance-80 WHERE id=1 AND balance>=80",
  "[1] READ COMMITTED + 条件写在 WHERE 里")
scenario("READ COMMITTED",
  "UPDATE users SET balance=balance-80 WHERE id=1",
  "[2] READ COMMITTED + 条件不在 WHERE 里（应用层已经查过余额=100，以为够）")
scenario("REPEATABLE READ",
  "UPDATE users SET balance=balance-80 WHERE id=1 AND balance>=80",
  "[3] REPEATABLE READ + 条件写在 WHERE 里")
