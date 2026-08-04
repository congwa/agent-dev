import psycopg, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
def size(c): return c.execute("SELECT pg_size_pretty(pg_relation_size('h'))").fetchone()[0]
def dead(c): return c.execute("SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='h'").fetchone()[0]
print("=== 什么样的空闲事务会拖住 VACUUM ===")
for iso, write in [("READ COMMITTED",False),("READ COMMITTED",True),("REPEATABLE READ",False)]:
    with psycopg.connect(DSN,autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS h"); c.execute("CREATE TABLE h(id int primary key,v int) WITH (autovacuum_enabled=off)")
        c.execute("INSERT INTO h SELECT g,0 FROM generate_series(1,20000) g"); c.execute("VACUUM h")
        c.execute("DROP TABLE IF EXISTS h2"); c.execute("CREATE TABLE h2(id int primary key)")
        c.execute("INSERT INTO h2 VALUES (1)")
    h=psycopg.connect(DSN); h.execute(f"BEGIN ISOLATION LEVEL {iso}")
    h.execute("SELECT * FROM h2")
    if write: h.execute("UPDATE h2 SET id=1 WHERE id=1")
    with psycopg.connect(DSN,autocommit=True) as c:
        c.execute("UPDATE h SET v=v+1"); c.execute("VACUUM h")
        d=dead(c)
    print(f"  {iso:16s} 有写入={write}: VACUUM 后残留死元组 {d}  {'→ 拖住了回收' if d>0 else '→ 没有拖住'}")
    h.rollback(); h.close()

print("\n=== count(*) 为什么慢：MVCC 下没有全局行数 ===")
with psycopg.connect(DSN,autocommit=True) as c:
    c.execute("DROP TABLE IF EXISTS big"); c.execute("CREATE TABLE big(id bigserial primary key, v int)")
    c.execute("INSERT INTO big(v) SELECT g FROM generate_series(1,3000000) g"); c.execute("ANALYZE big")
    for q,l in [("SELECT count(*) FROM big","精确 count(*)（VACUUM 前）"),]:
        t0=time.time(); n=c.execute(q).fetchone()[0]; print(f"  {l:32s} {n}  {time.time()-t0:.2f}s")
    c.execute("VACUUM big")   # 建立 visibility map
    t0=time.time(); n=c.execute("SELECT count(*) FROM big").fetchone()[0]; print(f"  {'精确 count(*)（VACUUM 后）':30s} {n}  {time.time()-t0:.2f}s")
    t0=time.time(); n=c.execute("SELECT reltuples::bigint FROM pg_class WHERE relname='big'").fetchone()[0]; print(f"  {'pg_class.reltuples 估算值':31s} {n}  {time.time()-t0:.4f}s")

print("\n=== advisory lock：让定时任务在多副本里只跑一份 ===")
a=psycopg.connect(DSN,autocommit=True); b=psycopg.connect(DSN,autocommit=True)
print("  实例A 抢锁:", a.execute("SELECT pg_try_advisory_lock(hashtext('cleanup_job'))").fetchone()[0])
print("  实例B 抢锁:", b.execute("SELECT pg_try_advisory_lock(hashtext('cleanup_job'))").fetchone()[0], " <- 直接返回 false，不阻塞")
a.execute("SELECT pg_advisory_unlock(hashtext('cleanup_job'))")
print("  A 释放后 B 再抢:", b.execute("SELECT pg_try_advisory_lock(hashtext('cleanup_job'))").fetchone()[0])
b.execute("SELECT pg_advisory_unlock(hashtext('cleanup_job'))"); a.close(); b.close()
