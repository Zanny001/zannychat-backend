const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0067_harden_message_retraction_content.sql'), 'utf8');

test('global retraction clears text, media metadata and shared-contact references', () => {
  assert.match(sql, /text = ''/);
  assert.match(sql, /media_url = null/);
  assert.match(sql, /media_type = null/);
  assert.match(sql, /media_name = null/);
  assert.match(sql, /media_size = null/);
  assert.match(sql, /media_duration = null/);
  assert.match(sql, /shared_user_id = null/);
});

test('retraction remains sender-authorized and preserves per-viewer deletion behavior', () => {
  assert.match(sql, /if p_mode = 'me' then/);
  assert.match(sql, /message_hidden_for/);
  assert.match(sql, /v_message\.sender_id <> v_user_id/);
  assert.match(sql, /grant execute on function public\.delete_message\(uuid, text\) to authenticated/);
});
