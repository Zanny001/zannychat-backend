const MAX_ATTEMPTS = 12;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

function safeObjectPath(value, projectUrl = process.env.SUPABASE_URL) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  const marker = 'storage://chat-media/';
  let path = null;
  if (value.startsWith(marker)) {
    path = value.slice(marker.length);
  } else {
    try {
      const url = new URL(value);
      if (!projectUrl || url.origin !== new URL(projectUrl).origin) return null;
      const match = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/chat-media\/(.+)$/);
      if (!match) return null;
      path = decodeURIComponent(match[1]);
    } catch (_) {
      return null;
    }
  }
  const segments = path.split('/');
  if (segments.length < 2 || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null;
  return { bucket: 'chat-media', path };
}

function retryDelay(attemptCount) {
  const exponent = Math.max(0, Math.min(20, attemptCount));
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** exponent));
}

async function updateQueue(admin, id, values) {
  const { error } = await admin.from('message_attachment_cleanup').update(values).eq('id', id);
  if (error) throw error;
}

async function hasMediaReference(admin, object) {
  const pageSize = 500;
  let offset = 0;

  while (true) {
    const { data: references, error } = await admin
      .from('messages')
      .select('media_url')
      .not('media_url', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    for (const reference of references || []) {
      const referencedObject = safeObjectPath(reference.media_url);
      if (
        referencedObject &&
        referencedObject.bucket === object.bucket &&
        referencedObject.path === object.path
      ) {
        return true;
      }
    }

    if (!references || references.length < pageSize) return false;
    offset += pageSize;
  }
}

async function runMessageAttachmentCleanup({ admin, limit = 20, now = () => new Date() } = {}) {
  if (!admin) admin = require('../config/supabaseAdmin').supabaseAdmin;
  if (!admin) throw new Error('Supabase service client is not configured');
  const { data: jobs, error: claimError } = await admin.rpc('claim_message_attachment_cleanup', { p_limit: limit });
  if (claimError) throw claimError;

  const summary = { claimed: (jobs || []).length, deleted: 0, retained: 0, skipped: 0, retried: 0, failed: 0 };
  for (const job of jobs || []) {
    try {
      const object = safeObjectPath(job.media_url);
      if (!object) {
        await updateQueue(admin, job.id, { status: 'skipped', completed_at: now().toISOString(), lease_started_at: null, last_error: 'Unsupported or non-owned storage URL' });
        summary.skipped += 1;
        continue;
      }

      // The object path must be scoped to the exact conversation that
      // generated this cleanup job. A sender can submit arbitrary media_url
      // metadata on a message row; without this binding a crafted reference
      // could otherwise queue deletion of another conversation's object.
      const conversationId = typeof job.conversation_id === 'string' ? job.conversation_id : '';
      if (!conversationId || !object.path.startsWith(`${conversationId}/`)) {
        await updateQueue(admin, job.id, { status: 'skipped', completed_at: now().toISOString(), lease_started_at: null, last_error: 'Media object does not belong to the queued message conversation' });
        summary.skipped += 1;
        continue;
      }

      // Search every conversation. Message media_url is not currently
      // constrained by the database insert policy to its conversation folder.
      // Paginate so large message tables are not loaded into memory at once.
      const stillReferenced = await hasMediaReference(admin, object);
      if (stillReferenced) {
        await updateQueue(admin, job.id, { status: 'skipped', completed_at: now().toISOString(), lease_started_at: null, last_error: 'Media is still referenced by another message' });
        summary.retained += 1;
        continue;
      }

      const { error: storageError } = await admin.storage.from(object.bucket).remove([object.path]);
      if (storageError) throw storageError;
      await updateQueue(admin, job.id, { status: 'done', completed_at: now().toISOString(), lease_started_at: null, last_error: null });
      summary.deleted += 1;
    } catch (error) {
      const nextAttempt = (Number.isInteger(job.attempt_count) ? job.attempt_count : 0) + 1;
      const exhausted = nextAttempt >= MAX_ATTEMPTS;
      const retryAt = new Date(now().getTime() + retryDelay(nextAttempt));
      try {
        await updateQueue(admin, job.id, {
          status: exhausted ? 'skipped' : 'pending',
          attempt_count: nextAttempt,
          next_attempt_at: retryAt.toISOString(),
          lease_started_at: null,
          completed_at: exhausted ? now().toISOString() : null,
          last_error: String(error?.message || 'Storage cleanup failed').replace(/[\r\n\t]/g, ' ').slice(0, 500),
        });
      } catch (_) {
        // Leave the lease to expire; the claim function safely recovers stale jobs.
      }
      if (exhausted) summary.failed += 1;
      else summary.retried += 1;
    }
  }
  return summary;
}

module.exports = { safeObjectPath, retryDelay, runMessageAttachmentCleanup };
