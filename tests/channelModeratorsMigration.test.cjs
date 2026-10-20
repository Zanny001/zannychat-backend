const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0036_channel_moderators.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel moderators are unique per channel/user and cascade on deletion', () => {
  assert.match(migration, /primary key \(channel_id, user_id\)/i);
  assert.match(migration, /references public\.channels\(id\) on delete cascade/i);
  assert.match(migration, /references public\.profiles\(id\) on delete cascade/i);
});

test('moderator table is RLS protected and service-role mediated', () => {
  assert.match(migration, /alter table public\.channel_moderators enable row level security/i);
  assert.match(migration, /revoke all on public\.channel_moderators from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on public\.channel_moderators to service_role/i);
});

test('only owner can appoint/remove moderators and appointments require subscriptions', () => {
  assert.match(route, /Only the channel owner can appoint moderators/);
  assert.match(route, /Only the channel owner can remove moderators/);
  assert.match(route, /Only channel subscribers can be moderators/);
  assert.match(route, /router\.post\('\/:channelId\/moderators'/);
  assert.match(route, /router\.delete\('\/:channelId\/moderators\/:userId'/);
});

test('moderators may pin/delete posts and delete comments but cannot publish/edit/delete channel', () => {
  assert.match(route, /canModerateChannel\(channel, req\.user\.id\)/);
  assert.match(route, /Only the channel owner can publish posts/);
  assert.match(route, /Only the channel owner can edit posts/);
  assert.match(route, /Only the channel owner can delete it/);
});
