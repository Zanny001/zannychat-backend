const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '0059_realtime_audio_video_calls.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

test('call schema is limited to audio/video direct conversations and expires invitations', () => {
  assert.match(sql, /call_type text not null check \(call_type in \('audio', 'video'\)\)/);
  assert.match(sql, /expires_at timestamptz not null default \(now\(\) \+ interval '60 seconds'\)/);
  assert.match(sql, /total_count <> 2/);
  assert.match(sql, /a participant is already in an active call/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /public\.conversation_participants/);
});

test('call sessions are participant-scoped and lifecycle fields are immutable', () => {
  assert.match(sql, /alter table public\.call_sessions enable row level security/);
  assert.match(sql, /auth\.uid\(\) in \(caller_id, callee_id\)/);
  assert.match(sql, /call identity fields are immutable/);
  assert.match(sql, /invalid call state transition/);
  assert.match(sql, /not a call participant/);
});

test('blocked contacts cannot initiate calls and status transitions are role-bound', () => {
  assert.match(sql, /public\.blocked_users/);
  assert.match(sql, /actor = old\.callee_id/);
  assert.match(sql, /actor = old\.caller_id/);
  assert.match(sql, /old\.status = 'accepted' and new\.status = 'ended'/);
});

test('SDP and ICE payloads are capped, participant-bound, rate-limited, and cleaned up', () => {
  assert.match(sql, /octet_length\(payload::text\) <= 16384/);
  assert.match(sql, /signal recipient is not the other participant/);
  assert.match(sql, /recent_count >= 120/);
  assert.match(sql, /delete from public\.call_signals where call_id = new\.id/);
  assert.match(sql, /alter publication supabase_realtime add table public\.call_sessions/);
});
