const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migrationPath = path.join(
  __dirname,
  '../supabase/migrations/20261116204000_guard_message_insert_integrity.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

function insertGuardBody(source) {
  const start = source.search(/create\s+or\s+replace\s+function\s+private\.guard_message_insert_integrity\s*\(/i);
  assert.notEqual(start, -1, 'message insert integrity trigger function must exist');
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, 'message insert integrity trigger function must terminate');
  return source.slice(start, end).toLowerCase();
}

test('message insert integrity migration is transactional and installs a BEFORE INSERT trigger', () => {
  assert.match(sql, /BEGIN;/i);
  assert.match(sql, /create trigger guard_message_insert_integrity\s+before insert on public\.messages/i);
  assert.match(sql, /execute function private\.guard_message_insert_integrity\(\)/i);
  assert.match(sql, /\bcommit;\s*$/i);
});

test('authenticated message inserts cannot forge sender or lifecycle metadata', () => {
  const body = insertGuardBody(sql);
  assert.match(body, /current_user = 'authenticated'/);
  assert.match(body, /new\.sender_id is distinct from v_actor/);
  assert.match(body, /new\.created_at := pg_catalog\.clock_timestamp\(\)/);
  assert.match(body, /new\.edited_at := null/);
  assert.match(body, /new\.deleted_at := null/);
});

test('reply references must resolve to an active message in the same conversation', () => {
  const body = insertGuardBody(sql);
  assert.match(body, /from public\.messages as m/);
  assert.match(body, /for key share/);
  assert.match(body, /v_reply_conversation_id is distinct from new\.conversation_id/);
  assert.match(body, /reply target must belong to the same conversation/);
});

test('attachment inserts are bound to an uploaded object owned by the sender in the same conversation', () => {
  const body = insertGuardBody(sql);
  assert.match(body, /storage:\/\/chat-media\//);
  assert.match(body, /new\.conversation_id::text/);
  assert.match(body, /from storage\.objects as o/);
  assert.match(body, /o\.bucket_id = 'chat-media'/);
  assert.match(body, /o\.owner = new\.sender_id/);
  assert.match(body, /new\.media_size is not null and new\.media_size not between 0 and 26214400/);
  assert.match(body, /unsupported chat attachment type/);
});

test('contact shares and plain text messages cannot smuggle unrelated attachment metadata', () => {
  const body = insertGuardBody(sql);
  assert.match(body, /new\.shared_user_id is not null/);
  assert.match(body, /new\.media_type is distinct from 'contact'/);
  assert.match(body, /attachment metadata requires an uploaded media object/);
  assert.match(body, /a text message cannot be empty/);
  assert.match(body, /contact messages require a shared profile/);
});

test('trigger function is invoker-only, search-path pinned, and not callable as an RPC', () => {
  const body = insertGuardBody(sql);
  assert.match(body, /security invoker/);
  assert.match(body, /set search_path = ''/);
  assert.match(sql, /revoke all on function private\.guard_message_insert_integrity\(\)\s+from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant execute/i);
});

test('migration does not replace or broaden existing messages RLS policies or grants', () => {
  assert.doesNotMatch(sql, /create\s+policy|drop\s+policy|grant\s+.*messages|revoke\s+.*messages/i);
});
