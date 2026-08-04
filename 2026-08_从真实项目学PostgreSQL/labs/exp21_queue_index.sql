\pset border 2
DROP TABLE IF EXISTS jobs;
CREATE TABLE jobs(id bigserial primary key, queue text, state text, priority int, scheduled_at timestamptz, payload jsonb);
-- 100 万个任务，其中只有 500 个是待处理的（真实队列就长这样：绝大多数已完成）
INSERT INTO jobs(queue,state,priority,scheduled_at)
SELECT 'default', 'completed', 1, now()-interval '1 day' FROM generate_series(1,1000000);
INSERT INTO jobs(queue,state,priority,scheduled_at)
SELECT 'default', 'available', 1+(random()*3)::int, now()-interval '1 minute' FROM generate_series(1,500);
ANALYZE jobs;

\echo '=== 无索引 ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs WHERE state='available' AND queue='default' AND scheduled_at<=now()
ORDER BY priority, scheduled_at, id LIMIT 10 FOR UPDATE SKIP LOCKED;

\echo '=== river 的索引：(state, queue, priority, scheduled_at, id) ==='
CREATE INDEX river_style ON jobs(state, queue, priority, scheduled_at, id);
ANALYZE jobs;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs WHERE state='available' AND queue='default' AND scheduled_at<=now()
ORDER BY priority, scheduled_at, id LIMIT 10 FOR UPDATE SKIP LOCKED;

\echo '=== 部分索引：只索引待处理的行 ==='
DROP INDEX river_style;
CREATE INDEX partial_style ON jobs(queue, priority, scheduled_at, id) WHERE state='available';
ANALYZE jobs;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
SELECT id FROM jobs WHERE state='available' AND queue='default' AND scheduled_at<=now()
ORDER BY priority, scheduled_at, id LIMIT 10 FOR UPDATE SKIP LOCKED;

\echo '=== 索引大小对比 ==='
CREATE INDEX river_style ON jobs(state, queue, priority, scheduled_at, id);
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes WHERE relname='jobs' ORDER BY 1;
