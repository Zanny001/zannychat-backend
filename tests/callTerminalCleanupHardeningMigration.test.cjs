const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '0061_harden_terminal_call_cleanup.sql'), 'utf8');

test('terminal call cleanup SECURITY DEFINER function pins empty search_path', () => {
  assert.match(sql, /create or replace function public\.cleanup_terminal_call_signals\(\)/i);
  assert.match(sql, /security definer[\s\S]*set search_path = ''/i);
  assert.match(sql, /delete from public\.call_signals/i);
  assert.doesNotMatch(sql, /delete from (?!public\.)[a-z_]+/i);
});
