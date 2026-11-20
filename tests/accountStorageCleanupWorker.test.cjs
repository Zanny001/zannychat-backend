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
  const due = account.indexOf(".update({ status: 'pending', next_attempt_at: new Date().toISOString() })");
  assert.ok(queue >= 0 && deletion > queue && due > deletion);
  assert.ok(account.includes("status: 'held'"));
  assert.ok(account.includes(".update({ status: 'pending', next_attempt_at: new Date().toISOString() })"));
  assert.ok(job.includes(".in('status', ['held', 'pending'])"));
  assert.ok(job.includes(".or('claimed_at.is.null,claimed_at.lt.' + leaseExpiredBefore)"));
  assert.ok(job.includes(".eq('claimed_at', claimedAt)"));
  assert.ok(job.includes('admin.auth.admin.getUserById(claimedJob.user_id)'));
  assert.ok(job.includes(".eq('status', 'held')"));
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
  assert.ok(job.includes(".order('bucket_id', { ascending: true })"));
  assert.ok(job.includes(".order('name', { ascending: true })"));
  assert.ok(job.includes('REMOVE_BATCH_SIZE = 100'));
  assert.ok(job.includes('attempts,'));
  assert.ok(job.includes('last_error: message'));
  assert.ok(job.includes('next_attempt_at: retryAt(attempts)'));
});

test('account storage cleanup retry worker is mounted in the backend process', () => {
  assert.ok(index.includes('function startAccountStorageCleanupWorker()'));
  assert.ok(index.includes('startAccountStorageCleanupWorker();'));
});


const { runAccountStorageCleanup } = require('../src/jobs/accountStorageCleanup');

test('account storage cleanup remains usable while the durable claimed_at migration is pending', async () => {
  const deleted = [];
  const job = { id: 'job-1', user_id: 'deleted-user', attempts: 0, status: 'pending' };
  const admin = {
    from(table) {
      if (table === 'objects') {
        return { select() { return this; }, in() { return this; }, or() { return this; }, order() { return this; }, range() { return Promise.resolve({ data: [], error: null }); } };
      }
      assert.equal(table, 'account_storage_cleanup_jobs');
      let operation = 'select';
      let values = null;
      const query = {
        select() { return this; }, update(patch) { operation = 'update'; values = patch; return this; },
        delete() { operation = 'delete'; return this; }, in() { return this; }, lte() { return this; },
        order() { return this; }, limit() { return Promise.resolve({ data: [job], error: null }); },
        eq() { return this; }, or() { return this; },
        then(resolve, reject) {
          if (operation === 'update' && Object.prototype.hasOwnProperty.call(values || {}, 'claimed_at')) {
            return Promise.resolve({ data: null, error: { code: 'PGRST204', message: "Could not find the 'claimed_at' column of 'account_storage_cleanup_jobs' in the schema cache" } }).then(resolve, reject);
          }
          if (operation === 'delete') deleted.push(true);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    schema(name) { assert.equal(name, 'storage'); return this; },
    storage: { from() { return { remove: async () => ({ data: [], error: null }) }; } },
  };
  const result = await runAccountStorageCleanup({ admin, limit: 1 });
  assert.deepEqual(result, { skipped: false, processed: 1, removed: 0, failed: 0 });
  assert.deepEqual(deleted, [true]);
});
