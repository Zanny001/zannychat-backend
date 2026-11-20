const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261120120000_durable_worker_claim_leases.sql'), 'utf8');
const accountWorker = fs.readFileSync(path.join(__dirname, '../src/jobs/accountStorageCleanup.js'), 'utf8');
const groupWorker = fs.readFileSync(path.join(__dirname, '../src/jobs/groupCallMediaCleanup.js'), 'utf8');
const liveWorker = fs.readFileSync(path.join(__dirname, '../src/jobs/liveStreamTimeoutWorker.js'), 'utf8');

test('account storage cleanup uses an atomic database claim and bounded crash-recovery lease', () => {
  assert.match(migration, /account_storage_cleanup_jobs\s+ADD COLUMN IF NOT EXISTS claimed_at/i);
  assert.match(migration, /account_storage_cleanup_jobs_claimed_due_idx/i);
  assert.match(accountWorker, /\.update\(\{ claimed_at: claimedAt \}\)/);
  assert.match(accountWorker, /\.or\('claimed_at\.is\.null,claimed_at\.lt\.'/);
  assert.match(accountWorker, /\.eq\('claimed_at', claimedAt\)/);
  assert.match(accountWorker, /claimed_at: null/);
  assert.match(accountWorker, /60 \* 60 \* 1000/);
});

test('group-call media teardown has an atomic claim and can recover after worker crash', () => {
  assert.match(migration, /group_call_rooms\s+ADD COLUMN IF NOT EXISTS media_cleanup_claimed_at/i);
  assert.match(migration, /group_call_rooms_pending_media_claim_idx/i);
  assert.match(groupWorker, /\.update\(\{ media_cleanup_claimed_at: claimedAt \}\)/);
  assert.match(groupWorker, /media_cleanup_claimed_at\.is\.null/);
  assert.match(groupWorker, /media_cleanup_claimed_at: null/);
  assert.match(groupWorker, /\.eq\('media_cleanup_claimed_at', claimedAt\)/);
});

test('LIVE timeout warning is only marked sent after provider acceptance and abandoned claims expire', () => {
  assert.match(migration, /timeout_warning_claimed_at IS NULL/);
  assert.match(migration, /timeout_warning_claimed_at < now\(\) - interval '10 minutes'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.mark_live_stream_timeout_warning_sent/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.release_live_stream_timeout_warning/);
  assert.match(liveWorker, /mark_live_stream_timeout_warning_sent/);
  assert.match(liveWorker, /release_live_stream_timeout_warning/);
});

test('all new worker lease RPCs are restricted to service_role', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_live_stream_timeout_warnings\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_live_stream_timeout_warnings\(\) TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.mark_live_stream_timeout_warning_sent\(uuid\) TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.release_live_stream_timeout_warning\(uuid\) TO service_role/);
});
