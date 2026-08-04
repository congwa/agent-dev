import psycopg, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
with psycopg.connect(DSN,autocommit=True) as c:
    c.execute("DROP TABLE IF EXISTS child, parent CASCADE")
    c.execute("CREATE TABLE parent(id int primary key, name text, cnt int default 0)")
    c.execute("CREATE TABLE child(id int primary key, pid int references parent(id))")
    c.execute("INSERT INTO parent VALUES (1,'a',0)")

print("=== 行级锁模式：谁挡谁 ===")
modes=["FOR UPDATE","FOR NO KEY UPDATE","FOR SHARE","FOR KEY SHARE"]
print("持有者\\等待者".ljust(22) + "".join(f"{m:20s}" for m in modes))
for m1 in modes:
    row=f"{m1:22s}"
    for m2 in modes:
        a=psycopg.connect(DSN); a.execute("BEGIN"); a.execute(f"SELECT * FROM parent WHERE id=1 {m1}")
        b=psycopg.connect(DSN); b.execute("BEGIN"); b.execute("SET lock_timeout='250ms'")
        try:
            b.execute(f"SELECT * FROM parent WHERE id=1 {m2}"); row+=f"{'通过':20s}"
        except Exception: row+=f"{'阻塞':18s}"
        b.rollback(); b.close(); a.rollback(); a.close()
    print(row)

print("\n=== 一个经典坑：给子表插一行，会锁住父表那一行 ===")
a=psycopg.connect(DSN); a.execute("BEGIN"); a.execute("INSERT INTO child VALUES (1,1)")
b=psycopg.connect(DSN); b.execute("BEGIN"); b.execute("SET lock_timeout='300ms'")
for sql,desc in [("UPDATE parent SET cnt=cnt+1 WHERE id=1","改父表的普通列 cnt"),
                 ("UPDATE parent SET id=2 WHERE id=1","改父表的主键 id"),
                 ("DELETE FROM parent WHERE id=1","删父表这一行")]:
    try:
        b.execute("SAVEPOINT s"); b.execute(sql); print(f"  {desc:22s} → 通过（FK 只加 FOR KEY SHARE，不挡非键列的修改）"); b.execute("ROLLBACK TO s")
    except Exception as e:
        print(f"  {desc:22s} → 被阻塞: {str(e).splitlines()[0][:50]}"); b.execute("ROLLBACK TO s")
a.rollback(); b.rollback(); a.close(); b.close()

print("\n=== 表级锁：哪些操作会拿 AccessExclusiveLock（挡住一切读写）===")
with psycopg.connect(DSN,autocommit=True) as c:
    for sql in ["SELECT * FROM parent","UPDATE parent SET cnt=1 WHERE id=1",
                "CREATE INDEX ix_tmp ON parent(name)","ALTER TABLE parent ADD COLUMN z int",
                "VACUUM parent"]:
        h=psycopg.connect(DSN)
        try:
            h.execute("BEGIN"); h.execute(sql)
            r=c.execute("""SELECT string_agg(DISTINCT mode,',') FROM pg_locks l JOIN pg_stat_activity a USING(pid)
                           WHERE a.pid<>pg_backend_pid() AND l.relation='parent'::regclass AND a.state LIKE 'idle in%'""").fetchone()[0]
            print(f"  {sql:42s} → {r}")
        except Exception as e: print(f"  {sql:42s} → {str(e).splitlines()[0][:40]}")
        h.rollback(); h.close()
