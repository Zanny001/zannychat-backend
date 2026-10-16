const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const routePath = path.join(__dirname, '..', 'src', 'routes', 'conversations.js');
const source = fs.readFileSync(routePath, 'utf8');

test('conversation route does not return raw database error messages', () => {
  assert.doesNotMatch(source, /error:\s*(?:blockError|membershipError|existingError|convError|participantsError)\.message/);
  assert.match(source, /Unable to check conversation permissions/);
  assert.match(source, /Unable to check existing conversations/);
  assert.match(source, /Unable to load existing conversation/);
  assert.match(source, /Unable to create conversation/);
  assert.match(source, /Unable to add conversation participants/);
});

test('conversation route retains rollback attempts after participant insert failures', () => {
  assert.match(source, /await supabaseAdmin\.from\('conversations'\)\.delete\(\)\.eq\('id', conversation\.id\)/);
});
