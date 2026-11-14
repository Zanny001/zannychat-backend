const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('LiveKit Egress webhook is mounted before the global JSON parser', () => {
  const webhook = index.indexOf("app.use('/webhooks/livekit', liveKitEgressWebhookRouter)");
  const parser = index.indexOf("app.use(express.json({ limit: '100kb', strict: true }))");
  assert.ok(webhook >= 0 && parser > webhook);
});

test('replay expiry and retention worker starts with the production backend process', () => {
  assert.match(index, /startLiveReplayWorker/);
  assert.match(index, /startLiveReplayWorker\(\);/);
});
