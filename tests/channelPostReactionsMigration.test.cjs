const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0033_channel_post_reactions.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel post reactions are unique per user and cascade with posts', () => {
  assert.match(migration, /post_id uuid not null references public\.channel_posts\(id\) on delete cascade/i);
  assert.match(migration, /primary key \(post_id, user_id\)/i);
  assert.match(migration, /emoji in \('👍','❤️','😂','😮','👏'\)/);
});

test('channel post reactions are protected behind service-role API access', () => {
  assert.match(migration, /alter table public\.channel_post_reactions enable row level security/i);
  assert.match(migration, /revoke all on public\.channel_post_reactions from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on public\.channel_post_reactions to service_role/i);
  assert.match(route, /router\.use\(requireAuth, conversationsLimiter\)/);
  assert.match(route, /req\.user\.id/);
  assert.match(route, /router\.put\('\/:channelId\/posts\/:postId\/reaction'/);
  assert.match(route, /Choose a supported reaction or clear your reaction/);
});
