const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0020_group_invites.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/conversations.js'), 'utf8');
test('group invite tokens are hashed and table access is service-role only', () => {
  assert.match(migration, /token_hash text not null unique/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on public\.group_invites from anon, authenticated/i);
  assert.match(route, /createHash\('sha256'\)/);
});
test('invite creation requires an administrator and bounded expiry/use limits', () => {
  assert.match(route, /router\.post\('\/:conversationId\/invites'/);
  assert.match(route, /if \(!actor\?\.is_admin\) return res\.status\(403\)/);
  assert.match(route, /expiresInHours < 1 \|\| expiresInHours > 168/);
  assert.match(route, /maxUses < 1 \|\| maxUses > 100/);
});
test('invite acceptance delegates atomic use counting and membership insert to SQL RPC', () => {
  assert.match(route, /router\.post\('\/invites\/accept'/);
  assert.match(route, /rpc\('accept_group_invite'/);
  assert.match(migration, /for update/i);
  assert.match(migration, /use_count = use_count \+ 1/i);
  assert.match(migration, /on conflict \(conversation_id, user_id\) do nothing/i);
});
test('admins can revoke active invites', () => {
  assert.match(route, /router\.delete\('\/:conversationId\/invites\/:inviteId'/);
  assert.match(route, /revoked_at: new Date\(\)\.toISOString\(\)/);
});

test('group invite history is admin-only and never returns token hashes', () => {
  assert.match(route, /router\.get\('\/:conversationId\/invites'/);
  assert.match(route, /Only group admins can view invites/);
  assert.match(route, /select\('id,created_at,expires_at,max_uses,use_count,revoked_at'\)/);
  assert.match(route, /status: invite\.revoked_at/);
});
