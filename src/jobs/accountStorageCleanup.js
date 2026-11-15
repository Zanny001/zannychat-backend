const PERSONAL_BUCKETS = ['avatars', 'private-avatars', 'status-media', 'live-replays'];
const REMOVE_BATCH_SIZE = 100;
let workerRunning = false;

function retryAt(attempts) {
  const delayMs = Math.min(24 * 60 * 60 * 1000, 60_000 * (2 ** Math.min(attempts, 10)));
  return new Date(Date.now() + delayMs).toISOString();
}

async function removeUserPersonalStorage(admin, userId) {
  const objects = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data: page, error } = await admin
      .schema('storage')
      .from('objects')
      .select('bucket_id,name')
      .in('bucket_id', PERSONAL_BUCKETS)
      .or(`owner_id.eq.${userId},owner.eq.${userId},name.like.${userId}/%`)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    objects.push(...(page || []));
    if (!page || page.length < pageSize) break;
  }

  const byBucket = new Map();
  for (const object of objects) {
    if (!PERSONAL_BUCKETS.includes(object.bucket_id) || typeof object.name !== 'string') continue;
    const paths = byBucket.get(object.bucket_id) || [];
    paths.push(object.name);
    byBucket.set(object.bucket_id, paths);
  }

  let removed = 0;
  for (const [bucket, paths] of byBucket) {
    for (let index = 0; index < paths.length; index += REMOVE_BATCH_SIZE) {
      const batch = paths.slice(index, index + REMOVE_BATCH_SIZE);
      const { error: removeError } = await admin.storage.from(bucket).remove(batch);
      if (removeError) throw removeError;
      removed += batch.length;
    }
  }
  return removed;
}

async function runAccountStorageCleanup({ admin, limit = 10 } = {}) {
  if (!admin) throw new Error('Supabase admin client is required');
  if (workerRunning) return { skipped: true, processed: 0, removed: 0, failed: 0 };
  workerRunning = true;
  const summary = { skipped: false, processed: 0, removed: 0, failed: 0 };

  try {
    const { data: jobs, error } = await admin
      .from('account_storage_cleanup_jobs')
      .select('id,user_id,attempts,status')
      .eq('status', 'pending')
      .lte('next_attempt_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(Math.max(1, Math.min(50, limit)));
    if (error) throw error;

    for (const job of jobs || []) {
      try {
        if (job.status === 'held') {
          const { data: authUser, error: authLookupError } = await admin.auth.admin.getUserById(job.user_id);
          const userMissing = !authUser?.user
            && (authLookupError?.status === 404 || authLookupError?.code === 'user_not_found'
              || /user.*not found/i.test(String(authLookupError?.message || '')));
          if (authUser?.user || !userMissing) continue;
          const { error: releaseError } = await admin
            .from('account_storage_cleanup_jobs')
            .update({ status: 'pending', next_attempt_at: new Date().toISOString() })
            .eq('id', job.id)
            .eq('status', 'held');
          if (releaseError) throw releaseError;
        }
        const removed = await removeUserPersonalStorage(admin, job.user_id);
        const { error: deleteError } = await admin
          .from('account_storage_cleanup_jobs')
          .delete()
          .eq('id', job.id);
        if (deleteError) throw deleteError;
        summary.processed += 1;
        summary.removed += removed;
      } catch (error) {
        const attempts = Number(job.attempts || 0) + 1;
        const message = String(error?.message || error || 'Storage cleanup failed').slice(0, 500);
        const { error: updateError } = await admin
          .from('account_storage_cleanup_jobs')
          .update({
            attempts,
            last_error: message,
            next_attempt_at: retryAt(attempts),
          })
          .eq('id', job.id);
        if (updateError) {
          console.error('[account-storage-cleanup] could not persist retry state:', updateError.message || updateError);
        }
        summary.failed += 1;
      }
    }
    return summary;
  } finally {
    workerRunning = false;
  }
}

module.exports = { runAccountStorageCleanup, removeUserPersonalStorage, PERSONAL_BUCKETS };
