const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261121043000_live_creator_reentry_bypasses_viewer_cap.sql'),
  'utf8',
);

test('creator can reclaim an active LIVE room even when the audience is at capacity', () => {
  assert.match(migration, /FUNCTION public\.join_live_stream\(p_stream_id uuid, p_user_id uuid\)/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /IF p_user_id <> v_stream\.creator_id\s+AND \(NOT FOUND OR v_existing_status <> 'joined'\) THEN/);
  assert.match(migration, /v_joined >= v_stream\.viewer_limit/);
  assert.match(migration, /SET search_path TO ''/);
  assert.match(migration, /v_stream\.visibility = 'followers'/);
  assert.match(migration, /v_stream\.visibility = 'private'/);
  assert.match(migration, /public\.blocked_users/);
  assert.match(migration, /v_stage_joined >= 5/);
});


test('creator capacity exemption preserves creator-removal blocks and heartbeat lease semantics', () => {
  assert.match(migration, /IF v_existing_status = 'blocked' THEN[\\s\\S]*?Creator removed this participant from the LIVE stream/);
  assert.match(migration, /last_seen_at\\)\\s+VALUES \\(p_stream_id, p_user_id, v_role, 'joined', now\\(\\), NULL, NULL\\)/);
  assert.match(migration, /WHERE current_participant\\.status <> 'blocked'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\\.join_live_stream\\(uuid, uuid\\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\\.join_live_stream\\(uuid, uuid\\) TO service_role/);
});
