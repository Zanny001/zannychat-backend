const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/0075_restore_chat_directory_read_cursors.sql'),
  'utf8',
);

test('restores exact zero-argument and QR-target contact directory RPC signatures', () => {
  assert.match(sql, /function public\\.get_contact_directory\\(\\)/i);
  assert.match(sql, /function public\\.get_contact_directory\\(p_user_id uuid\\)/i);
  assert.match(sql, /from public\\.get_contact_directory\\(NULL::uuid\\)/i);
  assert.match(sql, /grant execute on function public\\.get_contact_directory\\(\\) to authenticated/i);
  assert.match(sql, /grant execute on function public\\.get_contact_directory\\(uuid\\) to authenticated/i);
});

test('contact directory enforces profile visibility and bidirectional blocks', () => {
  assert.match(sql, /profile_visibility/i);
  assert.match(sql, /public\\.conversation_participants/i);
  assert.match(sql, /public\\.blocked_users/i);
  assert.match(sql, /b\\.blocker_id = auth\\.uid\\(\\).*b\\.blocked_id = p\\.id/s);
  assert.match(sql, /b\\.blocker_id = p\\.id.*b\\.blocked_id = auth\\.uid\\(\\)/s);
});

test('read cursor RPC returns only the authenticated user’s own non-null cursors', () => {
  assert.match(sql, /function public\\.get_my_read_cursors\\(\\)/i);
  assert.match(sql, /cp\\.user_id = auth\\.uid\\(\\)/i);
  assert.match(sql, /cp\\.last_read_at is not null/i);
  assert.match(sql, /grant execute on function public\\.get_my_read_cursors\\(\\) to authenticated/i);
});

test('both RPCs use a fixed empty search_path and deny public/anonymous execution', () => {
  assert.equal((sql.match(/set search_path = ''/gi) || []).length, 3);
  assert.match(sql, /revoke all on function public\\.get_contact_directory\\(\\) from public, anon/i);
  assert.match(sql, /revoke all on function public\\.get_my_read_cursors\\(\\) from public, anon/i);
});
