const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261114084400_live_replay_storage_quota.sql'),
  'utf8',
).toLowerCase();

test('LIVE replay metadata is private and bounded to one replay per stream', () => {
  assert.match(migration, /create table if not exists public\.live_stream_replays/);
  assert.match(migration, /room_name text not null/);
  assert.match(migration, /notification_sent_at timestamptz/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.live_stream_replays from public, anon, authenticated/);
  assert.match(migration, /grant all on table public\.live_stream_replays to service_role/);
  assert.match(migration, /where status in \('starting','recording','processing','ready'\)/);
  assert.match(migration, /duration_seconds between 0 and 305/);
  assert.match(migration, /file_size_bytes between 0 and 48000000/);
});

test('LIVE replay quota atomically reserves at most 50 minutes per calendar month', () => {
  assert.match(migration, /create table if not exists public\.live_replay_quota/);
  assert.match(migration, /reserved_seconds \+ used_seconds \+ 300 <= 3000/);
  assert.match(migration, /active_replay_id is null/);
  assert.match(migration, /create or replace function public\.reserve_live_replay_quota/);
  assert.match(migration, /create or replace function public\.finalize_live_replay_quota/);
  assert.match(migration, /grant execute on function public\.reserve_live_replay_quota\(uuid\) to service_role/);
  assert.match(migration, /grant execute on function public\.finalize_live_replay_quota\(uuid, integer, boolean\) to service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.reserve_live_replay_quota\(uuid\) to authenticated/);
});

test('storage headroom RPC is private and the replay bucket is private with a 50 MB cap', () => {
  assert.match(migration, /create or replace function public\.get_live_replay_storage_bytes/);
  assert.match(migration, /grant execute on function public\.get_live_replay_storage_bytes\(\) to service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.get_live_replay_storage_bytes\(\) to authenticated/);
  assert.match(migration, /values \('live-replays', 'live-replays', false, 48000000, array\['video\/mp4'\]\)/);
  assert.match(migration, /set public = false/);
});
