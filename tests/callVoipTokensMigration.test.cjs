const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110200000_call_voip_tokens.sql'), 'utf8');

test('native VoIP tokens are stored separately and never readable by client roles', () => {
  assert.match(sql, /create table if not exists public\.call_voip_tokens/i);
  assert.match(sql, /token_type in \('APNS_VOIP', 'FCM'\)/i);
  assert.match(sql, /unique/i);
  assert.match(sql, /alter table public\.call_voip_tokens enable row level security/i);
  assert.match(sql, /revoke all on table public\.call_voip_tokens from public, anon, authenticated/i);
  assert.match(sql, /grant all on table public\.call_voip_tokens to service_role/i);
});
