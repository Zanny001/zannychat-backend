const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261120140000_list_my_auth_sessions.sql'),
  'utf8',
);

test('session inventory is read-only and strictly bound to the authenticated user', () => {
  assert.match(migration, /RETURNS TABLE\s*\([\s\S]*session_id uuid[\s\S]*is_current boolean/i);
  assert.match(migration, /SECURITY DEFINER/i);
  assert.match(migration, /SET search_path TO ''/i);
  assert.match(migration, /s\.user_id = auth\.uid\(\)/);
  assert.match(migration, /auth\.jwt\(\)\s*->> 'session_id'/);
  assert.match(migration, /s\.not_after IS NULL OR s\.not_after > now\(\)/);
  assert.match(migration, /rt\.session_id = s\.id\s+AND rt\.revoked = false/);
  assert.match(migration, /LIMIT 50/);
});

test('session inventory exposes only safe device metadata, never IP or token material', () => {
  const returnedColumns = migration.match(/RETURNS TABLE\s*\(([\s\S]*?)\)/i)?.[1] || '';
  assert.match(returnedColumns, /user_agent text/);
  assert.doesNotMatch(returnedColumns, /\bip\b|refresh_token|token_hmac|scopes|oauth_client_id/i);
  assert.match(migration, /left\(s\.user_agent, 256\)/);
});

test('session inventory RPC is authenticated-only', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.list_my_auth_sessions\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.list_my_auth_sessions\(\) TO authenticated/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.list_my_auth_sessions\(\) TO anon/);
});
