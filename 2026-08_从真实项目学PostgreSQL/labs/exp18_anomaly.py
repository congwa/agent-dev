import psycopg, threading, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
def reset():
    with psycopg.connect(DSN,autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS o")
        c.execute("CREATE TABLE o(id serial primary key, uid int, amt numeric)")
        c.execute("INSERT INTO o(uid,amt) VALUES (1,10),(1,20)")
def anomaly(iso):
    reset(); r={}
    a=psycopg.connect(DSN); a.execute(f"BEGIN ISOLATION LEVEL {iso}")
    r['不可重复读_第一次'] = a.execute("SELECT amt FROM o WHERE id=1").fetchone()[0]
    r['幻读_第一次行数']   = a.execute("SELECT count(*) FROM o WHERE uid=1").fetchone()[0]
    with psycopg.connect(DSN,autocommit=True) as b:
        b.execute("UPDATE o SET amt=999 WHERE id=1")     # 制造不可重复读
        b.execute("INSERT INTO o(uid,amt) VALUES (1,30)") # 制造幻读
    r['不可重复读_第二次'] = a.execute("SELECT amt FROM o WHERE id=1").fetchone()[0]
    r['幻读_第二次行数']   = a.execute("SELECT count(*) FROM o WHERE uid=1").fetchone()[0]
    a.rollback(); a.close()
    nrr = '出现' if r['不可重复读_第一次']!=r['不可重复读_第二次'] else '没有'
    ph  = '出现' if r['幻读_第一次行数']!=r['幻读_第二次行数'] else '没有'
    print(f"  {iso:16s} 不可重复读: {nrr}({r['不可重复读_第一次']}→{r['不可重复读_第二次']})   幻读: {ph}({r['幻读_第一次行数']}→{r['幻读_第二次行数']})")
print("=== 三种读异常在各隔离级别下的表现 ===")
for iso in ["READ UNCOMMITTED","READ COMMITTED","REPEATABLE READ","SERIALIZABLE"]:
    anomaly(iso)
print("\n  注：Postgres 没有真正的 READ UNCOMMITTED，它被当作 READ COMMITTED 处理（不存在脏读）")

print("\n=== SERIALIZABLE 的代价：冲突率随并发上升 ===")
def bench_ssi(threads):
    with psycopg.connect(DSN,autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS s"); c.execute("CREATE TABLE s(id int primary key, v int)")
        c.execute("INSERT INTO s SELECT g,0 FROM generate_series(1,10) g")
    stats={'ok':0,'retry':0}; lock=threading.Lock()
    def w():
        with psycopg.connect(DSN) as c:
            done=0
            while done<20:
                try:
                    c.execute("BEGIN ISOLATION LEVEL SERIALIZABLE")
                    t=c.execute("SELECT sum(v) FROM s").fetchone()[0]
                    c.execute("UPDATE s SET v=v+1 WHERE id=%s",(1+done%10,))
                    c.commit(); done+=1
                    with lock: stats['ok']+=1
                except Exception:
                    c.rollback()
                    with lock: stats['retry']+=1
    ts=[threading.Thread(target=w) for _ in range(threads)]
    t0=time.time(); [t.start() for t in ts]; [t.join() for t in ts]
    print(f"  {threads:2d} 并发: 成功 {stats['ok']}  重试 {stats['retry']}  重试率 {100*stats['retry']/(stats['ok']+stats['retry']):.0f}%  耗时 {time.time()-t0:.2f}s")
for n in [2,4,8,16]: bench_ssi(n)
