\pset border 2
\echo '=== 用 float8 存钱 ==='
SELECT 0.1::float8 + 0.2::float8 AS sum, (0.1::float8+0.2::float8) = 0.3::float8 AS eq;
DROP TABLE IF EXISTS m1; CREATE TABLE m1(b float8);
INSERT INTO m1 VALUES (100.0);
DO $$ BEGIN FOR i IN 1..1000 LOOP UPDATE m1 SET b = b - 0.01; END LOOP; END $$;
SELECT b AS "扣 1000 次 0.01 后（float8）", b = 90.0 AS "等于 90 吗" FROM m1;
\echo '=== 用 numeric 存钱 ==='
DROP TABLE IF EXISTS m2; CREATE TABLE m2(b numeric(20,6));
INSERT INTO m2 VALUES (100.0);
DO $$ BEGIN FOR i IN 1..1000 LOOP UPDATE m2 SET b = b - 0.01; END LOOP; END $$;
SELECT b AS "扣 1000 次 0.01 后（numeric）", b = 90.0 AS "等于 90 吗" FROM m2;
\echo
\echo '=== numeric 的坑：精度不够时会四舍五入，微小扣费直接变成 0 ==='
SELECT 100::numeric(20,2) - 0.004 AS "numeric(20,2) 扣 0.004", (100::numeric(20,2) - 0.004)::numeric(20,2) AS "存回列里";
SELECT 100::numeric(20,6) - 0.000004 AS "numeric(20,6) 扣 0.000004";
