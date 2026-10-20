const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0031_message_delivery_receipts.sql'), 'utf8');

test('delivery receipts are unique per message and recipient and indexed by conversation', () => {
  assert.match(sql, /primary key\s*\(message_id, user_id\)/i);
  assert.match(sql, /message_delivery_receipts_conversation_idx/i);
  assert.match(sql, /delivered_at timestamptz not null default now\(\)/i);
});

test('only conversation participants can read receipts', () => {
  assert.match(sql, /Participants can read delivery receipts[\s\S]*?for select to authenticated\s+using/i);
  assert.match(sql, /private\.is_conversation_participant\(conversation_id\)/i);
});

test('users can only acknowledge incoming messages as themselves', () => {
  assert.match(sql, /Recipients can acknowledge delivery[\s\S]*?for insert to authenticated\s+with check/i);
  assert.match(sql, /user_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /m\.sender_id <> \(select auth\.uid\(\)\)/i);
  assert.match(sql, /revoke all on public\.message_delivery_receipts from public, anon/i);
});
