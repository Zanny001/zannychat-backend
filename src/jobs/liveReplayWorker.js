const supabaseAdmin = require('../config/supabaseAdmin');
const { getLiveKitEgressConfig, stopEgress, listEgress, MAX_REPLAY_SECONDS } = require('../services/livekitEgress');

const STOP_SCAN_MS = 15000;
const CLEANUP_SCAN_MS = 6 * 60 * 60 * 1000;
const EXPIRY_MS = MAX_REPLAY_SECONDS * 1000;
let started = false;

async function stopExpiredLiveReplays(now = Date.now()) {
  const egressConfig = getLiveKitEgressConfig();
  if (!egressConfig) return { scanned: 0, stopped: 0 };
  const cutoff = new Date(now - EXPIRY_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('live_stream_replays')
    .select('id, egress_id, room_name, status, started_at')
    .in('status', ['starting', 'recording'])
    .lte('started_at', cutoff)
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
      } catch (error) {
        console.error('[live-replay] Egress recovery lookup failed', { replayId: replay.id, message: error.message });
        continue;
      }
      if (!egressId) {
        const startedAt = new Date(replay.started_at || now).getTime();
        if (now - startedAt >= 15 * 60 * 1000) {
          await supabaseAdmin.from('live_stream_replays')
            .update({
              status: 'failed',
              error_code: 'EGRESS_START_TIMEOUT',
              completed_at: new Date(now).toISOString(),
              expires_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
            })
            .eq('id', replay.id)
            .in('status', ['starting', 'recording']);
          await supabaseAdmin.rpc('finalize_live_replay_quota', {
            p_replay_id: replay.id,
            p_actual_seconds: 0,
            p_success: false,
          });
        }
        continue;
      }
      await supabaseAdmin.from('live_stream_replays')
        .update({ egress_id: egressId, status: 'recording' })
        .eq('id', replay.id);
    }
    try {
      await stopEgress(egressId, egressConfig);
      await supabaseAdmin.from('live_stream_replays')
        .update({ status: 'processing' })
        .eq('id', replay.id)
        .in('status', ['starting', 'recording']);
      stopped += 1;
    } catch (error) {
      if (error.message.includes('HTTP 404')) {
        await supabaseAdmin.from('live_stream_replays')
          .update({ status: 'processing' })
          .eq('id', replay.id)
          .in('status', ['starting', 'recording']);
        continue;
      }
      console.error('[live-replay] expiry stop failed', { replayId: replay.id, message: error.message });
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
    await supabaseAdmin.rpc('finalize_live_replay_quota', {
      p_replay_id: row.id,
      p_actual_seconds: MAX_REPLAY_SECONDS,
      p_success: true,
    });
  }
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
  const stopTimer = setInterval(() => safeRun('expiry scan', () => stopExpiredLiveReplays()), STOP_SCAN_MS);
  const cleanupTimer = setInterval(() => safeRun('retention cleanup', () => cleanupExpiredLiveReplays()), CLEANUP_SCAN_MS);
  stopTimer.unref?.();
  cleanupTimer.unref?.();
}

module.exports = { stopExpiredLiveReplays, cleanupExpiredLiveReplays, startLiveReplayWorker };
