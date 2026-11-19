const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261119200000_live_events.sql'),'utf8');
const worker = fs.readFileSync(path.join(__dirname,'../src/jobs/liveEventReminders.js'),'utf8');
const index = fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');

test('LIVE Event reminders use a private durable per-user delivery queue',()=>{
  assert.ok(migration.includes('public.live_event_reminder_deliveries'));
  assert.ok(migration.includes('PRIMARY KEY (event_id,user_id)'));
  assert.ok(migration.includes("CHECK (status IN ('pending','sending','sent','failed'))"));
  assert.ok(migration.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(migration.includes('REVOKE ALL ON public.live_event_reminder_deliveries FROM PUBLIC, anon, authenticated'));
  assert.ok(migration.includes('GRANT ALL ON public.live_event_reminder_deliveries TO service_role'));
});

test('LIVE Event reminder claims are due-window scoped, idempotent and safe under concurrent workers',()=>{
  assert.ok(migration.includes("e.starts_at<=now()+interval '15 minutes'"));
  assert.ok(migration.includes("e.starts_at>now()"));
  assert.ok(migration.includes("a.status='going'"));
  assert.ok(migration.includes("i.status='accepted'"));
  assert.ok(migration.includes('SELECT e.id AS event_id,e.creator_id AS user_id FROM public.live_events e'));
  assert.ok(migration.includes('e.creator_id=d.user_id'));
  assert.ok(migration.includes("e.visibility='public'"));
  assert.ok(migration.includes("e.visibility='followers' AND EXISTS ("));
  assert.ok(migration.includes("e.visibility='private' AND EXISTS ("));
  assert.ok(migration.includes('SELECT a.event_id,a.user_id FROM public.live_event_attendees a'));
  assert.ok(migration.includes('SELECT i.event_id,i.invited_user_id AS user_id FROM public.live_event_invites i'));
  assert.ok(migration.includes('ON CONFLICT(event_id,user_id) DO NOTHING'));
  assert.ok(migration.includes('FOR UPDATE OF d SKIP LOCKED'));
  assert.ok(migration.includes('b.blocker_id=e.creator_id AND b.blocked_id=d.user_id'));
  assert.ok(migration.includes('b.blocker_id=d.user_id AND b.blocked_id=e.creator_id'));
  assert.ok(migration.includes("e.starts_at<=now()+interval '15 minutes'"));
  assert.ok(migration.includes("d.status='sending' AND d.claimed_at<now()-interval '10 minutes'"));
  assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.claim_live_event_reminders(integer) TO service_role'));
});

test('LIVE Event reminder worker records accepted push tickets and retries safe failures',()=>{
  assert.ok(worker.includes("rpc('claim_live_event_reminders'"));
  assert.ok(worker.includes("type: 'live_event_reminder'"));
  assert.ok(worker.includes("status: acceptedByProvider ? 'sent' : 'failed'"));
  assert.ok(worker.includes(".eq('status', 'sending')"));
  assert.ok(worker.includes('sendPushToUser'));
  assert.ok(worker.includes('setInterval(tick, 60_000)'));
  assert.ok(worker.includes('setTimeout(tick, 12_000)'));
  assert.ok(index.includes("require('./jobs/liveEventReminders')"));
  assert.ok(index.includes('startLiveEventReminderWorker();'));
});
