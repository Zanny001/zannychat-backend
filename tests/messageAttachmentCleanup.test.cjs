const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { safeObjectPath, retryDelay, runMessageAttachmentCleanup } = require('../src/jobs/messageAttachmentCleanup');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192943_profile_privacy_and_attachment_cleanup_0066.sql'), 'utf8');
process.env.SUPABASE_URL = 'https://project.supabase.co';

test('cleanup parser accepts only chat-media objects owned by this project', () => {
  assert.deepEqual(safeObjectPath('storage://chat-media/conversation/file.jpg'), { bucket: 'chat-media', path: 'conversation/file.jpg' });
  assert.deepEqual(safeObjectPath('https://project.supabase.co/storage/v1/object/sign/chat-media/room%2Ffile.jpg?token=x', 'https://project.supabase.co'), { bucket: 'chat-media', path: 'room/file.jpg' });
  assert.equal(safeObjectPath('https://evil.example/storage/v1/object/public/chat-media/a/b', 'https://project.supabase.co'), null);
  assert.equal(safeObjectPath('storage://chat-media/../secret', 'https://project.supabase.co'), null);
  assert.equal(safeObjectPath('https://project.supabase.co/storage/v1/object/public/avatars/a/b', 'https://project.supabase.co'), null);
});

test('cleanup retry delay is exponential and capped', () => {
  assert.equal(retryDelay(0), 30_000);
  assert.equal(retryDelay(1), 60_000);
  assert.equal(retryDelay(20), 6 * 60 * 60 * 1000);
});

test('worker retains shared media and deletes only unreferenced media through Storage API', async () => {
  const updates = [];
  const removed = [];
  const admin = {
    rpc: async () => ({ data: [
      { id: 1, message_id: 'm1', conversation_id: 'room', media_url: 'storage://chat-media/room/shared.jpg', attempt_count: 0 },
      { id: 2, message_id: 'm2', conversation_id: 'room', media_url: 'storage://chat-media/room/orphan.jpg', attempt_count: 0 },
    ], error: null }),
    from(table) {
      if (table === 'message_attachment_cleanup') {
        return { update: (values) => ({ eq: async (_column, id) => { updates.push({ id, values }); return { error: null }; } }) };
      }
      assert.equal(table, 'messages');
      return { select: () => ({ not: () => ({ order: () => ({ range: async () => ({ data: referenceCall++ === 0 ? [{ media_url: 'https://project.supabase.co/storage/v1/object/sign/chat-media/room/shared.jpg?token=old' }] : [], error: null }) }) }) }) };
    },
    storage: { from: (bucket) => ({ remove: async (paths) => { removed.push({ bucket, paths }); return { error: null }; } }) },
  };
  let referenceCall = 0;
  const result = await runMessageAttachmentCleanup({ admin });
  assert.equal(result.retained, 1);
  assert.equal(result.deleted, 1);
  assert.deepEqual(removed, [{ bucket: 'chat-media', paths: ['room/orphan.jpg'] }]);
  assert.equal(updates.length, 2);
});

test('migration uses an RLS-hidden queue, row locks, reference-safe trigger and Storage API worker contract', () => {
  assert.match(migration, /alter table public\.message_attachment_cleanup enable row level security/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /after update of media_url/);
  assert.match(migration, /after delete on public\.messages/);
  assert.match(migration, /grant execute on function public\.claim_message_attachment_cleanup\(integer\) to service_role/);
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.objects/i);
});


test('worker refuses to delete an object outside the message conversation even when unreferenced', async () => {
  const updates = [];
  const removed = [];
  const admin = {
    rpc: async () => ({ data: [
      { id: 9, message_id: 'attacker-message', conversation_id: 'attacker-room', media_url: 'storage://chat-media/victim-room/private.jpg', attempt_count: 0 },
    ], error: null }),
    from(table) {
      assert.equal(table, 'message_attachment_cleanup');
      return { update: (values) => ({ eq: async (_column, id) => { updates.push({ id, values }); return { error: null }; } }) };
    },
    storage: { from: (bucket) => ({ remove: async (paths) => { removed.push({ bucket, paths }); return { error: null }; } }) },
  };
  const result = await runMessageAttachmentCleanup({ admin });
  assert.equal(result.skipped, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(removed, []);
  assert.match(updates[0].values.last_error, /does not belong to the queued message conversation/);
});

test('ownership migration records the source conversation for new cleanup jobs', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192957_bind_attachment_cleanup_to_conversation_0068.sql'), 'utf8');
  assert.match(migration, /add column if not exists conversation_id uuid/);
  assert.match(migration, /old\.conversation_id/);
  assert.match(migration, /set search_path = ''/);
  assert.match(migration, /insert into public\.message_attachment_cleanup\(message_id, conversation_id, media_url\)/);
});


test('worker retains an object referenced from another conversation through a signed URL', async () => {
  const updates = [];
  const removed = [];
  const admin = {
    rpc: async () => ({ data: [
      { id: 10, message_id: 'm10', conversation_id: 'room', media_url: 'storage://chat-media/room/shared.jpg', attempt_count: 0 },
    ], error: null }),
    from(table) {
      if (table === 'message_attachment_cleanup') return { update: (values) => ({ eq: async (_column, id) => { updates.push({ id, values }); return { error: null }; } }) };
      assert.equal(table, 'messages');
      return { select: () => ({ not: () => ({ order: () => ({ range: async () => ({ data: [
        { conversation_id: 'different-room', media_url: 'https://project.supabase.co/storage/v1/object/sign/chat-media/room/shared.jpg?token=rotated' },
      ], error: null }) }) }) }) };
    },
    storage: { from: (bucket) => ({ remove: async (paths) => { removed.push({ bucket, paths }); return { error: null }; } }) },
  };
  const result = await runMessageAttachmentCleanup({ admin });
  assert.equal(result.retained, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(removed, []);
  assert.match(updates[0].values.last_error, /still referenced/);
});
