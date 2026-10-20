const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0029_status_contact_exclusions.sql'), 'utf8');
test('creates owner-scoped exclusion preferences and RLS', () => { assert.match(sql, /create table if not exists public\.status_excluded_users/i); assert.match(sql, /enable row level security/i); assert.match(sql, /owner_id = \(select auth\.uid\(\)\)/i); });
test('exclusions are enforced for status rows and private media', () => { assert.match(sql, /Conversation contacts can read contact statuses/i); assert.match(sql, /Status media visible to authorized viewers/i); assert.match(sql, /x\.excluded_user_id = \(select auth\.uid\(\)\)/i); });
test('exclusions cover views, reactions and replies', () => { assert.match(sql, /Eligible viewers can record own view/i); assert.match(sql, /Eligible viewers can react to statuses/i); assert.match(sql, /Eligible viewers can reply to statuses/i); });
