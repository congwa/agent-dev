import psycopg, time
import os
DSN = os.environ.get("PG_DSN", "host=localhost port=5433 user=postgres password=pg dbname=postgres")
with psycopg.connect(DSN,autocommit=True) as c:
    c.execute("DROP TABLE IF EXISTS ob"); c.execute("CREATE TABLE ob(id bigserial primary key, msg text)")
print("=== 序列号是非事务的：id 先分配，事务后提交 ===")
slow=psycopg.connect(DSN)                       # 慢事务
slow.execute("INSERT INTO ob(msg) VALUES ('慢事务的消息')")
sid=slow.execute("SELECT currval('ob_id_seq')").fetchone()[0]
print(f"  慢事务已经拿到 id={sid}，但还没提交")
with psycopg.connect(DSN,autocommit=True) as fast:
    fast.execute("INSERT INTO ob(msg) VALUES ('快事务的消息')")
    fid=fast.execute("SELECT currval('ob_id_seq')").fetchone()[0]
print(f"  快事务拿到 id={fid}，并且已经提交")
with psycopg.connect(DSN,autocommit=True) as c:
    rows=c.execute("SELECT id,msg FROM ob ORDER BY id").fetchall()
    print(f"  此刻消费者看到: {rows}")
    hw=max(r[0] for r in rows)
    print(f"  ❌ 消费者把水位线推进到 {hw}，认为 <= {hw} 的都处理过了")
slow.commit(); slow.close()
with psycopg.connect(DSN,autocommit=True) as c:
    print(f"  慢事务提交后表里: {c.execute('SELECT id,msg FROM ob ORDER BY id').fetchall()}")
    print(f"  → id={sid} 这条消息【永远不会被消费】，因为水位线已经越过它了")

print("\n=== 序列不回滚：ROLLBACK 也会消耗序列号 ===")
with psycopg.connect(DSN,autocommit=True) as c:
    before=c.execute("SELECT last_value FROM ob_id_seq").fetchone()[0]
r=psycopg.connect(DSN); r.execute("INSERT INTO ob(msg) VALUES ('会被回滚')"); r.rollback(); r.close()
with psycopg.connect(DSN,autocommit=True) as c:
    after=c.execute("SELECT last_value FROM ob_id_seq").fetchone()[0]
    print(f"  回滚前序列 last_value={before}，回滚后={after}  → 序列号被消耗掉了，id 出现空洞")
    print("  推论：bigserial 主键【不能】拿来当'订单数量'或'保证连续的业务编号'")
