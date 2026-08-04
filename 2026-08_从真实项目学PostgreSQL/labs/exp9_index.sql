\pset border 2
DROP TABLE IF EXISTS usage_logs;
CREATE TABLE usage_logs(
  id bigserial primary key, user_id bigint, api_key_id bigint,
  created_at timestamptz, cost numeric(20,6), deleted_at timestamptz, model text);
INSERT INTO usage_logs(user_id, api_key_id, created_at, cost, deleted_at, model)
SELECT (random()*5000)::int, (random()*20000)::int,
       now() - (random()*90||' days')::interval, random(),
       CASE WHEN random()<0.98 THEN NULL ELSE now() END,
       (ARRAY['gpt','claude','gemini'])[1+(random()*2)::int]
FROM generate_series(1,1000000);
ANALYZE usage_logs;
SELECT pg_size_pretty(pg_relation_size('usage_logs')) AS table_size;

\echo '=== 无索引：查某用户最近 7 天用量 ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT sum(cost) FROM usage_logs WHERE user_id=42 AND created_at > now()-interval '7 days' AND deleted_at IS NULL;

\echo '=== 单列索引 user_id ==='
CREATE INDEX i1 ON usage_logs(user_id);
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT sum(cost) FROM usage_logs WHERE user_id=42 AND created_at > now()-interval '7 days' AND deleted_at IS NULL;

\echo '=== 复合索引 (user_id, created_at) 且带 partial 条件 ==='
CREATE INDEX i2 ON usage_logs(user_id, created_at) WHERE deleted_at IS NULL;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT sum(cost) FROM usage_logs WHERE user_id=42 AND created_at > now()-interval '7 days' AND deleted_at IS NULL;

\echo '=== 覆盖索引 INCLUDE(cost) → Index Only Scan ==='
CREATE INDEX i3 ON usage_logs(user_id, created_at) INCLUDE (cost) WHERE deleted_at IS NULL;
VACUUM ANALYZE usage_logs;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT sum(cost) FROM usage_logs WHERE user_id=42 AND created_at > now()-interval '7 days' AND deleted_at IS NULL;

\echo '=== 列顺序搞反了：(created_at, user_id) ==='
DROP INDEX i1,i2,i3;
CREATE INDEX i4 ON usage_logs(created_at, user_id);
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT sum(cost) FROM usage_logs WHERE user_id=42 AND created_at > now()-interval '7 days' AND deleted_at IS NULL;

\echo '=== 索引大小对比 ==='
DROP INDEX i4;
CREATE INDEX i_full ON usage_logs(user_id, created_at);
CREATE INDEX i_part ON usage_logs(user_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX i_brin ON usage_logs USING brin(created_at);
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_stat_user_indexes WHERE relname='usage_logs' ORDER BY 1;
