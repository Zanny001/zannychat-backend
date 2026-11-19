const { supabaseAdmin } = require('../config/supabaseAdmin');
const { sendPushToUser } = require('../config/pushClient');

async function runLiveEventReminders({ admin = supabaseAdmin, send = sendPushToUser, limit = 50 } = {}) {
  if (!admin) return { claimed: 0, sent: 0, failed: 0 };
  const { data, error } = await admin.rpc('claim_live_event_reminders', { p_limit: limit });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  let sent = 0;
  let failed = 0;

  for (const reminder of rows) {
    let acceptedByProvider = false;
    try {
      const result = await send(reminder.user_id, {
        title: 'Your LIVE Event starts soon',
        body: String(reminder.event_title || 'Your LIVE Event') + ' is starting soon.',
        data: { type: 'live_event_reminder', eventId: reminder.event_id },
      });
      // Any accepted device ticket is enough to avoid duplicate delivery to
      // devices that already received the notification. Expo receipts are
      // reconciled by the existing push receipt worker.
      acceptedByProvider = Number(result?.sent || 0) > 0;
    } catch (sendError) {
      console.warn('[live-events] reminder push attempt failed:', sendError?.message || 'provider error');
    }

    const now = new Date().toISOString();
    const { error: updateError } = await admin.from('live_event_reminder_deliveries')
      .update({
        status: acceptedByProvider ? 'sent' : 'failed',
        sent_at: acceptedByProvider ? now : null,
        last_error: acceptedByProvider ? null : 'No push device accepted the reminder; it may be retried before the Event starts.',
        updated_at: now,
      })
      .eq('event_id', reminder.event_id)
      .eq('user_id', reminder.user_id)
      .eq('status', 'sending');
    if (updateError) throw updateError;
    if (acceptedByProvider) sent += 1;
    else failed += 1;
  }
  return { claimed: rows.length, sent, failed };
}

function startLiveEventReminderWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runLiveEventReminders({ limit: 50 });
      if (summary.claimed) console.info('[live-events] reminder batch', summary);
    } catch (error) {
      console.error('[live-events] reminder worker failed:', error?.message || error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  const warmup = setTimeout(tick, 12_000);
  warmup.unref?.();
  return timer;
}

module.exports = { runLiveEventReminders, startLiveEventReminderWorker };
