const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0037_channel_post_reports.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
test('channel reports enforce one report per user/post and bounded enumerated reasons', () => {
  assert.match(migration, /unique \(post_id, reporter_id\)/);
  assert.match(migration, /char_length\(details\) <= 500/);
  assert.match(migration, /'spam', 'harassment', 'hate', 'misinformation', 'other'/);
  assert.match(route, /CHANNEL_REPORT_REASONS/);
  assert.match(route, /You have already reported this post/);
});
test('only active channel owners or moderators can access and resolve reports', () => {
  assert.match(route, /router\.get\('\/:channelId\/reports'/);
  assert.match(route, /router\.patch\('\/:channelId\/reports\/:reportId'/);
  assert.match(route, /canModerateChannel\(channel, req\.user\.id\)/);
  assert.match(route, /Only channel owners and moderators can review reports/);
});
test('report table is protected by RLS and service-role grants', () => {
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on public\.channel_post_reports from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on public\.channel_post_reports to service_role/i);
});
