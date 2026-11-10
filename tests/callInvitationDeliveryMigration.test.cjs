const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110025034_call_invitation_delivery.sql'), 'utf8');

test('call invitation delivery uses a private durable queue and idempotent trigger', () => {
  assert.match(sql, /create table if not exists public\.call_invitation_notifications/i);
  assert.match(sql, /call_id uuid primary key references public\.call_sessions/i);
  assert.match(sql, /on conflict \(call_id\) do nothing/i);
  assert.match(sql, /after insert on public\.call_sessions/i);
  assert.match(sql, /alter table public\.call_invitation_notifications enable row level security/i);
});

test('only the service role can claim queued invitations', () => {
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /revoke all on function public\.claim_call_invitation_notifications\(integer\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.claim_call_invitation_notifications\(integer\) to service_role/i);
  assert.doesNotMatch(sql, /grant .*call_invitation_notifications .*authenticated/i);
});

test('call invitation claim overload supports call-scoped delivery', () => {
  const targeted = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110065545_scope_call_invitation_claims.sql'), 'utf8');
  assert.ok(targeted.includes('p_call_id uuid'));
  assert.ok(targeted.includes('p_call_id IS NULL OR q.call_id = p_call_id'));
  assert.ok(targeted.includes('FOR UPDATE SKIP LOCKED'));
});
