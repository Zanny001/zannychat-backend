'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const grantMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261112130000_restore_status_reaction_upsert_privilege.sql'),
  'utf8'
);
const originalMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/0024_status_reactions.sql'),
  'utf8'
);

test('status reaction upsert receives only the required authenticated UPDATE grant', () => {
  assert.match(
    grantMigration,
    /grant\s+update\s+on\s+table\s+public\.status_reactions\s+to\s+authenticated/i
  );
  assert.doesNotMatch(grantMigration, /grant\s+all|to\s+public|to\s+anon/i);
});

test('the existing RLS update policy remains scoped to the authenticated eligible viewer', () => {
  assert.match(
    originalMigration,
    /for\s+update\s+to\s+authenticated\s+using\s*\(viewer_id\s*=\s*\(select\s+auth\.uid\(\)\)\s+and[\s\S]*?can_view_status/i
  );
  assert.match(
    originalMigration,
    /with\s+check\s*\(viewer_id\s*=\s*\(select\s+auth\.uid\(\)\)\s+and[\s\S]*?can_view_status/i
  );
});
