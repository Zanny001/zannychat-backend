const { supabaseAdmin } = require('../config/supabaseAdmin');
const { sendPushToUser } = require('../config/pushClient');

const LIVE_STREAM_MAX_DURATION_SECONDS = 4 * 60 * 60;
const LIVE_STREAM_WARNING_SECONDS = 10 * 60;

async function runLiveStreamTimeoutWarnings({ admin = supabaseAdmin, send = sendPushToUser } = {}) {
  if (!admin) return { claimed: 0, sent: 0, failed: 0 };
  const { data, error } = await admin.rpc('claim_live_stream_timeout_warnings');
  // The migration is deliberately applied only after operator approval. During
  // the code-first rollout window, retry quietly until PostgREST exposes it.
  if (error && (error.code === 'PGRST202' || error.code === '42883'
      || /claim_live_stream_timeout_warnings.*(not found|does not exist)/i.test(error.message || ''))) {
    return { claimed: 0, sent: 0, failed: 0, migrationPending: true };
  }
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  let sent = 0;
  let failed = 0;

  for (const warning of rows) {
    let delivered = false;
    try {
      const result = await send(warning.recipient_id, {
        title: 'Your LIVE ends in 10 minutes',
        body: String(warning.broadcast_title || 'Your LIVE broadcast') +
          ' will automatically end when it reaches the four-hour limit.',
        data: { type: 'live_stream_timeout_warning', streamId: warning.broadcast_id },
      });
      delivered = Number(result?.sent || 0) > 0;
      if (delivered) sent += 1;
      else failed += 1;
    } catch (sendError) {
      failed += 1;
      console.warn('[live-timeout] creator warning push failed:', sendError?.message || 'provider error');
    }

    // A claim is only final after provider acceptance. Successful deliveries
    // are committed separately; an interrupted worker's claim expires after
    // ten minutes and can be recovered by another process.
    if (delivered) {
      const { error: markError } = await admin.rpc('mark_live_stream_timeout_warning_sent', {
        p_broadcast_id: warning.broadcast_id,
      });
      if (markError) {
        console.error('[live-timeout] failed to persist delivered warning:', {
          streamId: warning.broadcast_id,
          message: markError.message || 'database error',
        });
      }
    } else {
      const { error: releaseError } = await admin.rpc('release_live_stream_timeout_warning', {
        p_broadcast_id: warning.broadcast_id,
      });
      if (releaseError) {
        console.error('[live-timeout] failed to release warning for retry:', {
          streamId: warning.broadcast_id,
          message: releaseError.message || 'database error',
        });
      }
    }
  }
  return { claimed: rows.length, sent, failed };
}

function startLiveStreamTimeoutWarningWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runLiveStreamTimeoutWarnings();
      if (summary.claimed) console.info('[live-timeout] creator warning batch', summary);
    } catch (error) {
      console.error('[live-timeout] warning worker failed:', error?.message || error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 30_000);
  timer.unref?.();
  const warmup = setTimeout(tick, 8_000);
  warmup.unref?.();
  return timer;
}

module.exports = {
  LIVE_STREAM_MAX_DURATION_SECONDS,
  LIVE_STREAM_WARNING_SECONDS,
  runLiveStreamTimeoutWarnings,
  startLiveStreamTimeoutWarningWorker,
};
