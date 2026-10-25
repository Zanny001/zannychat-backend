const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0050_own_status_view_counts.sql'), 'utf8');

test('status view count RPC aggregates rows in SQL and only returns the caller’s own statuses', () => {
  assert.match(migration, /returns table\s*\(status_id uuid, view_count bigint\)/i);
  assert.match(migration, /count\(v\.viewer_id\)::bigint/i);
  assert.match(migration, /s\.user_id = v_user_id/i);
  assert.match(migration, /auth\.uid\(\)/i);
});
test('status view count RPC validates authentication and bounded input', () => {
  assert.match(migration, /if v_user_id is null[\s\S]*?Authentication required/i);
  assert.match(migration, /cardinality\(p_status_ids\) > 200/i);
});
test('status view count RPC is not executable by anonymous or public roles', () => {
  assert.match(migration, /revoke all on function public\.get_own_status_view_counts\(uuid\[\]\) from public, anon/i);
  assert.match(migration, /grant execute on function public\.get_own_status_view_counts\(uuid\[\]\) to authenticated/i);
});
