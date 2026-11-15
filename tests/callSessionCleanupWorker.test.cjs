const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanupStaleCallSessions } = require('../src/jobs/callSessionCleanupWorker');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261115090003_finalize_stale_call_sessions.sql'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('call-session cleanup worker invokes the restricted cleanup RPC', async () => {
  let call;
  const result = await cleanupStaleCallSessions({
    admin: { rpc: async (name) => { call = name; return { data: 12, error: null }; } },
  });
  assert.equal(call, 'cleanup_stale_call_signals');
  assert.deepEqual(result, { deletedSignals: 12 });
});

test('expired accepted calls are finalized before their signaling rows are removed', () => {
  const cleanupStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.cleanup_stale_call_signals()');
  const cleanup = migration.slice(cleanupStart);
  assert.ok(cleanup.includes("SET status = 'ended', ended_at = now()"));
  assert.ok(cleanup.includes("status = 'accepted'"));
  assert.ok(cleanup.includes("last_activity_at < now() - interval '3 minutes'"));
  assert.ok(cleanup.indexOf("SET status = 'ended'") < cleanup.indexOf('DELETE FROM public.call_signals'));
  assert.ok(cleanup.includes("REVOKE ALL ON FUNCTION public.cleanup_stale_call_signals() FROM PUBLIC, anon, authenticated"));
  assert.ok(cleanup.includes("GRANT EXECUTE ON FUNCTION public.cleanup_stale_call_signals() TO service_role"));
});

test('the call lifecycle trigger permits only trusted postgres cleanup to end an expired accepted session', () => {
  assert.ok(migration.includes("actor IS NULL AND current_user = 'postgres'"));
  assert.ok(migration.includes('call_sessions_accepted_last_activity_idx'));
  assert.ok(migration.includes("OLD.status = 'accepted' AND NEW.status = 'ended'"));
});

test('backend mounts the stale call cleanup worker on a single interval', () => {
  assert.ok(index.includes('startCallSessionCleanupWorker();'));
  assert.ok(index.includes('setInterval(tick, 60_000)'));
  assert.ok(index.includes("cleanupStaleCallSessions({ admin: supabaseAdmin })"));
});
