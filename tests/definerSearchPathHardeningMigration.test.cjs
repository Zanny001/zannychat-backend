const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migrationPath = path.join(__dirname, '../supabase/migrations/0063_harden_qualified_definer_search_paths.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

test('reviewed SECURITY DEFINER routines are pinned to an empty search_path', () => {
  const expected = [
    'public.get_channel_post_stats(uuid[], uuid)',
    'public.get_own_status_view_counts(uuid[])',
    'public.get_conversation_poll_vote_counts(uuid)',
    'public.get_poll_vote_counts_for_ids(uuid, uuid[])',
    'public.cast_poll_vote(uuid, uuid[])',
    'public.cast_poll_vote(uuid, uuid)',
    'public.create_conversation_poll(uuid, text, text[], timestamptz, boolean)',
    'public.create_conversation_poll(uuid, text, text[], timestamptz)',
    'public.set_pinned_message_snapshot()',
    'public.deliver_due_scheduled_messages(integer)',
  ];
  const normalized = migration.replace(/\s+/g, ' ').toLowerCase();
  for (const signature of expected) {
    assert.ok(normalized.includes(`alter function ${signature.toLowerCase()} set search_path = ''`), `missing hardening for ${signature}`);
  }
});

test('migration is configuration-only and documents its reviewed scope', () => {
  assert.match(migration, /schema-qualify/i);
  assert.doesNotMatch(migration, /\b(drop|truncate|delete from|update|insert into)\b/i);
});
