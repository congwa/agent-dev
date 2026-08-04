\pset border 2
DROP TABLE IF EXISTS bl;
CREATE TABLE bl(id int primary key, v int, pad text) WITH (autovacuum_enabled=off);
INSERT INTO bl SELECT g, 0, repeat('x',100) FROM generate_series(1,200000) g;
CREATE INDEX bl_v ON bl(v);
VACUUM ANALYZE bl;
SELECT pg_size_pretty(pg_relation_size('bl')) AS 表, pg_size_pretty(pg_relation_size('bl_pkey')) AS 主键, pg_size_pretty(pg_relation_size('bl_v')) AS v索引;

\echo '--- 全表 UPDATE 5 轮（v 有索引，HOT 失效）---'
DO $$ BEGIN FOR i IN 1..5 LOOP UPDATE bl SET v=v+1; END LOOP; END $$;
SELECT pg_size_pretty(pg_relation_size('bl')) AS 表, pg_size_pretty(pg_relation_size('bl_pkey')) AS 主键, pg_size_pretty(pg_relation_size('bl_v')) AS v索引;

\echo '--- VACUUM（空间可复用，但不还给 OS）---'
VACUUM bl;
SELECT pg_size_pretty(pg_relation_size('bl')) AS 表, pg_size_pretty(pg_relation_size('bl_pkey')) AS 主键, pg_size_pretty(pg_relation_size('bl_v')) AS v索引;

\echo '--- REINDEX 索引 ---'
REINDEX INDEX bl_pkey; REINDEX INDEX bl_v;
SELECT pg_size_pretty(pg_relation_size('bl_pkey')) AS 主键, pg_size_pretty(pg_relation_size('bl_v')) AS v索引;

\echo '--- VACUUM FULL（重写整表，需要 AccessExclusiveLock + 额外磁盘）---'
VACUUM FULL bl;
SELECT pg_size_pretty(pg_relation_size('bl')) AS 表, pg_size_pretty(pg_relation_size('bl_pkey')) AS 主键, pg_size_pretty(pg_relation_size('bl_v')) AS v索引;

\echo '=== TOAST：大字段被挪到副表 ==='
DROP TABLE IF EXISTS tt;
CREATE TABLE tt(id int primary key, small text, big text);
INSERT INTO tt SELECT g, 'abc', repeat(md5(g::text), 400) FROM generate_series(1,10000) g;
SELECT pg_size_pretty(pg_relation_size('tt')) AS 主表,
       pg_size_pretty(pg_relation_size(reltoastrelid)) AS TOAST表,
       pg_size_pretty(pg_total_relation_size('tt')) AS 总计
FROM pg_class WHERE relname='tt';
\echo '--- 只查 small 列，不会碰 TOAST ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT small FROM tt;
\echo '--- 查 big 列，要去 TOAST 表取 ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT length(big) FROM tt;
