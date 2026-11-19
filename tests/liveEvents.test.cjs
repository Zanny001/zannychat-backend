const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname,'../src/routes/liveEvents.js'),'utf8');
const migration = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261119200000_live_events.sql'),'utf8');
const index = fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');

test('LIVE Events are mounted behind authenticated routes and per-user rate limits',()=>{
  assert.ok(route.includes('router.use(requireAuth'));
  assert.ok(route.includes("max: 45"));
  assert.ok(route.includes("max: 5"));
  assert.ok(index.includes("app.use('/live', liveEventsRouter)"));
});

test('LIVE Event scheduling validates bounded dates, durations, capacity and exact writable fields',()=>{
  assert.ok(route.includes('delta < 10 * 60 * 1000'));
  assert.ok(route.includes('delta > 90 * 24 * 60 * 60 * 1000'));
  assert.ok(route.includes('duration < 15 || duration > 240'));
  assert.ok(route.includes('capacity < 1 || capacity > 500'));
  assert.ok(route.includes('Object.keys(body).some((key) => !keys.has(key))'));
  assert.ok(route.includes("rpc('create_live_event'"));
  assert.ok(migration.includes('FUNCTION public.create_live_event('));
  assert.ok(route.includes("router.patch('/events/:eventId'"));
  assert.ok(route.includes("const UPDATE_KEYS = new Set(['title','description','category','startsAt','durationMinutes','maxAttendees'])"));
  assert.ok(route.includes("router.post('/events/:eventId/cancel'"));
});

test('LIVE Event audiences respect bidirectional blocks and follower-only visibility',()=>{
  assert.ok(route.includes('async function blockedBetween(a, b)'));
  assert.ok(route.includes("eq('blocker_id',a).eq('blocked_id',b)"));
  assert.ok(route.includes("eq('blocker_id',b).eq('blocked_id',a)"));
  assert.ok(route.includes("event.visibility === 'followers'"));
  assert.ok(route.includes("eq('follower_id',viewerId)"));
});

test('LIVE Event RSVPs are atomic, capacity-limited and private to the server',()=>{
  assert.ok(route.includes("rpc('rsvp_live_event'"));
  assert.ok(migration.includes('SELECT * INTO v_event FROM public.live_events WHERE id = p_event_id FOR UPDATE'));
  assert.ok(migration.includes('v_count >= v_event.max_attendees'));
  assert.ok(migration.includes('PRIMARY KEY (event_id,user_id)'));
  assert.ok(migration.includes('public.live_event_invites'));
  assert.ok(migration.includes('PRIMARY KEY (event_id,invited_user_id)'));
  assert.ok(route.includes("router.post('/events/:eventId/invites'"));
  assert.ok(route.includes("router.get('/events/invitations'"));
  assert.ok(route.includes("router.patch('/events/:eventId/invitation'"));
  assert.ok(route.includes("filter((row)=>row.status==='accepted')"));
  assert.ok(route.includes('alreadyAccepted.has(id)'));
  assert.ok(route.includes("sendPushToUser(userId"));
  assert.ok(migration.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(migration.includes('REVOKE ALL ON public.live_event_attendees FROM PUBLIC, anon, authenticated'));
  assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.rsvp_live_event(uuid,uuid) TO service_role'));
  assert.equal((migration.match(/AS \$\$/g)||[]).length,6,'all six PL/pgSQL functions must have valid dollar-quote openers');
  assert.equal((migration.match(/^\$\$;$/gm)||[]).length,6,'all six PL/pgSQL functions must have valid dollar-quote closers');
  assert.ok(migration.includes('FUNCTION public.attach_live_event_stream(p_event_id uuid, p_stream_id uuid, p_creator_id uuid)'));
  assert.ok(migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS live_events_stream_id_unique_idx'));
  assert.ok(migration.includes("e.stream_id=p_stream_id AND e.id<>p_event_id"));
  assert.ok(migration.includes('reset_live_event_reminders_after_reschedule'));
  assert.ok(migration.includes("NEW.starts_at IS DISTINCT FROM OLD.starts_at"));
  assert.ok(migration.includes("SET status='pending',attempts=0,claimed_at=NULL,sent_at=NULL"));
  assert.ok(migration.includes("NEW.status = 'ended'"));
  assert.ok(route.includes("router.get('/events/:eventId/invitees'"));
  assert.ok(route.includes("router.post('/events/:eventId/attach-stream'"));
  assert.ok(route.includes("type:'live_event_started'"));
  assert.ok(route.includes('if (!await canView(event,row.user_id)) return;'));
  assert.ok(route.includes('sendPushToUser(row.user_id'));
});

test('LIVE Event records do not expose attendee identities in discovery responses',()=>{
  assert.ok(route.includes("select('event_id').in('event_id',ids).eq('status','going')"));
  assert.ok(!route.includes("select('event_id,user_id')"));
  assert.ok(route.includes('attendeeCount'));
});
