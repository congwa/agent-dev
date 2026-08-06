#!/usr/bin/env bash
# 第 5 篇 · 实验 31：锁表是定长的，撑爆它长什么样
#
# 锁表槽位数 = max_locks_per_transaction × (max_connections + max_prepared_transactions)
# 这不是"每个事务最多 N 把锁"的硬限制，而是算总容量用的乘数 —— 全实例共用这个池子。
#
# 为了几秒钟就复现，这里起一个用完即扔的小集群：把乘数调到最小，
# 然后让一个事务一张一张地摸表，看它在第几张表上报 "out of shared memory"。
set -u

DATADIR=$(mktemp -d /tmp/pglock_lab.XXXXXX)
PORT=54329
trap 'pg_ctl -D "$DATADIR" -mimmediate stop >/dev/null 2>&1; rm -rf "$DATADIR"' EXIT

echo "=== 1) 起一个 max_locks_per_transaction=10, max_connections=10 的小集群 ==="
initdb -D "$DATADIR" -U lab --no-sync >/dev/null 2>&1
cat >> "$DATADIR/postgresql.conf" <<EOF
port = $PORT
listen_addresses = ''
unix_socket_directories = '$DATADIR'
max_connections = 10
max_locks_per_transaction = 10
max_prepared_transactions = 0
EOF
pg_ctl -D "$DATADIR" -l "$DATADIR/log" start >/dev/null
PSQL="psql -h $DATADIR -p $PORT -U lab -d postgres -X -q"

$PSQL -Atc "SELECT '按公式算出来的锁表槽位 = ' ||
  current_setting('max_locks_per_transaction')::int *
  (current_setting('max_connections')::int +
   current_setting('max_prepared_transactions')::int)"

echo
echo "=== 2) 建 3000 张空表（等一下） ==="
$PSQL -Atc "SELECT 'CREATE TABLE t'||i||'(id int);' FROM generate_series(1,3000) i" \
  | $PSQL -f - >/dev/null 2>&1
$PSQL -Atc "SELECT '  建好了 ' || count(*) || ' 张' FROM pg_class WHERE relname ~ '^t[0-9]+$'"

echo
echo "=== 3) 一个事务里一张一张摸过去，看第几张表上炸 ==="
$PSQL -At <<'SQL' 2>&1
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..3000 LOOP
    BEGIN
      EXECUTE format('SELECT * FROM t%s', i);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '摸到第 % 张表时失败', i;
      RAISE NOTICE '错误: %', SQLERRM;
      RETURN;
    END;
  END LOOP;
  RAISE NOTICE '3000 张全摸完了也没炸';
END $$;
SQL

echo
echo "=== 4) 前 16 把弱锁走 fast path，根本不进锁表 ==="
$PSQL -At <<'SQL'
BEGIN;
DO $$ DECLARE i int; BEGIN
  FOR i IN 1..25 LOOP EXECUTE format('SELECT * FROM t%s', i); END LOOP;
END $$;
SELECT '  fastpath=' || fastpath || ' 的 relation 锁: ' || count(*)
FROM pg_locks WHERE locktype='relation' AND pid = pg_backend_pid()
GROUP BY fastpath ORDER BY 1;
COMMIT;
SQL
