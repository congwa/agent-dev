\pset border 2
DROP TABLE IF EXISTS users2;
CREATE TABLE users2(id bigserial primary key, email text, username text, created_at timestamptz, extra jsonb, deleted_at timestamptz);
INSERT INTO users2(email, username, created_at, extra, deleted_at)
SELECT 'User.'||g||'@Example.com', 'user_'||g, now()-(random()*365||' days')::interval,
       jsonb_build_object('plan', (ARRAY['free','pro','max'])[1+(random()*2)::int], 'region','cn-'||(g%10)),
       CASE WHEN random()<0.02 THEN now() ELSE NULL END
FROM generate_series(1,500000) g;
CREATE INDEX ON users2(email);
ANALYZE users2;

\echo '=== ❌ 列上套函数，索引失效 ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT id FROM users2 WHERE lower(email)='user.42@example.com';
\echo '=== ✅ 表达式索引 ==='
CREATE INDEX ON users2(lower(email));
ANALYZE users2;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT id FROM users2 WHERE lower(email)='user.42@example.com';

\echo '=== LIKE 前缀匹配：默认 collation 下 B-tree 用不上，需要 text_pattern_ops ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT id FROM users2 WHERE email LIKE 'User.42%';
CREATE INDEX ON users2(email text_pattern_ops);
ANALYZE users2;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT id FROM users2 WHERE email LIKE 'User.42%';

\echo '=== 中间模糊匹配 %xx%：B-tree 完全无能为力，要 pg_trgm GIN ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT id FROM users2 WHERE email LIKE '%42@exam%';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ON users2 USING gin(email gin_trgm_ops);
ANALYZE users2;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT id FROM users2 WHERE email LIKE '%42@exam%';

\echo '=== JSONB 查询：GIN 索引 ==='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT count(*) FROM users2 WHERE extra @> '{"plan":"max"}';
CREATE INDEX ON users2 USING gin(extra jsonb_path_ops);
ANALYZE users2;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT count(*) FROM users2 WHERE extra @> '{"plan":"max"}';

\echo '=== 索引大小 ==='
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_stat_user_indexes WHERE relname='users2' ORDER BY pg_relation_size(indexrelid) DESC;
SELECT pg_size_pretty(pg_relation_size('users2')) AS 表大小, pg_size_pretty(pg_indexes_size('users2')) AS 索引总大小;
