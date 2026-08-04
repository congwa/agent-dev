import psycopg, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
with psycopg.connect(DSN,autocommit=True) as s:
    s.execute("DROP TABLE IF EXISTS sn"); s.execute("CREATE TABLE sn(id int primary key, v int)")
    s.execute("INSERT INTO sn VALUES (1,100)")
print("=== 同一个事务里，READ COMMITTED 每条语句取一个新快照 ===")
a=psycopg.connect(DSN); a.execute("BEGIN ISOLATION LEVEL READ COMMITTED")
print("  A 第一次读:", a.execute("SELECT v FROM sn WHERE id=1").fetchone()[0], " 快照:", a.execute("SELECT pg_current_snapshot()").fetchone()[0])
with psycopg.connect(DSN,autocommit=True) as b: b.execute("UPDATE sn SET v=200 WHERE id=1")
print("  (另一个事务把 v 改成 200 并提交)")
print("  A 第二次读:", a.execute("SELECT v FROM sn WHERE id=1").fetchone()[0], " 快照:", a.execute("SELECT pg_current_snapshot()").fetchone()[0], " <- 变了：不可重复读")
a.rollback(); a.close()

with psycopg.connect(DSN,autocommit=True) as s: s.execute("UPDATE sn SET v=100 WHERE id=1")
print("\n=== REPEATABLE READ：整个事务共用第一条语句时取的快照 ===")
a=psycopg.connect(DSN); a.execute("BEGIN ISOLATION LEVEL REPEATABLE READ")
print("  A 第一次读:", a.execute("SELECT v FROM sn WHERE id=1").fetchone()[0], " 快照:", a.execute("SELECT pg_current_snapshot()").fetchone()[0])
with psycopg.connect(DSN,autocommit=True) as b: b.execute("UPDATE sn SET v=200 WHERE id=1")
print("  (另一个事务把 v 改成 200 并提交)")
print("  A 第二次读:", a.execute("SELECT v FROM sn WHERE id=1").fetchone()[0], " 快照:", a.execute("SELECT pg_current_snapshot()").fetchone()[0], " <- 没变：可重复读")
a.rollback(); a.close()

print("\n=== 快照长什么样：xmin:xmax:活跃事务列表 ===")
h1=psycopg.connect(DSN); h1.execute("BEGIN"); h1.execute("INSERT INTO sn VALUES (99,1)")   # 占一个 xid 不提交
h2=psycopg.connect(DSN); h2.execute("BEGIN"); h2.execute("INSERT INTO sn VALUES (98,1)")
with psycopg.connect(DSN,autocommit=True) as c:
    print("  当前快照:", c.execute("SELECT pg_current_snapshot()").fetchone()[0])
    print("  解读: 冒号前是 xmin(小于它的事务都已结束)，中间是 xmax(大于等于它的都还没开始)，")
    print("        最后是 xmin~xmax 之间仍在运行、因此对我不可见的事务号列表")
h1.rollback(); h2.rollback(); h1.close(); h2.close()
