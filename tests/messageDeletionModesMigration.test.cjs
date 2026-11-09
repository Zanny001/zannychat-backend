const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0065_message_deletion_modes.sql'), 'utf8');

function deletionBody(source) {
  const start = source.search(/create\s+or\s+replace\s+function\s+public\.delete_message\s*\(/i);
  assert.notEqual(start, -1, 'delete_message function must exist');
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, 'delete_message body must terminate');
  return source.slice(start, end);
}

test('message hiding migration safely reruns over an existing deployment', () => {
  assert.match(sql, /create table if not exists public\.message_hidden_for/i);
  assert.match(sql, /drop policy if exists "Users can read their own message hides"/i);
  assert.match(sql, /drop policy if exists "Members can read visible messages in their conversations"/i);
  assert.match(sql, /primary key \(message_id, user_id\)/i);
  assert.match(sql, /user_id = \(select auth\.uid\(\)\)/i);
});

test('global deletion is authenticated, participant-scoped, sender-only, and rejects repeat retraction', () => {
  const body = deletionBody(sql);
  assert.match(body, /security definer/i);
  assert.match(body, /set search_path = ''/i);
  assert.match(body, /m\.id = p_message_id/i);
  assert.match(body, /m\.conversation_id/i);
  assert.match(body, /v_message\.sender_id is distinct from v_user_id/i);
  assert.match(body, /v_message\.deleted_at is not null/i);
  assert.match(body, /p_mode is null or p_mode not in/i);
  assert.match(sql, /grant execute on function public\.delete_message\(uuid, text\) to authenticated/i);
  assert.match(sql, /revoke all on function public\.delete_message\(uuid, text\) from public, anon, authenticated/i);
  assert.match(sql, /revoke update \(deleted_at\) on public\.messages from authenticated/i);
});

test('global deletion clears all message payload fields and preserves a tombstone', () => {
  const body = deletionBody(sql);
  for (const column of ['text = \'\'', 'media_url = null', 'media_type = null', 'media_name = null', 'media_size = null', 'media_duration = null', 'shared_user_id = null']) {
    assert.ok(body.toLowerCase().includes(column), `expected ${column}`);
  }
  assert.match(body, /deleted_at = pg_catalog\.now\(\)/i);
});
