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
    const userId = req.user.id;

    // Do not cascade-delete session rows while their external media rooms or
    // Egress jobs are still active. The user must leave/end these first.
    const { data: activeLive, error: activeLiveError } = await supabaseAdmin.from('live_streams')
      .select('id').eq('creator_id', userId).eq('status', 'live').limit(1).maybeSingle();
    if (activeLiveError) throw activeLiveError;
    if (activeLive) return res.status(409).json({ error: 'End your active LIVE stream before deleting your account.' });

    const { data: activeReplay, error: activeReplayError } = await supabaseAdmin.from('live_stream_replays')
      .select('id,status').eq('creator_id', userId)
      .in('status', ['starting', 'recording', 'processing']).limit(1).maybeSingle();
    if (activeReplayError) throw activeReplayError;
    if (activeReplay) return res.status(409).json({ error: 'Wait for your LIVE replay to finish before deleting your account.' });

    const { data: activeCall, error: activeCallError } = await supabaseAdmin.from('call_sessions')
      .select('id').or(`caller_id.eq.${userId},callee_id.eq.${userId}`)
      .in('status', ['ringing', 'accepted']).limit(1).maybeSingle();
    if (activeCallError) throw activeCallError;
    if (activeCall) return res.status(409).json({ error: 'End your active call before deleting your account.' });

    const { data: activeGroupRoom, error: activeGroupRoomError } = await supabaseAdmin.from('group_call_rooms')
      .select('id').eq('host_user_id', userId).in('status', ['ringing', 'active'])
      .is('ended_at', null).limit(1).maybeSingle();
    if (activeGroupRoomError) throw activeGroupRoomError;
    if (activeGroupRoom) return res.status(409).json({ error: 'End your active group call before deleting your account.' });

    const { data: joinedGroupParticipants, error: groupParticipantError } = await supabaseAdmin.from('group_call_participants')
      .select('room_id').eq('user_id', userId).eq('status', 'joined').is('left_at', null).limit(100);
    if (groupParticipantError) throw groupParticipantError;
    const groupRoomIds = [...new Set((joinedGroupParticipants || []).map((row) => row.room_id).filter(Boolean))];
    if (groupRoomIds.length) {
      const { data: joinedGroupRoom, error: joinedGroupRoomError } = await supabaseAdmin.from('group_call_rooms')
        .select('id').in('id', groupRoomIds).in('status', ['ringing', 'active'])
        .is('ended_at', null).limit(1).maybeSingle();
      if (joinedGroupRoomError) throw joinedGroupRoomError;
      if (joinedGroupRoom) return res.status(409).json({ error: 'Leave your active group call before deleting your account.' });
    }

    const { data: joinedLiveParticipants, error: liveParticipantError } = await supabaseAdmin.from('live_stream_participants')
      .select('stream_id').eq('user_id', userId).eq('status', 'joined').is('left_at', null).limit(100);
    if (liveParticipantError) throw liveParticipantError;
    const liveStreamIds = [...new Set((joinedLiveParticipants || []).map((row) => row.stream_id).filter(Boolean))];
    if (liveStreamIds.length) {
      const { data: joinedLiveStream, error: joinedLiveStreamError } = await supabaseAdmin.from('live_streams')
        .select('id').in('id', liveStreamIds).eq('status', 'live').limit(1).maybeSingle();
      if (joinedLiveStreamError) throw joinedLiveStreamError;
      if (joinedLiveStream) return res.status(409).json({ error: 'Leave the active LIVE stream before deleting your account.' });
    }

    // Release reservations held by failed/deleted replays before their rows
    // cascade-delete with Auth. Successful replay seconds remain consumed.
    const { data: terminalReplays, error: terminalReplayError } = await supabaseAdmin.from('live_stream_replays')
      .select('id,status').eq('creator_id', userId).in('status', ['failed', 'deleted']).limit(1000);
    if (terminalReplayError) throw terminalReplayError;
    for (const replay of terminalReplays || []) {
      const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
        p_replay_id: replay.id,
        p_actual_seconds: 0,
        p_success: false,
      });
      if (quotaError) throw quotaError;
    }

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
