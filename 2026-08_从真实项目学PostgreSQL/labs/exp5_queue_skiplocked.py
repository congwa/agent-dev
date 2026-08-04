import psycopg, threading, time, collections
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
def reset(n=64):
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS jobs")
        c.execute("CREATE TABLE jobs(id bigserial primary key, state text default 'ready', worker text)")
        c.execute("INSERT INTO jobs(state) SELECT 'ready' FROM generate_series(1,%s)", (n,))

def bench(clause, label, workers=8, hold=0.05):
    reset(); claims=collections.Counter(); t0=time.time()
    def w(name):
        with psycopg.connect(DSN) as c:
            while True:
                c.execute("BEGIN")
                cur=c.execute(f"""WITH c AS (SELECT id FROM jobs WHERE state='ready' ORDER BY id LIMIT 1 {clause})
                    UPDATE jobs j SET state='running', worker=%s FROM c WHERE j.id=c.id RETURNING j.id""",(name,))
                rows=cur.fetchall()
                if not rows: c.commit(); break
                time.sleep(hold)          # 事务里处理任务
                c.commit(); claims[name]+=len(rows)
    ts=[threading.Thread(target=w,args=(f"w{i}",)) for i in range(workers)]
    [t.start() for t in ts]; [t.join() for t in ts]
    total=sum(claims.values())
    print(f"{label}\n   墙钟耗时 {time.time()-t0:.2f}s   任务被领取次数合计 {total}（表里只有 64 个任务）   重复执行 {total-64} 次\n")

bench("FOR UPDATE SKIP LOCKED", "[A] FOR UPDATE SKIP LOCKED —— 抢不到就跳过下一行")
bench("FOR UPDATE",             "[B] FOR UPDATE —— 抢不到就排队等")
bench("",                       "[C] 不加行锁")
