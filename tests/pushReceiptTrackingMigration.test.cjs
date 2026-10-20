const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0030_push_receipt_tracking.sql'), 'utf8');

test('push receipt tracking is service-role only and indexed for pending checks', () => {
  assert.match(sql, /create table if not exists public\.push_receipt_tickets/i);
  assert.match(sql, /ticket_id text primary key/i);
  assert.match(sql, /receipt_status in \('pending', 'ok', 'error'\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.push_receipt_tickets from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on public\.push_receipt_tickets to service_role/i);
  assert.match(sql, /where receipt_status = 'pending'/i);
  assert.match(sql, /last_attempted_at timestamptz/i);
});
