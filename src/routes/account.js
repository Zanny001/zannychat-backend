const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/requireAuth');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { runAccountStorageCleanup } = require('../jobs/accountStorageCleanup');

const router = express.Router();
const deletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many deletion attempts. Please wait and try again.' }),
});

router.use(requireAuth, deletionLimiter);

// POST /account/delete { confirmation: "DELETE" }
// The client must first re-authenticate with the account password. We also
// enforce a fresh auth_time server-side, so a stolen old session alone is not
// enough to destroy an account. A pending migration makes replies to deleted
// messages nullable, allowing account cleanup to complete without broken refs.
router.post('/delete', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  if (req.body?.confirmation !== 'DELETE') {
    return res.status(400).json({ error: 'Explicit DELETE confirmation is required' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (!req.authTime || req.authTime > now + 60 || now - req.authTime > 5 * 60) {
    return res.status(403).json({ error: 'For your security, verify your password again before deleting your account.' });
  }

  try {
    // Queue personal Storage cleanup before deleting Auth. A short future
    // due-time prevents the background worker racing the Auth deletion.
    // The queue has no FK to auth.users, so it survives the cascade.
    const { data: cleanupJob, error: queueError } = await supabaseAdmin
      .from('account_storage_cleanup_jobs')
      .insert({ user_id: req.user.id, status: 'held', next_attempt_at: new Date().toISOString() })
      .select('id')
      .single();
    if (queueError || !cleanupJob?.id) {
      console.error('[account] could not queue personal storage cleanup:', queueError?.message || 'missing cleanup job');
      return res.status(503).json({ error: 'Account deletion is temporarily unavailable. Please try again.' });
    }

    // The 0013 migration removes empty direct conversations transactionally
    // as participant rows cascade. Do not delete personal Storage objects until
    // Auth confirms deletion, so a failed delete does not destroy account media.
    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (deleteUserError) {
      await supabaseAdmin.from('account_storage_cleanup_jobs').delete().eq('id', cleanupJob.id);
      return res.status(500).json({ error: 'Account deletion failed. Please contact support if this continues.' });
    }

    const { error: dueError } = await supabaseAdmin
      .from('account_storage_cleanup_jobs')
      .update({ status: 'pending', next_attempt_at: new Date().toISOString() })
      .eq('id', cleanupJob.id);
    if (dueError) {
      console.error('[account] personal storage cleanup remains queued:', dueError.message || dueError);
      return res.status(200).json({ deleted: true, storageCleanupPending: true });
    }

    let storageCleanupPending = true;
    try {
      const summary = await runAccountStorageCleanup({ admin: supabaseAdmin, limit: 1 });
      storageCleanupPending = summary.failed > 0 || summary.processed === 0;
    } catch (cleanupError) {
      console.error('[account] immediate personal storage cleanup deferred:', cleanupError.message || cleanupError);
    }
    return res.status(200).json({ deleted: true, storageCleanupPending });
  } catch (_) {
    return res.status(500).json({ error: 'Account deletion failed. Please try again or contact support.' });
  }
});

module.exports = router;
