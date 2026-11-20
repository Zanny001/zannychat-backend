const { supabaseAdmin } = require('../config/supabaseAdmin');
const { getEgressDurationSeconds, MAX_REPLAY_BYTES, MAX_REPLAY_OUTPUT_SECONDS } = require('./livekitEgress');
const { clearLiveReplayStop } = require('./liveReplayStopScheduler');
const { sendPushToUser } = require('../config/pushClient');

function getEgressInfo(event) {
  return event?.egressInfo || event?.egress_info || null;
}

function getFileResults(info) {
  return info?.fileResults || info?.file_results || [];
}

const legacyReplayNotificationsInFlight = new Set();
let legacyClaimWarningLogged = false;

function isComplete(status) {
  return status === 'EGRESS_COMPLETE' || status === 3;
}

async function releaseReplayNotificationClaim(admin, replayId, claimToken) {
  try {
    const { error } = await admin.rpc('release_live_replay_ready_notification', {
      p_replay_id: replayId,
      p_claim_token: claimToken,
    });
    if (error) throw error;
  } catch (releaseError) {
    console.error('[live-replay] notification claim release failed', {
      replayId,
      message: releaseError.message,
    });
  }
}

async function notifyReplayReadyLegacy(replay, admin, sendPush, now) {
  if (legacyReplayNotificationsInFlight.has(replay.id)) return;
  legacyReplayNotificationsInFlight.add(replay.id);
  try {
    const { data: currentReplay, error: readError } = await admin
      .from('live_stream_replays')
      .select('notification_sent_at')
      .eq('id', replay.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!currentReplay || currentReplay.notification_sent_at) return { skipped: true };

    const delivery = await sendPush(replay.creator_id, {
      title: 'Your LIVE replay is ready',
      body: 'Your private replay is ready to watch for the next seven days.',
      data: { type: 'live_replay_ready', replayId: replay.id, streamId: replay.stream_id },
    });
    const { error } = await admin.from('live_stream_replays')
      .update({ notification_sent_at: now().toISOString() })
      .eq('id', replay.id)
      .is('notification_sent_at', null);
    if (error) throw error;
    return { sent: true, legacy: true };
  } finally {
    legacyReplayNotificationsInFlight.delete(replay.id);
  }
}

function isMissingReplayNotificationClaimRpc(error) {
  return error?.code === 'PGRST202' || error?.code === '42883';
}

async function notifyReplayReady(replay, dependencies = {}) {
  const admin = dependencies.admin || supabaseAdmin;
  const sendPush = dependencies.sendPush || sendPushToUser;
  const now = dependencies.now || (() => new Date());
  if (!replay?.id || replay.notification_sent_at) return { skipped: true };

  const { data: claimToken, error: claimError } = await admin.rpc('claim_live_replay_ready_notification', {
    p_replay_id: replay.id,
  });
  if (claimError) {
    if (isMissingReplayNotificationClaimRpc(claimError)) {
      if (!legacyClaimWarningLogged) {
        legacyClaimWarningLogged = true;
        console.warn('[live-replay] durable notification claim migration is pending; using legacy per-process dedupe');
      }
      return notifyReplayReadyLegacy(replay, admin, sendPush, now);
    }
    throw claimError;
  }
  if (!claimToken) return { skipped: true };

  try {
    const delivery = await sendPush(replay.creator_id, {
      title: 'Your LIVE replay is ready',
      body: 'Your private replay is ready to watch for the next seven days.',
      data: { type: 'live_replay_ready', replayId: replay.id, streamId: replay.stream_id },
    });
    if (delivery && typeof delivery === 'object' && Number(delivery.sent || 0) < 1) {
      await releaseReplayNotificationClaim(admin, replay.id, claimToken);
      return { pending: true, noTokens: Boolean(delivery.noTokens), failed: Number(delivery.failed || 0) };
    }
    const { data: completed, error: completeError } = await admin.rpc('complete_live_replay_ready_notification', {
      p_replay_id: replay.id,
      p_claim_token: claimToken,
    });
    if (completeError) throw completeError;
    if (!completed) throw new Error('LIVE replay notification claim was lost before completion');
    return { sent: true };
  } catch (error) {
    await releaseReplayNotificationClaim(admin, replay.id, claimToken);
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
  const durationSeconds = getEgressDurationSeconds(file, info);
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

module.exports = { finalizeReplay, getEgressInfo, getFileResults, isComplete, notifyReplayReady };
