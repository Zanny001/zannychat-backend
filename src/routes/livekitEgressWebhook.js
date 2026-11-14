const express = require('express');
const supabaseAdmin = require('../config/supabaseAdmin');
const { getLiveKitEgressConfig, verifyLiveKitWebhook, MAX_REPLAY_BYTES, MAX_REPLAY_OUTPUT_SECONDS } = require('../services/livekitEgress');
const { clearLiveReplayStop } = require('../jobs/liveReplayWorker');
const { sendPushToUser } = require('../config/pushClient');

const router = express.Router();
const rawBody = express.raw({ type: ['application/webhook+json', 'application/json'], limit: '1mb' });

function getEgressInfo(event) {
  return event?.egressInfo || event?.egress_info || null;
}

function getFileResults(info) {
  return info?.fileResults || info?.file_results || [];
}

function getDurationSeconds(file) {
  const raw = Number(file?.duration || file?.durationNs || file?.duration_ns || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 1_000_000_000 ? Math.ceil(raw / 1_000_000_000) : Math.ceil(raw);
}

function isComplete(status) {
  return status === 'EGRESS_COMPLETE' || status === 3;
}

async function notifyReplayReady(replay) {
  if (replay.notification_sent_at) return;
  const claimedAt = new Date().toISOString();
  const leaseExpiredBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: claim, error: claimError } = await supabaseAdmin.from('live_stream_replays')
    .update({ notification_claimed_at: claimedAt })
    .eq('id', replay.id)
    .is('notification_sent_at', null)
    .or('notification_claimed_at.is.null,notification_claimed_at.lt.' + leaseExpiredBefore)
    .select('id')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claim) return;

  try {
    await sendPushToUser(replay.creator_id, {
      title: 'Your LIVE replay is ready',
      body: 'Your private replay is ready to watch for the next seven days.',
      data: { type: 'live_replay_ready', replayId: replay.id, streamId: replay.stream_id },
    });
    const { error: sentError } = await supabaseAdmin.from('live_stream_replays')
      .update({ notification_sent_at: new Date().toISOString(), notification_claimed_at: null })
      .eq('id', replay.id)
      .eq('notification_claimed_at', claimedAt);
    if (sentError) throw sentError;
  } catch (error) {
    const { error: releaseError } = await supabaseAdmin.from('live_stream_replays')
      .update({ notification_claimed_at: null })
      .eq('id', replay.id)
      .eq('notification_claimed_at', claimedAt);
    if (releaseError) console.error('[live-replay] notification claim release failed', { replayId: replay.id });
    throw error;
  }
}

async function finalizeReplay(event) {
  const info = getEgressInfo(event);
  const egressId = info?.egressId || info?.egress_id;
  if (!egressId) return { ignored: true };
  const { data: matchedReplay, error } = await supabaseAdmin
    .from('live_stream_replays')
    .select('id, file_path, status, duration_seconds, room_name, creator_id, stream_id, notification_sent_at')
    .eq('egress_id', egressId)
    .maybeSingle();
  if (error) throw error;
  let replay = matchedReplay;
  if (!replay && (info?.roomName || info?.room_name)) {
    const { data: recovered, error: recoveryError } = await supabaseAdmin.from('live_stream_replays')
      .select('id, file_path, status, duration_seconds, room_name, creator_id, stream_id, notification_sent_at')
      .eq('room_name', info.roomName || info.room_name)
      .in('status', ['starting', 'recording', 'processing'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (recoveryError) throw recoveryError;
    if (recovered) {
      replay = recovered;
      const { error: recoveryUpdateError } = await supabaseAdmin.from('live_stream_replays')
        .update({ egress_id: egressId, status: 'processing' })
        .eq('id', replay.id);
      if (recoveryUpdateError) throw recoveryUpdateError;
    }
  }
  if (!replay) return { ignored: true };
  clearLiveReplayStop(replay.id);
  if (replay.status === 'ready') {
    const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
      p_replay_id: replay.id,
      p_actual_seconds: replay.duration_seconds || 0,
      p_success: true,
    });
    if (quotaError) throw quotaError;
    await notifyReplayReady(replay);
    return { alreadyReady: true };
  }
  if (replay.status === 'failed') {
    const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
      p_replay_id: replay.id,
      p_actual_seconds: 0,
      p_success: false,
    });
    if (quotaError) throw quotaError;
    return { alreadyFailed: true };
  }
  if (replay.status === 'deleted') return { ignored: true };

  const file = getFileResults(info).find((item) => {
    const filename = item?.filename || item?.filepath || '';
    return filename === replay.file_path || filename.endsWith('/' + replay.file_path) || filename.endsWith(replay.file_path);
  });
  const size = Number(file?.size || file?.sizeBytes || file?.size_bytes || 0);
  const durationSeconds = getDurationSeconds(file);
  const valid = isComplete(info?.status) && Boolean(file) &&
    size > 0 && size <= MAX_REPLAY_BYTES &&
    durationSeconds > 0 && durationSeconds <= MAX_REPLAY_OUTPUT_SECONDS;

  if (valid) {
    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('live_stream_replays')
      .update({
        status: 'ready',
        duration_seconds: durationSeconds,
        file_size_bytes: size,
        completed_at: completedAt,
        expires_at: expiresAt,
        error_code: null,
      })
      .eq('id', replay.id)
      .in('status', ['starting', 'recording', 'processing']);
    if (updateError) throw updateError;
    const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
      p_replay_id: replay.id,
      p_actual_seconds: durationSeconds,
      p_success: true,
    });
    if (quotaError) throw quotaError;
    await notifyReplayReady({ ...replay, notification_sent_at: null });
    return { ready: true };
  }

  if (replay.file_path) {
    const { error: removeError } = await supabaseAdmin.storage.from('live-replays').remove([replay.file_path]);
    if (removeError) console.error('[live-replay] rejected file cleanup failed', { replayId: replay.id });
  }
  const { error: updateError } = await supabaseAdmin
    .from('live_stream_replays')
    .update({ status: 'failed', error_code: 'EGRESS_OUTPUT_INVALID', completed_at: new Date().toISOString() })
    .eq('id', replay.id)
    .in('status', ['starting', 'recording', 'processing']);
  if (updateError) throw updateError;
  const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
    p_replay_id: replay.id,
    p_actual_seconds: 0,
    p_success: false,
  });
  if (quotaError) throw quotaError;
  return { failed: true };
}

router.post('/egress', rawBody, async (req, res) => {
  const egressConfig = getLiveKitEgressConfig();
  if (!egressConfig || !Buffer.isBuffer(req.body)) return res.status(503).json({ error: 'LIVE replay webhook is not configured' });
  const verified = verifyLiveKitWebhook(req.body, req.get('authorization'), egressConfig);
  if (!verified) return res.status(401).json({ error: 'Invalid LiveKit webhook signature' });
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  if (event?.event !== 'egress_ended') return res.status(200).json({ ok: true, ignored: true });
  try {
    const result = await finalizeReplay(event);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('[live-replay] webhook finalization failed', { message: error.message });
    return res.status(500).json({ error: 'Replay finalization failed' });
  }
});

module.exports = router;
