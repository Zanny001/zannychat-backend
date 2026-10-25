const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('page-scoped poll aggregation enforces authentication, membership and bounded poll IDs', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0052_poll_vote_counts_scoped_to_page.sql'), 'utf8');
  assert.match(sql, /get_poll_vote_counts_for_ids\s*\(/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = public, pg_temp/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /conversation_participants/i);
  assert.match(sql, /cardinality\(p_poll_ids\) < 1 or cardinality\(p_poll_ids\) > 100/i);
  assert.match(sql, /All polls must belong to the requested conversation/i);
  assert.match(sql, /count\(v\.user_id\)::bigint/i);
  assert.match(sql, /revoke all on function .* from public, anon/i);
  assert.match(sql, /grant execute .* to authenticated/i);
});
