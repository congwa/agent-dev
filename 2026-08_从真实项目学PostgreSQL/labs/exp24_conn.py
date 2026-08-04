import psycopg, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
print("=== 建立连接的成本 ===")
N=100
t0=time.time()
for _ in range(N):
    c=psycopg.connect(DSN); c.execute("SELECT 1"); c.close()
per=(time.time()-t0)/N*1000
print(f"  每次「新建连接 + 一条 SELECT 1 + 关闭」: {per:.2f} ms")
c=psycopg.connect(DSN, autocommit=True)
t0=time.time()
for _ in range(N): c.execute("SELECT 1")
per2=(time.time()-t0)/N*1000
print(f"  复用连接，每条 SELECT 1:                 {per2:.3f} ms")
print(f"  → 建连接的固定开销约是一次简单查询的 {per/per2:.0f} 倍（本机 unix socket，跨网络会更夸张）")
c.close()

print("\n=== 连接数与吞吐：不是越多越好 ===")
import threading
def bench(n_conn, total=2000):
    per_thread=total//n_conn
    def w():
        with psycopg.connect(DSN,autocommit=True) as c:
            for _ in range(per_thread):
                c.execute("SELECT sum(i) FROM generate_series(1,2000) i")
    ts=[threading.Thread(target=w) for _ in range(n_conn)]
    t0=time.time(); [t.start() for t in ts]; [t.join() for t in ts]
    dt=time.time()-t0
    return total/dt
import os
print(f"  (本机 CPU 核数: {os.cpu_count()})")
for n in [1,2,4,8,16,32,64]:
    print(f"  {n:2d} 个并发连接: {bench(n):7.0f} 查询/秒")
