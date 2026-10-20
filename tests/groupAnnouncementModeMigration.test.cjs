const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0040_group_announcement_mode.sql'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/conversations.js'), 'utf8');

test('announcement mode defaults off for existing conversations and uses a private security-definer helper', () => {
  assert.match(migration, /add column if not exists admin_only_messages boolean not null default false/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /private\.can_send_conversation_message\(conversation_id\)/i);
});

test('RLS limits sending to admins only when group announcement mode is enabled', () => {
  assert.match(migration, /not c\.is_group or not c\.admin_only_messages or cp\.is_admin/i);
  assert.match(migration, /sender_id = auth\.uid\(\)/i);
  assert.match(migration, /not public\.is_blocked_in_conversation/i);
});

test('metadata endpoint validates and exposes the announcement mode only to members/admins', () => {
  assert.match(routes, /adminOnlyMessages !== undefined && typeof adminOnlyMessages !== 'boolean'/);
  assert.match(routes, /changes\.admin_only_messages = adminOnlyMessages/);
  assert.match(routes, /adminOnlyMessages: Boolean\(data\.admin_only_messages\)/);
  assert.match(routes, /Only group admins can edit group metadata/);
});
