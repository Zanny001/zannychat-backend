const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/discovery.js'), 'utf8');
const start = route.indexOf("router.post('/match'");
const match = route.slice(start);

test('phone matching no longer returns profile rows through an unrestricted relation join', () => {
  assert.match(match, /from\('phone_discovery'\)[\s\S]*?select\('user_id'\)/);
  assert.doesNotMatch(match, /profiles:user_id\(/);
  assert.match(match, /from\('profile_details'\)/);
  assert.match(match, /from\('blocked_users'\)[\s\S]*?eq\('blocker_id', req\.user\.id\)/);
  assert.match(match, /eq\('blocked_id', req\.user\.id\)/);
});

test('phone matching checks shared conversations before returning contacts-only data', () => {
  assert.match(match, /from\('conversation_participants'\)[\s\S]*?eq\('user_id', req\.user\.id\)/);
  assert.match(match, /sharedUserIds/);
  assert.match(match, /filterPhoneDiscoveryMatches/);
  assert.match(match, /profile_visibility/);
  assert.match(match, /photo_visibility/);
});
