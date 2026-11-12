const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { retryDelay, runCallInvitationNotifications } = require('../src/jobs/callInvitationNotifications');
const { getCallEventTokenActor } = require('../src/services/callEventToken');
const { runCallEndNotifications, enqueueCallEndNotification } = require('../src/jobs/callEndNotifications');
const callEndSql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261112114500_durable_call_end_notifications.sql'), 'utf8');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192943_profile_privacy_and_attachment_cleanup_0066.sql'), 'utf8');
const targetedSql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110065545_scope_call_invitation_claims.sql'), 'utf8');

test('call notification retries are bounded', () => {
  assert.equal(retryDelay(0), 15_000);
  assert.equal(retryDelay(1), 30_000);
  assert.equal(retryDelay(20), 15 * 60_000);
});

test('call notification worker expires stale sessions and sends only active invitations', async () => {
  const updates = [];
  const pushes = [];
  let rpcCall;
  const admin = {
    rpc: async (fn, args) => { rpcCall = { fn, args }; return { data: [{ call_id: 'c1', attempt_count: 0 }, { call_id: 'c2', attempt_count: 0 }], error: null }; },
    from(table) {
      if (table === 'call_invitation_notifications') return { update: (values) => ({ eq: async (_k, id) => { updates.push({ id, values }); return { error: null }; } }) };
      if (table === 'call_sessions') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tableCallId === 'c1' ? { id: 'c1', status: 'ringing', expires_at: '2026-11-05T09:00:00.000Z' } : { id: 'c2', status: 'ringing', expires_at: '2026-11-05T07:00:00.000Z', caller_id: 'u1', callee_id: 'u2', call_type: 'audio', conversation_id: 'conv' }, error: null }) }) }) };
      if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Caller' }, error: null }) }) }) };
      throw new Error(`unexpected table ${table}`);
    },
  };
  let tableCallId = null;
  const originalFrom = admin.from.bind(admin);
  admin.from = (table) => {
    if (table === 'call_sessions') {
      return { select: () => ({ eq: (_key, id) => ({ maybeSingle: async () => ({ data: id === 'c1' ? { id, status: 'ringing', expires_at: '2026-11-05T09:00:00.000Z', caller_id: 'u1', callee_id: 'u2', call_type: 'audio', conversation_id: 'conv' } : { id, status: 'ringing', expires_at: '2026-11-05T07:00:00.000Z', caller_id: 'u1', callee_id: 'u2', call_type: 'audio', conversation_id: 'conv' }, error: null }) }) }) };
    }
    return originalFrom(table);
  };
  const result = await runCallInvitationNotifications({ admin, now: () => new Date('2026-11-05T08:00:00.000Z'), sendPush: async (...args) => { pushes.push(args); return { sent: 1, failed: 0 }; } });
  assert.deepEqual(rpcCall, { fn: 'claim_call_invitation_notifications', args: { p_limit: 20, p_call_id: null } });
  assert.equal(result.sent, 1);
  assert.equal(result.expired, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][0], 'u2');
  assert.ok(updates.some((entry) => entry.id === 'c2' && entry.values.status === 'expired'));
});

test('call invitation queue is durable, idempotent, and claimed safely without pg_net', () => {
  assert.match(sql, /create table if not exists public\.call_invitation_notifications/);
  assert.match(sql, /call_id uuid primary key references public\.call_sessions/);
  assert.match(sql, /create or replace function public\.enqueue_call_invitation_notification/);
  assert.match(sql, /insert into public\.call_invitation_notifications\(call_id, caller_id, callee_id\)/);
  assert.match(sql, /on conflict \(call_id\) do nothing/);
  assert.match(sql, /create trigger on_call_session_created_notify/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /revoke all on function public\.claim_call_invitation_notifications\(integer\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.claim_call_invitation_notifications\(integer\) to service_role/);
  assert.doesNotMatch(sql, /net\.http_post|app\.backend_url|app\.webhook_secret|\/webhooks\/call-notifications/i);
});


test('targeted invitation processing claims only the requested call', async () => {
  const updates = [];
  let rpcArgs;
  const admin = {
    rpc: async (_fn, args) => { rpcArgs = args; return { data: [{ call_id: 'target-call', attempt_count: 0 }], error: null }; },
    from(table) {
      if (table === 'call_sessions') return { select: () => ({ eq: (_key, id) => ({ maybeSingle: async () => ({ data: { id, caller_id: 'caller', callee_id: 'callee', conversation_id: 'conv', call_type: 'video', status: 'ringing', expires_at: '2026-11-05T09:00:00.000Z' }, error: null }) }) }) };
      if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Caller' }, error: null }) }) }) };
      if (table === 'call_invitation_notifications') return { update: (values) => ({ eq: async (_key, id) => { updates.push({ id, values }); return { error: null }; } }) };
      throw new Error('Unexpected table ' + table);
    },
  };
  const result = await runCallInvitationNotifications({ admin, callId: 'target-call', now: () => new Date('2026-11-05T08:00:00.000Z'), sendPush: async () => ({ sent: 1, failed: 0 }) });
  assert.deepEqual(rpcArgs, { p_limit: 20, p_call_id: 'target-call' });
  assert.equal(result.sent, 1);
  assert.ok(updates.some((item) => item.id === 'target-call' && item.values.status === 'delivered'));
});

test('invitation without registered push tokens is expired instead of pointlessly retried', async () => {
  const updates = [];
  const admin = {
    rpc: async () => ({ data: [{ call_id: 'no-token-call', attempt_count: 0 }], error: null }),
    from(table) {
      if (table === 'call_sessions') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'no-token-call', caller_id: 'caller', callee_id: 'callee', conversation_id: 'conv', call_type: 'audio', status: 'ringing', expires_at: '2026-11-05T09:00:00.000Z' }, error: null }) }) }) };
      if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Caller' }, error: null }) }) }) };
      if (table === 'call_invitation_notifications') return { update: (values) => ({ eq: async (_key, id) => { updates.push({ id, values }); return { error: null }; } }) };
      throw new Error('Unexpected table ' + table);
    },
  };
  const result = await runCallInvitationNotifications({ admin, now: () => new Date('2026-11-05T08:00:00.000Z'), sendPush: async () => ({ sent: 0, failed: 0, noTokens: true }) });
  assert.equal(result.noTokens, 1);
  assert.equal(result.retried, 0);
  assert.ok(updates.some((item) => item.id === 'no-token-call' && item.values.status === 'expired'));
});

test('scoped claim migration limits claims and keeps execution service-role-only', () => {
  assert.ok(targetedSql.includes('p_limit integer,'));
  assert.ok(targetedSql.includes('p_call_id uuid'));
  assert.ok(targetedSql.includes('p_call_id IS NULL OR q.call_id = p_call_id'));
  assert.ok(targetedSql.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(targetedSql.includes('GRANT EXECUTE ON FUNCTION public.claim_call_invitation_notifications(integer, uuid) TO service_role'));
});


test('Expo call pushes request the actionable incoming-call notification category', () => {
  const pushClient = fs.readFileSync(path.join(__dirname, '../src/config/pushClient.js'), 'utf8');
  assert.ok(pushClient.includes("categoryId: data?.type === 'incoming_call' ? 'incoming-call' : undefined"));
  assert.ok(pushClient.includes("sound: ['incoming_call', 'group_call_invite'].includes(data?.type) ? 'call_ring.wav' : 'default'"));
});

test('native VoIP delivery is preferred and avoids duplicate Expo notifications', async () => {
  const updates = [];
  let expoSent = 0;
  const admin = {
    rpc: async () => ({ data: [{ call_id: '123e4567-e89b-12d3-a456-426614174000', attempt_count: 0 }], error: null }),
    from(table) {
      if (table === 'call_sessions') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
        id: '123e4567-e89b-12d3-a456-426614174000', caller_id: '123e4567-e89b-12d3-a456-426614174001', callee_id: '123e4567-e89b-12d3-a456-426614174002', conversation_id: 'conv',
        call_type: 'video', status: 'ringing', created_at: '2026-11-05T08:00:00.000Z',
        expires_at: '2026-11-05T08:01:00.000Z',
      }, error: null }) }) }) };
      if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Caller', avatar_url: null }, error: null }) }) }) };
      if (table === 'call_invitation_notifications') return { update: (values) => ({ eq: async (_key, id) => { updates.push({ id, values }); return { error: null }; } }) };
      throw new Error('Unexpected table ' + table);
    },
  };
  const previousSigning = process.env.CALL_EVENT_SIGNING_SECRET;
  process.env.CALL_EVENT_SIGNING_SECRET = 'call-invitation-worker-test-secret';
  const result = await runCallInvitationNotifications({
    admin,
    now: () => new Date('2026-11-05T08:00:00.000Z'),
    sendVoipPush: async (_admin, userId, event) => {
      assert.equal(userId, '123e4567-e89b-12d3-a456-426614174002');
      assert.equal(event.serverCallId, '123e4567-e89b-12d3-a456-426614174000');
      assert.equal(event.hasVideo, true);
      assert.ok(event.metadata.serverEventToken);
      assert.equal(getCallEventTokenActor('123e4567-e89b-12d3-a456-426614174000', event.metadata.serverEventToken, Date.parse('2026-11-05T08:00:00.000Z')), '123e4567-e89b-12d3-a456-426614174002');
      return { sent: 1, failed: 0 };
    },
    sendPush: async () => { expoSent += 1; return { sent: 1, failed: 0 }; },
  });
  assert.equal(result.voipSent, 1);
  assert.equal(result.sent, 0);
  assert.equal(expoSent, 0);
  assert.ok(updates.some((item) => item.id === '123e4567-e89b-12d3-a456-426614174000' && item.values.status === 'delivered'));
  if (previousSigning === undefined) delete process.env.CALL_EVENT_SIGNING_SECRET;
  else process.env.CALL_EVENT_SIGNING_SECRET = previousSigning;
});


test('native VoIP is withheld when a signed terminal-event credential cannot be issued', async () => {
  const previousSigning = process.env.CALL_EVENT_SIGNING_SECRET;
  const previousService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.CALL_EVENT_SIGNING_SECRET;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let voipCalls = 0;
  let expoCalls = 0;
  const admin = {
    rpc: async () => ({ data: [{ call_id: 'unsigned-call', attempt_count: 0 }], error: null }),
    from(table) {
      if (table === 'call_sessions') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
        id: 'unsigned-call', caller_id: 'caller', callee_id: 'callee', conversation_id: 'conv',
        call_type: 'audio', status: 'ringing', created_at: '2026-11-05T08:00:00.000Z',
        expires_at: '2026-11-05T08:01:00.000Z',
      }, error: null }) }) }) };
      if (table === 'profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Caller', avatar_url: null }, error: null }) }) }) };
      if (table === 'call_invitation_notifications') return { update: () => ({ eq: async () => ({ error: null }) }) };
      throw new Error('Unexpected table ' + table);
    },
  };
  try {
    const result = await runCallInvitationNotifications({
      admin,
      now: () => new Date('2026-11-05T08:00:00.000Z'),
      sendVoipPush: async () => { voipCalls += 1; return { sent: 1, failed: 0 }; },
      sendPush: async () => { expoCalls += 1; return { sent: 1, failed: 0 }; },
    });
    assert.equal(voipCalls, 0);
    assert.equal(expoCalls, 1);
    assert.equal(result.sent, 1);
  } finally {
    if (previousSigning === undefined) delete process.env.CALL_EVENT_SIGNING_SECRET;
    else process.env.CALL_EVENT_SIGNING_SECRET = previousSigning;
    if (previousService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousService;
  }
});


test('native call-end notification queue is service-only and claims work with SKIP LOCKED leases', () => {
  assert.ok(callEndSql.includes('CREATE TABLE IF NOT EXISTS public.call_end_notifications'));
  assert.ok(callEndSql.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(callEndSql.includes('REVOKE ALL ON public.call_end_notifications FROM PUBLIC, anon, authenticated'));
  assert.ok(callEndSql.includes('GRANT ALL ON public.call_end_notifications TO service_role'));
  assert.ok(callEndSql.includes('FOR UPDATE SKIP LOCKED'));
  assert.ok(callEndSql.includes("lease_started_at <= now() - interval '2 minutes'"));
  assert.ok(callEndSql.includes('GRANT EXECUTE ON FUNCTION public.claim_call_end_notifications(integer, uuid) TO service_role'));
});
test('native call-end push is marked delivered after provider acceptance', async () => {
  const updates = [];
  const admin = {
    rpc: async (name, args) => {
      assert.equal(name, 'claim_call_end_notifications');
      assert.deepEqual(args, { p_limit: 5, p_call_id: 'call-1' });
      return { data: [{ id: 'job-1', call_id: 'call-1', recipient_id: 'user-2', terminal_status: 'ended', attempt_count: 0 }], error: null };
    },
    from(table) {
      assert.equal(table, 'call_end_notifications');
      return { update: (values) => ({ eq: async (_column, id) => { updates.push({ values, id }); return { error: null }; } }) };
    },
  };
  const result = await runCallEndNotifications({
    admin, limit: 5, callId: 'call-1',
    sendCallEnded: async (_admin, userId, callId, status) => {
      assert.deepEqual([userId, callId, status], ['user-2', 'call-1', 'ended']);
      return { sent: 1, failed: 0 };
    },
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  assert.deepEqual(result, { claimed: 1, delivered: 1, retried: 0, expired: 0, failed: 0 });
  assert.equal(updates[0].id, 'job-1');
  assert.equal(updates[0].values.status, 'delivered');
  assert.equal(updates[0].values.delivered_at, '2026-11-12T10:00:00.000Z');
});

test('native call-end push without a registered device token is retained for bounded retry', async () => {
  const updates = [];
  const admin = {
    rpc: async () => ({ data: [{ id: 'job-2', call_id: 'call-2', recipient_id: 'user-3', terminal_status: 'missed', attempt_count: 2 }], error: null }),
    from: () => ({ update: (values) => ({ eq: async () => { updates.push(values); return { error: null }; } }) }),
  };
  const result = await runCallEndNotifications({
    admin,
    sendCallEnded: async () => ({ sent: 0, failed: 0 }),
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  assert.equal(result.retried, 1);
  assert.equal(updates[0].status, 'pending');
  assert.equal(updates[0].attempt_count, 3);
  assert.equal(updates[0].last_error, 'No call-ended push provider accepted the event');
  assert.equal(Date.parse(updates[0].next_attempt_at), Date.parse('2026-11-12T10:02:00.000Z'));
});

test('call-end enqueue is idempotent and immediately attempts delivery', async () => {
  let inserted;
  let claimed = false;
  const admin = {
    from: (table) => ({
      upsert: async (row, options) => {
        assert.equal(table, 'call_end_notifications');
        inserted = { row, options };
        return { error: null };
      },
    }),
    rpc: async () => {
      claimed = true;
      return { data: [], error: null };
    },
  };
  const result = await enqueueCallEndNotification({
    admin, callId: 'call-3', recipientId: 'user-4', terminalStatus: 'cancelled',
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  assert.deepEqual(result, { claimed: 0, delivered: 0, retried: 0, expired: 0, failed: 0 });
  assert.equal(inserted.row.call_id, 'call-3');
  assert.equal(inserted.row.recipient_id, 'user-4');
  assert.deepEqual(inserted.options, { onConflict: 'call_id,recipient_id', ignoreDuplicates: true });
  assert.equal(claimed, true);
});


test('native call terminal events enqueue durable notifications instead of relying on one push attempt', () => {
  const callsRoute = fs.readFileSync(path.join(__dirname, '../src/routes/calls.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.ok(callsRoute.includes("require('../jobs/callEndNotifications')"));
  assert.ok(callsRoute.includes('enqueueCallEndNotification'));
  assert.equal(callsRoute.includes('sendCallEndedToUser(supabaseAdmin'), false);
  assert.ok(server.includes('startCallEndNotificationWorker();'));
  assert.ok(server.includes('runCallEndNotifications({ admin: supabaseAdmin, limit: 20 })'));
});
