const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0024_status_reactions.sql'), 'utf8');
test('status reactions are unique per status and viewer and use an allowlist', () => { assert.match(sql, /primary key \(status_id, viewer_id\)/i); assert.match(sql, /reaction in \('❤️','😂','😮','😢','👏','🔥'\)/); });
test('status reactions require eligible active contact-visible statuses', () => { assert.match(sql, /s\.expires_at > now\(\)/); assert.match(sql, /s\.audience = 'contacts'/); assert.match(sql, /conversation_participants mine/i); });
test('status reactions enable RLS and deny anonymous access', () => { assert.match(sql, /enable row level security/i); assert.match(sql, /revoke all on public\.status_reactions from anon/i); });
test('viewers can manage only their own reaction rows', () => { assert.match(sql, /viewer_id = \(select auth\.uid\(\)\)/i); assert.match(sql, /for delete to authenticated using \(viewer_id = \(select auth\.uid\(\)\)\)/i); });
