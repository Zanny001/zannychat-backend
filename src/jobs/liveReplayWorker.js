const supabaseAdmin = require('../config/supabaseAdmin');
const { getLiveKitEgressConfig, stopEgress, listEgress, MAX_REPLAY_SECONDS } = require('../services/livekitEgress');

const RECOVERY_SCAN_MS = 60 * 1000;
const CLEANUP_SCAN_MS = 6 * 60 * 60 * 1000;
const EXPIRY_MS = MAX_REPLAY_SECONDS * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const START_RECOVERY_GRACE_MS = 15 * 60 * 1000;
const STOP_RETRY_MS = 10 * 1000;
const stopTimers = new Map();
let started = false;

function clearLiveReplayStop(replayId) {
  const timer = stopTimers.get(replayId);
  if (timer) clearTimeout(timer);
  stopTimers.delete(replayId);
}

function scheduleRetry(replayId, egressId) {
  clearLiveReplayStop(replayId);
  const timer = setTimeout(() => {
    stopTimers.delete(replayId);
    stopReplayNow(replayId, egressId).catch((error) => {
      console.error('[live-replay] scheduled stop retry failed', { replayId, message: error.message });
    });
  }, STOP_RETRY_MS);
  timer.unref?.();
  stopTimers.set(replayId, timer);
}

function scheduleLiveReplayStop(replayId, egressId, startedAt) {
  if (!replayId || !egressId) return;
  clearLiveReplayStop(replayId);
  const startedMs = new Date(startedAt || Date.now()).getTime();
  const delay = Math.max(0, startedMs + EXPIRY_MS - Date.now());
  const timer = setTimeout(() => {
    stopTimers.delete(replayId);
    stopReplayNow(replayId, egressId).catch((error) => {
      console.error('[live-replay] scheduled stop failed', { replayId, message: error.message });
    });
  }, delay);
  timer.unref?.();
  stopTimers.set(replayId, timer);
}

async function stopReplayNow(replayId, egressId) {
  const egressConfig = getLiveKitEgressConfig();
  if (!egressConfig) {
    scheduleRetry(replayId, egressId);
    return false;
  }
  try {
    await stopEgress(egressId, egressConfig);
  } catch (error) {
    if (!error.message.includes('HTTP 404')) {
      scheduleRetry(replayId, egressId);
      throw error;
    }
  }
  const { error } = await supabaseAdmin.from('live_stream_replays')
    .update({ status: 'processing' })
    .eq('id', replayId)
    .in('status', ['starting', 'recording']);
  if (error) {
    scheduleRetry(replayId, egressId);
    throw error;
  }
  clearLiveReplayStop(replayId);
  return true;
}

async function stopExpiredLiveReplays(now = Date.now()) {
  const egressConfig = getLiveKitEgressConfig();
  if (!egressConfig) return { scanned: 0, stopped: 0 };
  const { data, error } = await supabaseAdmin
    .from('live_stream_replays')
    .select('id, egress_id, room_name, status, started_at')
    .in('status', ['starting', 'recording'])
    .order('started_at', { ascending: true })
    .limit(25);
  if (error) throw error;

  let stopped = 0;
  for (const replay of data || []) {
    let egressId = replay.egress_id;
    if (!egressId) {
      try {
        const listed = await listEgress(replay.room_name, egressConfig);
        const found = (listed?.items || []).find((item) => item?.egress_id || item?.egressId);
        egressId = found?.egress_id || found?.egressId || null;
      } catch (lookupError) {
        console.error('[live-replay] Egress recovery lookup failed', { replayId: replay.id, message: lookupError.message });
        continue;
      }
      if (!egressId) {
        const startedMs = new Date(replay.started_at || now).getTime();
        if (now - startedMs >= START_RECOVERY_GRACE_MS) {
          const { error: updateError } = await supabaseAdmin.from('live_stream_replays')
            .update({
              status: 'failed',
              error_code: 'EGRESS_NOT_FOUND',
              completed_at: new Date(now).toISOString(),
              expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
            })
            .eq('id', replay.id)
            .in('status', ['starting', 'recording']);
          if (updateError) throw updateError;
          const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
            p_replay_id: replay.id,
            p_actual_seconds: 0,
            p_success: false,
          });
          if (quotaError) throw quotaError;
        }
        continue;
      }
      await supabaseAdmin.from('live_stream_replays')
        .update({ egress_id: egressId, status: 'recording' })
        .eq('id', replay.id);
    }

    scheduleLiveReplayStop(replay.id, egressId, replay.started_at);
    const startedMs = new Date(replay.started_at || now).getTime();
    if (now >= startedMs + EXPIRY_MS) {
      try {
        if (await stopReplayNow(replay.id, egressId)) stopped += 1;
      } catch (stopError) {
        console.error('[live-replay] recovery stop failed', { replayId: replay.id, message: stopError.message });
      }
    }
  }
  return { scanned: (data || []).length, stopped };
}

async function cleanupExpiredLiveReplays(now = Date.now()) {
  const cutoff = new Date(now).toISOString();
  const { data, error } = await supabaseAdmin
    .from('live_stream_replays')
    .select('id, file_path, status')
    .in('status', ['ready', 'failed', 'processing', 'deleted'])
    .not('expires_at', 'is', null)
    .lte('expires_at', cutoff)
    .limit(50);
  if (error) throw error;
  const rows = data || [];
  const paths = rows.map((row) => row.file_path).filter(Boolean);
  if (paths.length) {
    const { error: removeError } = await supabaseAdmin.storage.from('live-replays').remove(paths);
    if (removeError) throw removeError;
  }
  for (const row of rows.filter((item) => item.status === 'processing')) {
    const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
      p_replay_id: row.id,
      p_actual_seconds: MAX_REPLAY_SECONDS,
      p_success: true,
    });
    if (quotaError) throw quotaError;
  }
  for (const row of rows.filter((item) => item.status === 'failed' || item.status === 'deleted')) {
    const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
      p_replay_id: row.id,
      p_actual_seconds: 0,
      p_success: false,
    });
    if (quotaError) throw quotaError;
  }
  for (const row of rows) clearLiveReplayStop(row.id);
  if (rows.length) {
    const { error: deleteError } = await supabaseAdmin
      .from('live_stream_replays')
      .delete()
      .in('id', rows.map((row) => row.id));
    if (deleteError) throw deleteError;
  }
  return { deleted: rows.length };
}

function startLiveReplayWorker() {
  if (started) return;
  started = true;
  const safeRun = (label, fn) => fn().catch((error) => {
    console.error('[live-replay] ' + label + ' failed', { message: error.message });
  });
  safeRun('startup expiry recovery', () => stopExpiredLiveReplays());
  safeRun('startup retention cleanup', () => cleanupExpiredLiveReplays());
  const recoveryTimer = setInterval(() => safeRun('recovery scan', () => stopExpiredLiveReplays()), RECOVERY_SCAN_MS);
  const cleanupTimer = setInterval(() => safeRun('retention cleanup', () => cleanupExpiredLiveReplays()), CLEANUP_SCAN_MS);
  recoveryTimer.unref?.();
  cleanupTimer.unref?.();
}

module.exports = {
  stopExpiredLiveReplays,
  cleanupExpiredLiveReplays,
  startLiveReplayWorker,
  scheduleLiveReplayStop,
  clearLiveReplayStop,
};
