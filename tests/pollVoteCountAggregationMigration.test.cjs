const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0051_poll_vote_count_aggregation.sql'), 'utf8');

test('poll vote aggregation counts in SQL and is scoped to conversation membership', () => {
  assert.match(migration, /returns table\s*\(poll_id uuid, option_id uuid, vote_count bigint\)/i);
  assert.match(migration, /count\(v\.user_id\)::bigint/i);
  assert.match(migration, /cp\.conversation_id = p_conversation_id and cp\.user_id = v_user_id/i);
  assert.match(migration, /auth\.uid\(\)/i);
});
test('poll vote aggregation rejects unauthenticated and non-member callers', () => {
  assert.match(migration, /if v_user_id is null[\s\S]*?Authentication required/i);
  assert.match(migration, /Conversation membership required/i);
});
test('poll vote aggregation is authenticated-only', () => {
  assert.match(migration, /revoke all on function public\.get_conversation_poll_vote_counts\(uuid\) from public, anon/i);
  assert.match(migration, /grant execute on function public\.get_conversation_poll_vote_counts\(uuid\) to authenticated/i);
});
