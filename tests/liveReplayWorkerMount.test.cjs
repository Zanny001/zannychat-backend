const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '../src/jobs/liveReplayWorker.js'), 'utf8');
const webhook = fs.readFileSync(path.join(__dirname, '../src/routes/livekitEgressWebhook.js'), 'utf8');

test('LiveKit Egress webhook is mounted before the global JSON parser', () => {
  const webhook = index.indexOf("app.use('/webhooks/livekit', liveKitEgressWebhookRouter)");
  const parser = index.indexOf("app.use(express.json({ limit: '100kb', strict: true }))");
  assert.ok(webhook >= 0 && parser > webhook);
});

test('replay worker and webhook import the Supabase client rather than the module wrapper', () => {
  const clientImport = "const { supabaseAdmin } = require('../config/supabaseAdmin')";
  assert.ok(worker.includes(clientImport));
  assert.ok(webhook.includes(clientImport));
  assert.ok(worker.includes('if (started || !supabaseAdmin) return;'));
  assert.ok(webhook.includes('if (!supabaseAdmin || !egressConfig'));
});

test('replay expiry and retention worker starts with the production backend process', () => {
  assert.match(index, /startLiveReplayWorker/);
  assert.match(index, /startLiveReplayWorker\(\);/);
});

test('LIVE replay worker logs configuration readiness without exposing credential values', () => {
  assert.ok(worker.includes("console.info('[live-replay] configuration status'"));
  assert.ok(worker.includes('egressCredentialsConfigured: Boolean(getLiveKitEgressConfig())'));
  assert.ok(worker.includes('storageCredentialsConfigured: Boolean(replayConfig?.storage)'));
  assert.ok(worker.includes('replayEnabled: isLiveReplayEnabled()'));
});

test('LIVE replay worker performs read-only credential validation without enabling recording', () => {
  assert.ok(worker.includes('validateReplayCredentials'));
  assert.ok(worker.includes("safeRun('read-only credential validation'"));
  assert.ok(worker.includes("console.info('[live-replay] credential validation'"));
  assert.ok(worker.includes('replayEnabled: isLiveReplayEnabled()'));
});

test('startup validates room-admin credentials through a read-only ListParticipants call', () => {
  assert.ok(worker.includes('validateRoomAdminCredentials'));
  assert.ok(worker.includes("safeRun('read-only room admin credential validation'"));
  assert.ok(worker.includes("console.info('[live-stage] room admin credential validation'"));
});
