const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0035_channel_post_pinning.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel post pinning is indexed and defaults to unpinned', () => {
  assert.match(migration, /add column if not exists is_pinned boolean not null default false/i);
  assert.match(migration, /on public\.channel_posts \(channel_id, is_pinned desc, created_at desc\)/i);
});

test('pin endpoint validates boolean and enforces owner or moderator permissions', () => {
  assert.match(route, /router\.put\('\/:channelId\/posts\/:postId\/pin'/);
  assert.match(route, /typeof req\.body\?\.pinned !== 'boolean'/);
  assert.match(route, /Only the channel owner or a channel moderator can pin posts/);
  assert.match(route, /Number\(Boolean\(b\.is_pinned\)\) - Number\(Boolean\(a\.is_pinned\)\)/);
});
