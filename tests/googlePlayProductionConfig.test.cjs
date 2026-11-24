const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const envExample = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
const renderBlueprint = fs.readFileSync(path.join(__dirname, '../render.yaml'), 'utf8');
const checklist = fs.readFileSync(path.join(__dirname, '../docs/GOOGLE_PLAY_SPARKS_RELEASE_CHECKLIST.md'), 'utf8');

test('Google Play production secrets are documented as backend-only configuration', () => {
  for (const key of [
    'LIVE_GOOGLE_PLAY_BILLING_ENABLED',
    'GOOGLE_PLAY_PACKAGE_NAME',
    'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    'GOOGLE_PLAY_PUBSUB_AUDIENCE',
    'GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL',
  ]) {
    assert.match(envExample, new RegExp('^' + key + '=', 'm'));
    assert.match(renderBlueprint, new RegExp('key: ' + key));
    assert.match(checklist, new RegExp(key));
  }
  assert.match(envExample, /^LIVE_GOOGLE_PLAY_BILLING_ENABLED=false$/m);
  assert.match(renderBlueprint, /key: LIVE_GOOGLE_PLAY_BILLING_ENABLED\\n\\s+value: 'false'/);
  assert.match(renderBlueprint, /key: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON\\n\\s+sync: false/);
});

test('release checklist keeps product IDs and prices grounded in Play Console and gates enablement on tests', () => {
  assert.match(checklist, /exact\\s+product ID and Nigerian price from Play Console/);
  assert.match(checklist, /Do not set `LIVE_GOOGLE_PLAY_BILLING_ENABLED=true` until/);
  assert.match(checklist, /repeated verification of the same purchase token does not credit twice/);
  assert.match(checklist, /Pending or declined payment does not credit Sparks/);
});
