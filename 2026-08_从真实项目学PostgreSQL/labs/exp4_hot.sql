\pset border 2
\echo '=== A: balance 上没有索引 ==='
DROP TABLE IF EXISTS a1; CREATE TABLE a1(id bigint primary key, balance numeric) WITH (autovacuum_enabled=off, fillfactor=90);
INSERT INTO a1 VALUES (1,0);
DO $$ BEGIN FOR i IN 1..5000 LOOP UPDATE a1 SET balance=balance+1 WHERE id=1; END LOOP; END $$;
SELECT n_tup_upd, n_tup_hot_upd, round(100.0*n_tup_hot_upd/n_tup_upd,1) AS hot_pct FROM pg_stat_user_tables WHERE relname='a1';
SELECT pg_size_pretty(pg_relation_size('a1')) heap, pg_size_pretty(pg_relation_size('a1_pkey')) pk_index;

\echo '=== B: balance 上建了索引（更新的列被索引 → HOT 失效）==='
DROP TABLE IF EXISTS a2; CREATE TABLE a2(id bigint primary key, balance numeric) WITH (autovacuum_enabled=off, fillfactor=90);
CREATE INDEX ON a2(balance);
INSERT INTO a2 VALUES (1,0);
DO $$ BEGIN FOR i IN 1..5000 LOOP UPDATE a2 SET balance=balance+1 WHERE id=1; END LOOP; END $$;
SELECT n_tup_upd, n_tup_hot_upd, round(100.0*n_tup_hot_upd/n_tup_upd,1) AS hot_pct FROM pg_stat_user_tables WHERE relname='a2';
SELECT pg_size_pretty(pg_relation_size('a2')) heap, pg_size_pretty(pg_relation_size('a2_pkey')) pk_index, pg_size_pretty(pg_relation_size('a2_balance_idx')) bal_index;
