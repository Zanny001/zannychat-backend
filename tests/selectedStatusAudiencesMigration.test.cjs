const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0044_selected_status_audiences.sql'), 'utf8');
const hardeningSql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0045_status_audience_recipient_read_hardening.sql'), 'utf8');

test('selected-contact audiences have an explicit recipient table and safe row policies', () => {
  assert.match(sql, /audience in \('contacts', 'only_me', 'selected_contacts'\)/i);
  assert.match(sql, /create table if not exists public\.status_audience_recipients/i);
  assert.match(sql, /recipient_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /owner_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /conversation_participants mine/i);
});

test('status visibility authorization is centralized and applied to rows and media', () => {
  assert.match(sql, /create or replace function public\.can_view_status/i);
  assert.match(sql, /s\.audience = 'selected_contacts' and exists/i);
  assert.match(sql, /create policy "Authorized viewers can read active statuses"[\s\S]*can_view_status/i);
  assert.match(sql, /create policy "Status media visible to authorized viewers"[\s\S]*can_view_status/i);
});

test('view receipts, reactions and replies enforce the selected audience', () => {
  assert.match(sql, /create policy "Eligible viewers can record own view"[\s\S]*can_view_status/i);
  assert.match(sql, /create policy "Eligible viewers can react to statuses"[\s\S]*can_view_status/i);
  assert.match(sql, /create policy "Eligible viewers can reply to statuses"[\s\S]*can_view_status/i);
});


test('recipient lookup cannot expose expired or otherwise invisible status audience rows', () => {
  assert.match(hardeningSql, /Recipients can identify active statuses shared with them[\s\S]*recipient_id = \(select auth\.uid\(\)\)[\s\S]*can_view_status\(status_id, \(select auth\.uid\(\)\)\)/i);
  assert.match(sql, /s\.expires_at > now\(\)/i);
  assert.match(sql, /revoke all on function public\.can_view_status\(uuid, uuid\) from public, anon/i);
  assert.match(hardeningSql, /drop policy if exists/i);
  assert.doesNotMatch(hardeningSql, /create table/i); // additive policy-only migration
});
