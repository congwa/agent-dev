\pset border 2
DROP TABLE IF EXISTS acct;
CREATE TABLE acct(id bigint primary key, balance numeric, note text) WITH (autovacuum_enabled=off);
INSERT INTO acct VALUES (1, 100, 'x');
SELECT ctid, xmin, xmax, balance FROM acct;
UPDATE acct SET balance=balance-1 WHERE id=1;
SELECT ctid, xmin, xmax, balance FROM acct;
UPDATE acct SET balance=balance-1 WHERE id=1;
SELECT ctid, xmin, xmax, balance FROM acct;
\echo '--- 表里其实有几个版本 (关掉可见性判断看物理行) ---'
CREATE EXTENSION IF NOT EXISTS pageinspect;
SELECT lp, t_ctid, t_xmin, t_xmax FROM heap_page_items(get_raw_page('acct',0));
\echo '--- 连续 UPDATE 1 万次后的表大小 (无 vacuum) ---'
DO $$ BEGIN FOR i IN 1..10000 LOOP UPDATE acct SET balance=balance+1 WHERE id=1; END LOOP; END $$;
SELECT pg_size_pretty(pg_relation_size('acct')) AS heap_size, (SELECT count(*) FROM acct) AS live_rows;
SELECT n_tup_upd, n_tup_hot_upd, n_dead_tup FROM pg_stat_user_tables WHERE relname='acct';
\echo '--- VACUUM 之后 ---'
VACUUM acct;
SELECT pg_size_pretty(pg_relation_size('acct')) AS heap_size_after_vacuum;
