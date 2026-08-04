import psycopg, threading, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
print("=== idle in transaction 到底占着什么 ===")
def probe(iso, do_write):
    with psycopg.connect(DSN,autocommit=True) as s:
        s.execute("DROP TABLE IF EXISTS p"); s.execute("CREATE TABLE p(id int primary key, v int)")
        s.execute("INSERT INTO p VALUES (1,1)")
    h=psycopg.connect(DSN); h.execute(f"BEGIN ISOLATION LEVEL {iso}")
    h.execute("SELECT * FROM p")
    if do_write: h.execute("UPDATE p SET v=v+1 WHERE id=1")
    time.sleep(0.3)
    with psycopg.connect(DSN,autocommit=True) as c:
        r=c.execute("""SELECT state, backend_xid IS NOT NULL AS 占用事务号,
                              backend_xmin IS NOT NULL AS 卡住快照
                       FROM pg_stat_activity WHERE state LIKE 'idle in trans%'""").fetchone()
        locks=c.execute("""SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING(pid)
                           WHERE a.state LIKE 'idle in trans%' AND l.relation='p'::regclass""").fetchone()[0]
    print(f"  {iso:16s} 只读={not do_write}: 占用事务号={r[1]}  卡住快照={r[2]}  持有 p 表上的锁={locks} 个")
    h.rollback(); h.close()
probe("READ COMMITTED", False); probe("READ COMMITTED", True)
probe("REPEATABLE READ", False); probe("REPEATABLE READ", True)

print("\n=== ALTER TABLE 排在长查询后面 → 把整张表的读写全堵死 ===")
with psycopg.connect(DSN,autocommit=True) as s:
    s.execute("DROP TABLE IF EXISTS q"); s.execute("CREATE TABLE q(id bigserial primary key, v int)")
    s.execute("INSERT INTO q(v) SELECT g FROM generate_series(1,200000) g")
slow=psycopg.connect(DSN); slow.execute("BEGIN"); slow.execute("SELECT count(*) FROM q")  # 一个开着不提交的读事务
res={}
def ddl():
    with psycopg.connect(DSN,autocommit=True) as c:
        t0=time.time(); c.execute("ALTER TABLE q ADD COLUMN newcol int"); res['ddl']=time.time()-t0
def reader():
    time.sleep(0.5)
    with psycopg.connect(DSN,autocommit=True) as c:
        t0=time.time(); c.execute("SELECT v FROM q WHERE id=1"); res['select']=time.time()-t0
t1=threading.Thread(target=ddl); t2=threading.Thread(target=reader)
t1.start(); time.sleep(0.2); t2.start()
time.sleep(2.0)
with psycopg.connect(DSN,autocommit=True) as c:
    w=c.execute("""SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock'""").fetchone()[0]
    print(f"  此刻正在等锁的会话数: {w}")
    print("  等锁明细:", c.execute("""SELECT left(query,45), wait_event_type FROM pg_stat_activity WHERE wait_event_type='Lock'""").fetchall())
slow.rollback(); slow.close(); t1.join(); t2.join()
print(f"  长查询一提交，ALTER 才拿到锁：ALTER 等了 {res['ddl']:.1f}s，一条本该 1ms 的普通 SELECT 被连坐了 {res['select']:.1f}s")
