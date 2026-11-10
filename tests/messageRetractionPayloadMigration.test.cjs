const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192952_harden_message_retraction_content_0067.sql'), 'utf8');

function deletionBody(source) {
  const start = source.search(/create\s+or\s+replace\s+function\s+public\.delete_message\s*\(/i);
  assert.notEqual(start, -1, 'delete_message function must exist');
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, 'delete_message body must terminate');
  return source.slice(start, end);
}

test('global retraction clears every message payload field', () => {
  const body = deletionBody(sql);
  for (const column of ['text = \'\'', 'media_url = null', 'media_type = null', 'media_name = null', 'media_size = null', 'media_duration = null', 'shared_user_id = null']) {
    assert.ok(body.toLowerCase().includes(column), `expected ${column}`);
  }
});

test('retraction enforces authentication, participant membership, sender ownership, and no repeat delete', () => {
  const body = deletionBody(sql);
  assert.match(body, /set search_path = ''/i);
  assert.match(body, /p_mode is null or p_mode not in/i);
  assert.match(body, /v_message\.sender_id is distinct from v_user_id/i);
  assert.match(body, /v_message\.deleted_at is not null/i);
  assert.match(sql, /grant execute on function public\.delete_message\(uuid, text\) to authenticated/i);
  assert.match(sql, /revoke all on function public\.delete_message\(uuid, text\) from public, anon, authenticated/i);
});
