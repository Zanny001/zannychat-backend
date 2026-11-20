const PERSONAL_BUCKETS = ['avatars', 'private-avatars', 'status-media', 'live-replays'];
const REMOVE_BATCH_SIZE = 100;
let workerRunning = false;
let legacyLeaseWarningLogged = false;

function isMissingColumn(error, column) {
  const message = String(error?.message || '').toLowerCase();
  return ['42703', 'PGRST204', 'PGRST200'].includes(String(error?.code || '')) && message.includes(column.toLowerCase());
}

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
      .order('bucket_id', { ascending: true })
      .order('name', { ascending: true })
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
    const { data: jobs, error } = await admin.from('account_storage_cleanup_jobs')
      .select('id,user_id,attempts,status').in('status', ['held', 'pending'])
      .lte('next_attempt_at', new Date().toISOString())
      .order('created_at', { ascending: true }).limit(Math.max(1, Math.min(50, limit)));
    if (error) throw error;
    let leaseSupported = true;
    for (const job of jobs || []) {
      const claimedAt = new Date().toISOString();
      let claimedJob = job;
      if (leaseSupported) {
        const leaseExpiredBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: claimedRows, error: claimError } = await admin.from('account_storage_cleanup_jobs')
          .update({ claimed_at: claimedAt }).eq('id', job.id).in('status', ['held', 'pending'])
          .or('claimed_at.is.null,claimed_at.lt.' + leaseExpiredBefore)
          .select('id,user_id,attempts,status');
        if (claimError && isMissingColumn(claimError, 'claimed_at')) {
          leaseSupported = false;
          if (!legacyLeaseWarningLogged) {
            legacyLeaseWarningLogged = true;
            console.warn('[account-storage-cleanup] durable lease migration is pending; using process-local worker lock');
          }
        } else if (claimError) throw claimError;
        else {
          claimedJob = claimedRows?.[0];
          if (!claimedJob) continue;
        }
      }
      try {
        if (claimedJob.status === 'held') {
          const { data: authUser, error: authLookupError } = await admin.auth.admin.getUserById(claimedJob.user_id);
          const userMissing = !authUser?.user
            && (authLookupError?.status === 404 || authLookupError?.code === 'user_not_found'
              || /user.*not found/i.test(String(authLookupError?.message || '')));
          if (authUser?.user || !userMissing) {
            if (leaseSupported) await admin.from('account_storage_cleanup_jobs').update({ claimed_at: null }).eq('id', claimedJob.id).eq('claimed_at', claimedAt);
            continue;
          }
          let releaseQuery = admin.from('account_storage_cleanup_jobs')
            .update({ status: 'pending', next_attempt_at: new Date().toISOString() })
            .eq('id', claimedJob.id).eq('status', 'held');
          if (leaseSupported) releaseQuery = releaseQuery.eq('claimed_at', claimedAt);
          const { error: releaseError } = await releaseQuery;
          if (releaseError) throw releaseError;
        }
        const removed = await removeUserPersonalStorage(admin, claimedJob.user_id);
        let deleteQuery = admin.from('account_storage_cleanup_jobs').delete().eq('id', claimedJob.id);
        if (leaseSupported) deleteQuery = deleteQuery.eq('claimed_at', claimedAt);
        const { error: deleteError } = await deleteQuery;
        if (deleteError) throw deleteError;
        summary.processed += 1;
        summary.removed += removed;
      } catch (error) {
        const attempts = Number(claimedJob.attempts || 0) + 1;
        const message = String(error?.message || error || 'Storage cleanup failed').slice(0, 500);
        const patch = { attempts, last_error: message, next_attempt_at: retryAt(attempts) };
        if (leaseSupported) patch.claimed_at = null;
        let retryQuery = admin.from('account_storage_cleanup_jobs').update(patch).eq('id', claimedJob.id);
        if (leaseSupported) retryQuery = retryQuery.eq('claimed_at', claimedAt);
        const { error: updateError } = await retryQuery;
        if (updateError) console.error('[account-storage-cleanup] could not persist retry state:', updateError.message || updateError);
        summary.failed += 1;
      }
    }
    return summary;
  } finally {
    workerRunning = false;
  }
}

module.exports = { runAccountStorageCleanup, removeUserPersonalStorage, PERSONAL_BUCKETS };
