import psycopg, threading, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
# 场景：一个用户有两张卡，规则是"两张卡的余额之和不能为负"
def reset():
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS cards")
        c.execute("CREATE TABLE cards(id int primary key, uid int, bal numeric)")
        c.execute("INSERT INTO cards VALUES (1,7,100),(2,7,100)")

def run(iso):
    reset(); res={}
    def worker(card, tag):
        with psycopg.connect(DSN) as c:
            c.execute(f"BEGIN ISOLATION LEVEL {iso}")
            try:
                total=c.execute("SELECT sum(bal) FROM cards WHERE uid=7").fetchone()[0]
                time.sleep(0.4)                     # 两个事务都读到 200
                if total-150 >= 0:                  # 各自认为"扣 150 之后总额还有 50，安全"
                    c.execute("UPDATE cards SET bal=bal-150 WHERE id=%s",(card,))
                c.commit(); res[tag]='commit'
            except Exception as e:
                c.rollback(); res[tag]=str(e).splitlines()[0]
    ts=[threading.Thread(target=worker,args=a) for a in [(1,'T1'),(2,'T2')]]
    [t.start() for t in ts]; [t.join() for t in ts]
    with psycopg.connect(DSN,autocommit=True) as c:
        tot=c.execute("SELECT sum(bal) FROM cards WHERE uid=7").fetchone()[0]
    print(f"{iso:16s} -> {res}   两卡总额: {tot}   {'❌ 约束被打破' if tot<0 else '✅ 约束保住'}")

print("规则：两张卡余额之和不得为负。初始各 100，两个事务并发各扣 150。\n")
for iso in ["READ COMMITTED","REPEATABLE READ","SERIALIZABLE"]:
    run(iso)
