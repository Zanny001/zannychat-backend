const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'src/routes/channels.js'), 'utf8');
const api = fs.readFileSync(path.resolve(root, '../zannychat-frontend-main/src/services/api.js'), 'utf8');
const screen = fs.readFileSync(path.resolve(root, '../zannychat-frontend-main/src/screens/ChannelsScreen.js'), 'utf8');

test('channel directory search bounds and sanitizes query text before PostgREST filters', () => {
  assert.ok(route.includes("typeof req.query.q === 'string'"));
  assert.ok(route.includes('req.query.q.trim().slice(0, 80)'));
  assert.ok(route.includes("replace(/[^a-zA-Z0-9 .-]/g, ' ')") );
  assert.ok(route.includes('title.ilike.%${search}%,description.ilike.%${search}%'));
});

test('channel search is applied to public and only the signed-in user\'s private channels', () => {
  assert.ok(route.includes("eq('is_private', false)"));
  assert.ok(route.includes("eq('is_private', true).eq('owner_id', req.user.id)"));
  assert.ok(route.includes("eq('is_private', true).in('id', myIds)"));
  assert.ok(route.includes('const applySearch = (query)'));
});

test('frontend sends a URL-encoded search query and exposes an accessible search field', () => {
  assert.ok(api.includes("export async function listChannels(search = '')"));
  assert.ok(api.includes('encodeURIComponent(query)'));
  assert.ok(screen.includes('accessibilityLabel="Search channels"'));
  assert.ok(screen.includes('onSubmitEditing={refresh}'));
});
