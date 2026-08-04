import psycopg, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
def reset(n=2000000):
    with psycopg.connect(DSN,autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS d CASCADE")
        c.execute("CREATE TABLE d(id bigserial primary key, v int NOT NULL, s text)")
        c.execute("INSERT INTO d(v,s) SELECT g, 'x'||g FROM generate_series(1,%s) g",(n,))
        c.execute("ANALYZE d")
def t(c,sql,label):
    t0=time.time()
    try:
        c.execute(sql); print(f"  {label:52s} {time.time()-t0:7.2f}s")
    except Exception as e: print(f"  {label:52s} ERROR {str(e).splitlines()[0][:40]}")
reset()
print("=== 各种 ALTER 的真实代价（200 万行）===")
with psycopg.connect(DSN,autocommit=True) as c:
    t(c,"ALTER TABLE d ADD COLUMN c1 int","ADD COLUMN（无默认值）")
    t(c,"ALTER TABLE d ADD COLUMN c2 int DEFAULT 42","ADD COLUMN DEFAULT 常量（PG11+ 免重写）")
    t(c,"ALTER TABLE d ADD COLUMN c3 uuid DEFAULT gen_random_uuid()","ADD COLUMN DEFAULT 易变函数（必须重写）")
    t(c,"ALTER TABLE d ALTER COLUMN s SET NOT NULL","SET NOT NULL（全表校验）")
    t(c,"ALTER TABLE d ADD CONSTRAINT ck CHECK (v > 0)","ADD CHECK（全表校验，持排他锁）")
    c.execute("ALTER TABLE d DROP CONSTRAINT ck")
    t(c,"ALTER TABLE d ADD CONSTRAINT ck2 CHECK (v > 0) NOT VALID","ADD CHECK ... NOT VALID（不校验，秒回）")
    t(c,"ALTER TABLE d VALIDATE CONSTRAINT ck2","VALIDATE CONSTRAINT（弱锁，可在线）")
    t(c,"ALTER TABLE d ALTER COLUMN v TYPE bigint","ALTER TYPE int→bigint（全表重写）")
    t(c,"ALTER TABLE d RENAME COLUMN s TO s2","RENAME COLUMN（只改元数据）")
    t(c,"ALTER TABLE d DROP COLUMN c1","DROP COLUMN（只改元数据，空间不回收）")
print("\n=== 锁级别对比 ===")
reset(100000)
with psycopg.connect(DSN,autocommit=True) as probe:
    for sql in ["ALTER TABLE d ADD COLUMN z int",
                "ALTER TABLE d ADD CONSTRAINT c9 CHECK (v>0) NOT VALID",
                "ALTER TABLE d VALIDATE CONSTRAINT c9",
                "CREATE INDEX i9 ON d(v)",
                "CREATE INDEX CONCURRENTLY i10 ON d(s)"]:
        h=psycopg.connect(DSN, autocommit=("CONCURRENTLY" in sql))
        try:
            if "CONCURRENTLY" not in sql: h.execute("BEGIN")
            h.execute(sql)
            m=probe.execute("""SELECT string_agg(DISTINCT mode,',') FROM pg_locks l JOIN pg_stat_activity a USING(pid)
                               WHERE a.pid<>pg_backend_pid() AND l.relation='d'::regclass""").fetchone()[0]
            print(f"  {sql:54s} → {m}")
        except Exception as e: print(f"  {sql:54s} → {str(e).splitlines()[0][:40]}")
        try: h.rollback()
        except Exception: pass
        h.close()
