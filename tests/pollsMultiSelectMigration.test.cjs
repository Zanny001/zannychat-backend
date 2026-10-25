const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0053_multi_select_polls.sql'), 'utf8');

test('multi-select migration adds a backwards-compatible poll mode and composite vote key', () => {
  assert.match(sql, /add column if not exists allow_multiple boolean not null default false/i);
  assert.match(sql, /primary key \(poll_id, user_id, option_id\)/i);
});
test('multi-select vote RPC enforces membership, open state, option ownership, uniqueness and limits', () => {
  assert.match(sql, /p_option_ids uuid\[\]/i);
  assert.match(sql, /cardinality\(p_option_ids\) < 1 or cardinality\(p_option_ids\) > 10/i);
  assert.match(sql, /count\(distinct x\).*cardinality\(p_option_ids\)/is);
  assert.match(sql, /p\.closes_at is null or p\.closes_at > now\(\)/i);
  assert.match(sql, /v_option_count <> cardinality\(p_option_ids\)/i);
  assert.match(sql, /not v_allow_multiple and cardinality\(p_option_ids\) <> 1/i);
});
test('aggregate RPC returns per-option counts, unique voter totals and only caller-owned selection state', () => {
  assert.match(sql, /selected_by_me boolean, voter_count bigint/i);
  assert.match(sql, /count\(distinct v\.user_id\)/i);
  assert.match(sql, /bool_or\(v\.user_id = v_user_id\)/i);
  assert.match(sql, /all polls must belong to the requested conversation/i);
});
test('multi-select RPCs are not executable by anonymous or public roles', () => {
  assert.match(sql, /revoke all on function public\.cast_poll_vote\(uuid, uuid\[\]\) from public, anon/i);
  assert.match(sql, /create function public\.cast_poll_vote\(p_poll_id uuid, p_option_id uuid\)/i);
  assert.match(sql, /create function public\.create_conversation_poll\(p_conversation_id uuid, p_question text, p_options text\[\], p_closes_at timestamptz default null\)/i);
  assert.match(sql, /grant execute on function public\.cast_poll_vote\(uuid, uuid\[\]\) to authenticated/i);
});
