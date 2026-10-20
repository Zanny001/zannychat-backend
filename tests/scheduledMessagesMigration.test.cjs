const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0043_scheduled_messages.sql'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/conversations.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'src/jobs/scheduledMessages.js'), 'utf8');

test('scheduled message table has bounded content, lifecycle states and due indexes', () => {
  assert.match(migration, /create table if not exists public\.scheduled_messages/i);
  assert.match(migration, /char_length\(text\) between 1 and 4000/i);
  assert.match(migration, /'pending', 'sent', 'cancelled'/i);
  assert.match(migration, /where status = 'pending'/i);
});

test('scheduled messages are inaccessible to client database roles', () => {
  assert.match(migration, /alter table public\.scheduled_messages enable row level security/i);
  assert.match(migration, /revoke all on public\.scheduled_messages from anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.deliver_due_scheduled_messages\(integer\) to service_role/i);
});

test('delivery claims rows with skip-locked semantics and verifies current membership', () => {
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /where cp\.conversation_id = item\.conversation_id and cp\.user_id = item\.sender_id/i);
  assert.match(migration, /sent_message_id = new_message_id/i);
});

test('authenticated API exposes list, schedule and owner-only cancellation paths', () => {
  assert.match(routes, /router\.get\('\/scheduled-messages'/);
  assert.match(routes, /router\.post\('\/scheduled-messages'/);
  assert.match(routes, /router\.delete\('\/scheduled-messages\/:scheduledMessageId'/);
  assert.match(routes, /\.eq\('sender_id', req\.user\.id\)\.eq\('status', 'pending'\)/);
  assert.match(routes, /scheduledFor must be between 1 minute and 30 days from now/);
});

test('dedicated worker invokes the atomic database delivery function', () => {
  assert.match(worker, /rpc\('deliver_due_scheduled_messages', \{ p_limit: 100 \}\)/);
  assert.match(worker, /if \(!supabaseAdmin\) throw new Error/);
});
