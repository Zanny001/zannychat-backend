const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0021_channels.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('channel tables have bounded content and foreign-key lifecycle cleanup', () => {
  assert.match(migration, /title text not null check \(char_length\(btrim\(title\)\) between 2 and 60\)/i);
  assert.match(migration, /description text not null default '' check \(char_length\(description\) <= 500\)/i);
  assert.match(migration, /body text not null check \(char_length\(btrim\(body\)\) between 1 and 4000\)/i);
  assert.match(migration, /references public\.channels\(id\) on delete cascade/i);
});

test('channel tables are RLS enabled and direct client privileges are revoked', () => {
  assert.match(migration, /alter table public\.channels enable row level security/i);
  assert.match(migration, /alter table public\.channel_subscriptions enable row level security/i);
  assert.match(migration, /alter table public\.channel_posts enable row level security/i);
  assert.match(migration, /revoke all on public\.channels, public\.channel_subscriptions, public\.channel_posts from anon, authenticated/i);
});

test('all channel routes require authentication and subscription identity comes from the session', () => {
  assert.match(route, /router\.use\(requireAuth, conversationsLimiter\)/);
  assert.match(route, /user_id: req\.user\.id/);
  assert.match(route, /eq\('user_id', req\.user\.id\)/);
  assert.match(index, /app\.use\('\/channels', channelsRouter\)/);
});

test('only channel owner can publish posts or delete a channel', () => {
  assert.match(route, /if \(channel\.owner_id !== req\.user\.id\) return res\.status\(403\)/);
  assert.match(route, /Only the channel owner can publish posts/);
  assert.match(route, /Only the channel owner can delete it/);
});
