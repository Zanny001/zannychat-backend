const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '0014_self_service_chat_deletion.sql');
const checklistPath = path.join(__dirname, '..', 'supabase', 'tests', 'self_service_chat_deletion.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const checklist = fs.readFileSync(checklistPath, 'utf8');

test('chat deletion migration grants only participant-row delete permission', () => {
  assert.match(migration, /grant\s+delete\s+on\s+table\s+public\.conversation_participants\s+to\s+authenticated\s*;/i);
  assert.match(migration, /for\s+delete\s+to\s+authenticated\s+using\s*\(\s*user_id\s*=\s*\(select\s+auth\.uid\(\)\)\s*\)/i);
  assert.doesNotMatch(migration, /grant\s+delete\s+on\s+table\s+public\.(conversations|messages)\s+to\s+authenticated/i);
  assert.doesNotMatch(migration, /create\s+trigger\s+.*cleanup_empty_direct_conversation/i);
});

test('chat deletion staging checklist covers other-member protection and history retention', () => {
  assert.match(checklist, /cannot delete User B's row/i);
  assert.match(checklist, /cannot DELETE from public\.conversations or public\.messages/i);
  assert.match(checklist, /message history for B/i);
  assert.match(checklist, /disposable/i);
  assert.match(checklist, /staging fixtures/i);
});
