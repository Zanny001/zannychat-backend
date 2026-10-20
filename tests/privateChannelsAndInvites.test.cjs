const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0038_private_channels_and_invites.sql'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/routes/channels.js'), 'utf8');
const frontendApi = fs.readFileSync(path.join(root, '../zannychat-frontend-main/src/services/api.js'), 'utf8');
const screen = fs.readFileSync(path.join(root, '../zannychat-frontend-main/src/screens/ChannelsScreen.js'), 'utf8');

test('private channel visibility defaults to public for backward compatibility', () => {
  assert.match(migration, /add column if not exists is_private boolean not null default false/i);
  assert.match(route, /eq\('is_private', false\)/);
  assert.match(route, /eq\('is_private', true\)\.in\('id', myIds\)/);
});

test('private channel content access is checked server-side', () => {
  assert.match(route, /async function canAccessChannel/);
  assert.match(route, /async function requireChannelAccess/);
  assert.match(route, /if \(channel\.is_private && channel\.owner_id !== req\.user\.id\) return res\.status\(403\)/);
  assert.match(route, /requireChannelAccess\(res, channelRow, req\.user\.id\)/);
  assert.match(route, /requireChannelAccess\(res, accessChannel, req\.user\.id\)/);
});

test('invite tokens are hashed and consumption is atomic with bounded uses', () => {
  assert.match(route, /createHash\('sha256'\)/);
  assert.match(route, /randomBytes\(24\)/);
  assert.match(route, /rpc\('accept_channel_invite'/);
  assert.match(migration, /for update/i);
  assert.match(migration, /get diagnostics inserted_count = row_count/i);
  assert.match(migration, /if inserted_count > 0 then/i);
  assert.match(migration, /use_count = use_count \+ 1/i);
  assert.match(migration, /grant execute on function public\.accept_channel_invite\(text, uuid\) to service_role/i);
  assert.match(migration, /revoke all on public\.channel_invites from public, anon, authenticated/i);
});

test('frontend supports private channel creation and invite join/share', () => {
  assert.match(frontendApi, /export async function createChannelInvite/);
  assert.match(frontendApi, /export async function acceptChannelInvite/);
  assert.match(frontendApi, /export async function fetchChannelInvites/);
  assert.match(frontendApi, /export async function revokeChannelInvite/);
  assert.match(frontendApi, /isPrivate: Boolean\(isPrivate\)/);
  assert.match(screen, /Private channel \(invitation required\)/);
  assert.match(screen, /setSelectedIsPrivateDraft\(Boolean\(item\.is_private\)\)/);
  assert.match(screen, /Join with invitation/);
  assert.match(screen, /Share\.share/);
  assert.match(screen, /Channel invitations/);
  assert.match(screen, /revokeInvite/);
});
