import psycopg, time, threading
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
with psycopg.connect(DSN,autocommit=True) as c:
    for k in ['max_connections','shared_buffers','work_mem','idle_in_transaction_session_timeout','statement_timeout','lock_timeout','deadlock_timeout','default_transaction_isolation']:
        print(f"  {k:38s} = {c.execute('SHOW '+k).fetchone()[0]}")
print()
# 每个连接的固定开销
with psycopg.connect(DSN,autocommit=True) as c:
    b=c.execute("SELECT count(*) FROM pg_stat_activity").fetchone()[0]
conns=[psycopg.connect(DSN) for _ in range(50)]
for x in conns: x.execute("SELECT 1")
with psycopg.connect(DSN,autocommit=True) as c:
    print("  开 50 个连接后 pg_stat_activity 行数:", c.execute("SELECT count(*) FROM pg_stat_activity").fetchone()[0], f"(基线 {b})")
    print("  后端进程数:", c.execute("SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend'").fetchone()[0])
[x.close() for x in conns]

print("\n--- 打满 max_connections 会发生什么 ---")
alive=[]
try:
    for i in range(200):
        alive.append(psycopg.connect(DSN))
except Exception as e:
    print(f"  开到第 {len(alive)} 个连接时: {str(e).splitlines()[0]}")
    print("  → 此时新的业务请求、监控、甚至运维想连上去救火，全都连不上")
[x.close() for x in alive]

print("\n--- idle in transaction 的杀伤力 ---")
h=psycopg.connect(DSN); h.execute("BEGIN"); h.execute("SELECT 1")
time.sleep(0.5)
with psycopg.connect(DSN,autocommit=True) as c:
    r=c.execute("SELECT state, xact_start IS NOT NULL AS holds_xact, backend_xmin IS NOT NULL AS holds_snapshot FROM pg_stat_activity WHERE state='idle in transaction'").fetchall()
    print("  ", r)
h.rollback(); h.close()
