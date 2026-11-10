const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { retryDelay, runCallInvitationNotifications } = require('../src/jobs/callInvitationNotifications');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0066_profile_privacy_and_attachment_cleanup.sql'), 'utf8');
const targetedSql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110190000_scope_call_invitation_claims.sql'), 'utf8');

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
  assert.match(targetedSql, /claim_call_invitation_notifications\(p_limit integer, p_call_id uuid\)/i);
  assert.match(targetedSql, /p_call_id is null or q\\.call_id = p_call_id/i);
  assert.match(targetedSql, /for update skip locked/i);
  assert.match(targetedSql, /grant execute on function public\\.claim_call_invitation_notifications\(integer, uuid\) to service_role/i);
});
