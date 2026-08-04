import psycopg, threading, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
def reset():
    with psycopg.connect(DSN,autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS t")
        c.execute("CREATE TABLE t(id bigserial primary key, v int)")
        c.execute("INSERT INTO t(v) SELECT g FROM generate_series(1,2000000) g")

def measure(ddl, label):
    reset(); blocked=[]; stop=threading.Event()
    def writer():
        with psycopg.connect(DSN,autocommit=True) as c:
            while not stop.is_set():
                t0=time.time(); c.execute("UPDATE t SET v=v+1 WHERE id=1"); dt=time.time()-t0
                blocked.append(dt); time.sleep(0.01)
    th=threading.Thread(target=writer); th.start(); time.sleep(0.3)
    with psycopg.connect(DSN,autocommit=True) as c:
        t0=time.time(); c.execute(ddl); ddl_t=time.time()-t0
    stop.set(); th.join()
    print(f"{label}\n   DDL 自身耗时 {ddl_t:.2f}s   期间业务 UPDATE 最长被卡 {max(blocked)*1000:.0f} ms（正常约 {sorted(blocked)[len(blocked)//2]*1000:.1f} ms）\n")

measure("CREATE INDEX idx_v ON t(v)", "[A] CREATE INDEX（普通）")
measure("CREATE INDEX CONCURRENTLY idx_v2 ON t(v)", "[B] CREATE INDEX CONCURRENTLY")
reset()
with psycopg.connect(DSN,autocommit=True) as c:
    for ddl in ["ALTER TABLE t ADD COLUMN c1 int",
                "ALTER TABLE t ADD COLUMN c2 int DEFAULT 42",
                "ALTER TABLE t ADD COLUMN c3 int NOT NULL DEFAULT 7",
                "ALTER TABLE t ALTER COLUMN v TYPE bigint"]:
        t0=time.time(); c.execute(ddl); print(f"   {ddl:48s} 耗时 {time.time()-t0:.2f}s")
