'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0009_private_chat_media.sql'), 'utf8');
const audit = fs.readFileSync(path.join(root, 'supabase/diagnostics/private_media_migration_audit.sql'), 'utf8');

test('legacy media conversion is restricted to the configured Supabase project origin', () => {
  assert.match(migration, /media_url\s*~\s*'\^https\?:\/\/vithpppgyjmazxvogvno\\\.supabase\\\.co\/storage\/v1\/object\/public\/chat-media\//i);
  assert.match(migration, /lower\(split_part\(media_url,\s*'\/',\s*3\)\)\s*=\s*'vithpppgyjmazxvogvno\.supabase\.co'/i);
  assert.match(migration, /\)\s*=\s*conversation_id::text/i);
});

test('migration keeps private bucket and participant-based storage access', () => {
  assert.match(migration, /set\s+public\s*=\s*false\s+where\s+id\s*=\s*'chat-media'/i);
  assert.match(migration, /security\s+definer/i);
  assert.match(migration, /private\.is_chat_media_conversation_member\(name\)/i);
  assert.match(migration, /for\s+select\s+to\s+authenticated/i);
  assert.match(migration, /for\s+insert\s+to\s+authenticated/i);
});

test('read-only audit flags malformed markers and conversation mismatches', () => {
  assert.match(audit, /malformed_marker_shape/i);
  assert.match(audit, /marker_has_query_or_fragment/i);
  assert.match(audit, /marker_conversation_mismatch/i);
  assert.match(audit, /from\s+public\.messages/i);
  assert.doesNotMatch(audit, /^\s*(update|delete|insert|alter|drop|create)\s+/im);
});
