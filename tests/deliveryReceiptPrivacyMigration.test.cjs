const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0054_delivery_receipt_visibility.sql'), 'utf8');

test('delivery receipt visibility is no longer granted to every conversation participant', () => {
  assert.match(sql, /drop policy if exists "Participants can read delivery receipts in their conversations"/i);
  assert.match(sql, /create policy "Message senders and receipt owners can read delivery receipts"/i);
  assert.doesNotMatch(sql, /create policy "Participants can read delivery receipts in their conversations"/i);
});

test('receipt reads require membership plus receipt ownership or message authorship', () => {
  assert.match(sql, /private\.is_conversation_participant\(conversation_id\)/i);
  assert.match(sql, /user_id\s*=\s*\(select auth\.uid\(\)\)/i);
  assert.match(sql, /m\.sender_id\s*=\s*\(select auth\.uid\(\)\)/i);
  assert.match(sql, /m\.id\s*=\s*message_delivery_receipts\.message_id/i);
  assert.match(sql, /m\.conversation_id\s*=\s*message_delivery_receipts\.conversation_id/i);
});
