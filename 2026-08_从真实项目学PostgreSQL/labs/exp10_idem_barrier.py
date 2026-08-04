import psycopg, threading
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
N=8
def reset(unique):
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS users, dedup")
        c.execute("CREATE TABLE users(id int primary key, balance numeric)")
        c.execute("INSERT INTO users VALUES (1,1000)")
        c.execute("CREATE TABLE dedup(request_id text, api_key_id int)")
        if unique: c.execute("CREATE UNIQUE INDEX ON dedup(request_id, api_key_id)")
def sel_ins(req, b1, b2, errs):
    c = psycopg.connect(DSN)          # 先建好连接
    b1.wait()                         # 所有线程同时起跑
    try:
        c.execute("BEGIN")
        hit = c.execute("SELECT 1 FROM dedup WHERE request_id=%s AND api_key_id=1",(req,)).fetchone()
        b2.wait()                     # 关键：确保 8 个事务都做完了"查重"再往下走
        if hit: c.commit(); return
        c.execute("INSERT INTO dedup VALUES (%s,1)",(req,))
        c.execute("UPDATE users SET balance=balance-10 WHERE id=1")
        c.commit()
    except Exception as e:
        errs.append(str(e).splitlines()[0]); c.rollback()
    finally: c.close()
def run(unique,label):
    reset(unique); b1=threading.Barrier(N); b2=threading.Barrier(N); errs=[]
    ts=[threading.Thread(target=sel_ins,args=("req-abc",b1,b2,errs)) for _ in range(N)]
    [t.start() for t in ts]; [t.join() for t in ts]
    with psycopg.connect(DSN,autocommit=True) as c:
        bal=c.execute("SELECT balance FROM users WHERE id=1").fetchone()[0]
        n=c.execute("SELECT count(*) FROM dedup").fetchone()[0]
    ok = bal==990
    print(f"{label}\n   余额 {bal}（应为 990）  幂等表行数 {n}  被数据库挡下的事务 {len(errs)} 个 {set(errs) if errs else ''}")
    print(f"   {'✅ 只扣了一次' if ok else '❌ 重复扣款 '+str(int((1000-bal)/10))+' 次'}\n")
print(f"同一 request_id 并发重放 {N} 次；代码都是「先 SELECT 查重，没有则 INSERT + 扣款」\n（用 Barrier 保证 8 个事务确实在同一时刻完成了查重这一步）\n")
run(True,  "[B1] dedup 表上有唯一索引")
run(False, "[B2] dedup 表上没有唯一索引，只靠应用代码里的 SELECT 判断")
