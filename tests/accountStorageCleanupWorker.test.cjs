const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const job = fs.readFileSync(path.join(__dirname, '../src/jobs/accountStorageCleanup.js'), 'utf8');
const account = fs.readFileSync(path.join(__dirname, '../src/routes/account.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('account deletion queues cleanup before Auth deletion and only releases it after success', () => {
  const queue = account.indexOf("from('account_storage_cleanup_jobs')");
  const deletion = account.indexOf('supabaseAdmin.auth.admin.deleteUser');
  const due = account.indexOf(".update({ next_attempt_at: new Date().toISOString() })");
  assert.ok(queue >= 0 && deletion > queue && due > deletion);
  assert.ok(account.includes("status: 'held'"));
  assert.ok(account.includes(".update({ status: 'pending', next_attempt_at: new Date().toISOString() })"));
  assert.ok(job.includes(".eq('status', 'pending')"));
  assert.ok(account.includes('runAccountStorageCleanup({ admin: supabaseAdmin, limit: 1 })'));
  assert.ok(account.includes('storageCleanupPending'));
});

test('cleanup is limited to personal media buckets and never deletes shared chat media', () => {
  assert.ok(job.includes("['avatars', 'private-avatars', 'status-media', 'live-replays']"));
  assert.equal(job.includes("'chat-media'"), false);
  assert.ok(job.includes('owner_id.eq.'));
  assert.ok(job.includes('name.like.'));
  assert.ok(job.includes('admin.storage.from(bucket).remove(batch)'));
});

test('cleanup paginates object lookup, batches deletes and retries failures durably', () => {
  assert.ok(job.includes('.range(offset, offset + pageSize - 1)'));
  assert.ok(job.includes('REMOVE_BATCH_SIZE = 100'));
  assert.ok(job.includes('attempts,'));
  assert.ok(job.includes('last_error: message'));
  assert.ok(job.includes('next_attempt_at: retryAt(attempts)'));
});

test('account storage cleanup retry worker is mounted in the backend process', () => {
  assert.ok(index.includes('function startAccountStorageCleanupWorker()'));
  assert.ok(index.includes('startAccountStorageCleanupWorker();'));
});
