import psycopg, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
def sz(c,t): return c.execute("SELECT pg_size_pretty(pg_relation_size(%s))",(t,)).fetchone()[0]
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("DROP TABLE IF EXISTS bloat")
    c.execute("CREATE TABLE bloat(id int primary key, v int) WITH (autovacuum_enabled=off)")
    c.execute("INSERT INTO bloat SELECT g,0 FROM generate_series(1,50000) g")
    print("初始大小:", sz(c,'bloat'))

    # 场景一：没有长事务
    c.execute("UPDATE bloat SET v=v+1")
    print("全表 UPDATE 一次后:", sz(c,'bloat'))
    c.execute("VACUUM bloat")
    c.execute("UPDATE bloat SET v=v+1")
    c.execute("VACUUM bloat")
    c.execute("UPDATE bloat SET v=v+1")
    c.execute("VACUUM bloat")
    print("再 UPDATE 3 轮 + 每轮 VACUUM:", sz(c,'bloat'), "  <- 空间被回收复用，表不再长大")

    # 场景二：有一个一直不提交的只读长事务
    hold = psycopg.connect(DSN)
    hold.execute("BEGIN ISOLATION LEVEL REPEATABLE READ")
    hold.execute("SELECT count(*) FROM bloat")     # 拿住一个快照，不提交
    for _ in range(3):
        c.execute("UPDATE bloat SET v=v+1")
        c.execute("VACUUM bloat")
    print("同样 3 轮，但有一个开着的长事务:", sz(c,'bloat'), "  <- VACUUM 不敢回收，表持续膨胀")
    r=c.execute("""SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='bloat'""").fetchone()
    print("   此时死元组数:", r[0])
    r=c.execute("""SELECT max(age(backend_xmin)) FROM pg_stat_activity WHERE backend_xmin IS NOT NULL""").fetchone()
    print("   最老快照落后多少个事务 (age(backend_xmin)):", r[0])
    hold.rollback(); hold.close()
    c.execute("VACUUM bloat")
    print("长事务结束后再 VACUUM:", sz(c,'bloat'), "  <- 空间可复用了，但已经膨胀的部分不会自动还给操作系统")
