const { supabaseAdmin } = require('../config/supabaseAdmin');
const { getLiveKitEgressConfig, getLiveReplayConfig, isLiveReplayEnabled, validateReplayCredentials, stopEgress, listEgress, MAX_REPLAY_SECONDS } = require('../services/livekitEgress');
const { validateRoomAdminCredentials } = require('../services/livekitRoomAdmin');
const { finalizeReplay, notifyReplayReady } = require('../services/liveReplayFinalizer');
const { setLiveReplayStopTimer, clearLiveReplayStop } = require('../services/liveReplayStopScheduler');

const RECOVERY_SCAN_MS = 60 * 1000;
const CLEANUP_SCAN_MS = 6 * 60 * 60 * 1000;
const EXPIRY_MS = MAX_REPLAY_SECONDS * 1000;
const START_RECOVERY_GRACE_MS = 15 * 60 * 1000;
const STOP_RETRY_MS = 10 * 1000;
let started = false;

function scheduleRetry(replayId, egressId) {
  clearLiveReplayStop(replayId);
  const timer = setTimeout(() => {
    clearLiveReplayStop(replayId);
    stopReplayNow(replayId, egressId).catch((error) => {
      console.error('[live-replay] scheduled stop retry failed', { replayId, message: error.message });
    });
  }, STOP_RETRY_MS);
  timer.unref?.();
  setLiveReplayStopTimer(replayId, timer);
}

function scheduleLiveReplayStop(replayId, egressId, startedAt) {
  if (!replayId || !egressId) return;
  clearLiveReplayStop(replayId);
  const startedMs = new Date(startedAt || Date.now()).getTime();
  const delay = Math.max(0, startedMs + EXPIRY_MS - Date.now());
  const timer = setTimeout(() => {
    clearLiveReplayStop(replayId);
    stopReplayNow(replayId, egressId).catch((error) => {
      console.error('[live-replay] scheduled stop failed', { replayId, message: error.message });
    });
  }, delay);
  timer.unref?.();
  setLiveReplayStopTimer(replayId, timer);
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

function getEgressId(info) {
  return info?.egressId || info?.egress_id || null;
}

function getEgressOutputPaths(info) {
  const request = info?.request || info?.egress || info?.roomComposite || info?.room_composite || {};
  const outputs = request.outputs || request.fileOutputs || request.file_outputs || [];
  const paths = [];
  for (const output of outputs) {
    const file = output?.file || output?.config?.file || output;
    const filepath = file?.filepath || file?.filePath;
    if (typeof filepath === 'string' && filepath) paths.push(filepath);
  }
  const results = info?.fileResults || info?.file_results || [];
  for (const result of results) {
    const filename = result?.filename || result?.filepath || '';
    if (filename) paths.push(filename);
  }
  return paths;
}

function matchesReplayEgress(info, replay) {
  const egressId = getEgressId(info);
  if (replay.egress_id && egressId === replay.egress_id) return true;
  if (!replay.file_path) return false;
  return getEgressOutputPaths(info).some((filepath) =>
    filepath === replay.file_path ||
    filepath.endsWith('/' + replay.file_path) ||
    filepath.endsWith(replay.file_path)
  );
}

function isTerminalEgressStatus(status) {
  return ['EGRESS_COMPLETE', 'EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED', 3, 4, 5, 6].includes(status);
}

async function reconcileCompletedLiveReplays() {
  const egressConfig = getLiveKitEgressConfig();
  if (!egressConfig || !supabaseAdmin) return { scanned: 0, reconciled: 0 };
  const { data, error } = await supabaseAdmin.from('live_stream_replays')
    .select('id,egress_id,room_name,file_path,status')
    .eq('status', 'processing')
    .order('updated_at', { ascending: true })
    .limit(25);
  if (error) throw error;

  let reconciled = 0;
  for (const replay of data || []) {
    if (!replay.room_name) continue;
    try {
      // active:false asks LiveKit for completed as well as active Egress records.
      // Match the persisted Egress ID when available, otherwise the exact
      // per-replay output path; never adopt an unrelated recording in the room.
      const listed = await listEgress(replay.room_name, egressConfig, undefined, {
        active: false,
        egressId: replay.egress_id || undefined,
      });
      const info = (listed?.items || []).find((item) => matchesReplayEgress(item, replay));
      if (!info || !isTerminalEgressStatus(info.status)) continue;
      const egressId = getEgressId(info);
      if (!egressId) continue;
      if (!replay.egress_id) {
        const { error: persistError } = await supabaseAdmin.from('live_stream_replays')
          .update({ egress_id: egressId })
          .eq('id', replay.id)
          .eq('status', 'processing');
        if (persistError) throw persistError;
      }
      const result = await finalizeReplay({ event: 'egress_ended', egressInfo: info });
      if (result?.ready || result?.failed || result?.alreadyReady || result?.alreadyFailed) reconciled += 1;
    } catch (reconcileError) {
      console.error('[live-replay] completed Egress reconciliation failed', {
        replayId: replay.id,
        message: reconcileError.message,
      });
    }
  }
  return { scanned: (data || []).length, reconciled };
}


async function deliverPendingReplayReadyNotifications(dependencies = {}) {
  const admin = dependencies.admin || supabaseAdmin;
  const notify = dependencies.notify || notifyReplayReady;
  if (!admin) return { scanned: 0, notified: 0 };
  const { data, error } = await admin.from('live_stream_replays')
    .select('id,creator_id,stream_id,notification_sent_at')
    .eq('status', 'ready')
    .is('notification_sent_at', null)
    .order('updated_at', { ascending: true })
    .limit(25);
  if (error) throw error;

  let notified = 0;
  for (const replay of data || []) {
    try {
      await notify(replay);
      notified += 1;
    } catch (notifyError) {
      console.error('[live-replay] ready notification retry failed', {
        replayId: replay.id,
        message: notifyError.message,
      });
    }
  }
  return { scanned: (data || []).length, notified };
}

async function stopExpiredLiveReplays(now = Date.now()) {
  const egressConfig = getLiveKitEgressConfig();
  if (!egressConfig) return { scanned: 0, stopped: 0 };
  const { data, error } = await supabaseAdmin
    .from('live_stream_replays')
    .select('id, stream_id, egress_id, room_name, status, started_at')
    .in('status', ['starting', 'recording'])
    .order('started_at', { ascending: true })
    .limit(25);
  if (error) throw error;

  const streamIds = [...new Set((data || []).map((replay) => replay.stream_id).filter(Boolean))];
  const { data: streams, error: streamsError } = streamIds.length
    ? await supabaseAdmin.from('live_streams').select('id,status').in('id', streamIds)
    : { data: [], error: null };
  if (streamsError) throw streamsError;
  const foundStreamIds = new Set((streams || []).map((stream) => stream.id));
  const endedStreamIds = new Set((streams || []).filter((stream) => stream.status !== 'live').map((stream) => stream.id));

  let stopped = 0;
  for (const replay of data || []) {
    let egressId = replay.egress_id;
    if (!egressId) {
      try {
        const listed = await listEgress(replay.room_name, egressConfig, undefined, { active: false });
        const found = (listed?.items || []).find((item) => matchesReplayEgress(item, replay));
        egressId = getEgressId(found);
        if (found && egressId && isTerminalEgressStatus(found.status)) {
          const { error: persistError } = await supabaseAdmin.from('live_stream_replays')
            .update({ egress_id: egressId })
            .eq('id', replay.id)
            .in('status', ['starting', 'recording']);
          if (persistError) throw persistError;
          await finalizeReplay({ event: 'egress_ended', egressInfo: found });
          continue;
        }
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
      const { error: persistError } = await supabaseAdmin.from('live_stream_replays')
        .update({ egress_id: egressId, status: 'recording' })
        .eq('id', replay.id)
        .in('status', ['starting', 'recording']);
      if (persistError) throw persistError;
    }

    scheduleLiveReplayStop(replay.id, egressId, replay.started_at);
    const startedMs = new Date(replay.started_at || now).getTime();
    if (!foundStreamIds.has(replay.stream_id) || endedStreamIds.has(replay.stream_id) || now >= startedMs + EXPIRY_MS) {
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
  for (const row of rows.filter((item) => item.status === 'processing' || item.status === 'failed' || item.status === 'deleted')) {
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
  if (started || !supabaseAdmin) return;
  started = true;
  const replayConfig = getLiveReplayConfig();
  console.info('[live-replay] configuration status', {
    egressCredentialsConfigured: Boolean(getLiveKitEgressConfig()),
    storageCredentialsConfigured: Boolean(replayConfig?.storage),
    replayEnabled: isLiveReplayEnabled(),
  });
  const safeRun = (label, fn) => fn().catch((error) => {
    console.error('[live-replay] ' + label + ' failed', { message: error.message });
  });
  safeRun('read-only room admin credential validation', async () => {
    const authenticated = await validateRoomAdminCredentials();
    console.info('[live-stage] room admin credential validation', { authenticated });
  });
  if (replayConfig) {
    safeRun('read-only credential validation', async () => {
      const validation = await validateReplayCredentials(replayConfig);
      console.info('[live-replay] credential validation', validation);
    });
  }
  safeRun('startup expiry recovery', () => stopExpiredLiveReplays());
  safeRun('startup completed Egress reconciliation', () => reconcileCompletedLiveReplays());
  safeRun('startup pending replay-ready notifications', () => deliverPendingReplayReadyNotifications());
  safeRun('startup retention cleanup', () => cleanupExpiredLiveReplays());
  const recoveryTimer = setInterval(() => safeRun('recovery scan', () => stopExpiredLiveReplays()), RECOVERY_SCAN_MS);
  const reconciliationTimer = setInterval(() => safeRun('completed Egress reconciliation', () => reconcileCompletedLiveReplays()), RECOVERY_SCAN_MS);
  const notificationTimer = setInterval(() => safeRun('pending replay-ready notifications', () => deliverPendingReplayReadyNotifications()), RECOVERY_SCAN_MS);
  const cleanupTimer = setInterval(() => safeRun('retention cleanup', () => cleanupExpiredLiveReplays()), CLEANUP_SCAN_MS);
  recoveryTimer.unref?.();
  reconciliationTimer.unref?.();
  notificationTimer.unref?.();
  cleanupTimer.unref?.();
}

module.exports = {
  stopExpiredLiveReplays,
  reconcileCompletedLiveReplays,
  deliverPendingReplayReadyNotifications,
  cleanupExpiredLiveReplays,
  startLiveReplayWorker,
  scheduleLiveReplayStop,
  clearLiveReplayStop,
};
