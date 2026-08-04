import psycopg, threading, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
def reset():
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS acc")
        c.execute("CREATE TABLE acc(id int primary key, bal numeric)")
        c.execute("INSERT INTO acc VALUES (1,100),(2,100)")
def transfer(order, tag, res):
    with psycopg.connect(DSN) as c:
        try:
            c.execute("BEGIN")
            for i in order:
                c.execute("UPDATE acc SET bal=bal+1 WHERE id=%s",(i,))
                time.sleep(0.3)
            c.commit(); res[tag]='commit'
        except Exception as e:
            c.rollback(); res[tag]=str(e).splitlines()[0]
def run(o1,o2,label):
    reset(); res={}
    ts=[threading.Thread(target=transfer,args=(o1,'T1',res)),threading.Thread(target=transfer,args=(o2,'T2',res))]
    [t.start() for t in ts]; [t.join() for t in ts]
    print(f"{label}\n   {res}\n")
run([1,2],[2,1],"[A] T1 按 1→2 加锁，T2 按 2→1 加锁（加锁顺序不一致）")
run([1,2],[1,2],"[B] 两边都按 id 升序加锁")
