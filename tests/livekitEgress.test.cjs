const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, createHash } = require('node:crypto');
const {
  getLiveReplayConfig,
  getLiveKitEgressConfig,
  isLiveReplayEnabled,
  createEgressToken,
  liveKitEgressUrl,
  startRoomCompositeEgress,
  stopEgress,
  listEgress,
  verifyLiveKitWebhook,
  getEgressDurationSeconds,
  validateReplayCredentials,
  MAX_REPLAY_SECONDS,
  MAX_REPLAY_OUTPUT_SECONDS,
  MAX_REPLAY_BYTES,
} = require('../src/services/livekitEgress');

const liveKitConfig = { url: 'wss://zannychat-test.livekit.cloud', apiKey: 'test-key', apiSecret: 'test-secret' };
const env = {
  LIVEKIT_REPLAY_ENABLED: 'true',
  LIVEKIT_REPLAY_BUILD_PLAN_CONFIRMED: 'true',
  SUPABASE_STORAGE_S3_ENDPOINT: 'https://vithpppgyjmazxvogvno.storage.supabase.co/storage/v1/s3',
  SUPABASE_STORAGE_S3_ACCESS_KEY_ID: 'access',
  SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
  SUPABASE_STORAGE_S3_REGION: 'eu-central-1',
  LIVEKIT_REPLAY_WEBHOOK_URL: 'https://api.example.com/webhooks/livekit/egress',
  LIVEKIT_EGRESS_API_KEY: 'egress-key',
  LIVEKIT_EGRESS_API_SECRET: 'egress-secret',
};

test('LIVE replay is fail-closed unless free-tier confirmation and private Supabase S3 credentials exist', () => {
  assert.equal(isLiveReplayEnabled({ ...env, LIVEKIT_REPLAY_ENABLED: 'false' }, liveKitConfig), false);
  assert.equal(isLiveReplayEnabled({ ...env, LIVEKIT_REPLAY_BUILD_PLAN_CONFIRMED: 'false' }, liveKitConfig), false);
  assert.equal(isLiveReplayEnabled(env, liveKitConfig), true);
  assert.ok(getLiveReplayConfig({ ...env, LIVEKIT_REPLAY_ENABLED: 'false' }, liveKitConfig));
  assert.equal(getLiveReplayConfig({ ...env, SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: '' }, liveKitConfig), null);
  assert.equal(getLiveReplayConfig({ ...env, SUPABASE_STORAGE_S3_ENDPOINT: 'https://evil.example/s3' }, liveKitConfig), null);
  assert.ok(getLiveReplayConfig(env, liveKitConfig));
  assert.ok(getLiveKitEgressConfig({ ...env, SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: '' }, liveKitConfig));
});

test('LIVE replay Egress only targets managed LiveKit Cloud and uses a roomRecord grant', () => {
  const egressConfig = { apiKey: env.LIVEKIT_EGRESS_API_KEY, apiSecret: env.LIVEKIT_EGRESS_API_SECRET };
  const token = createEgressToken(egressConfig, 1000);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.video.roomRecord, true);
  assert.equal(payload.exp - payload.nbf, 65);
  assert.equal(liveKitEgressUrl(liveKitConfig.url, 'StartEgress'), 'https://zannychat-test.livekit.cloud/twirp/livekit.Egress/StartEgress');
  assert.throws(() => liveKitEgressUrl('wss://self-hosted.example', 'StartEgress'), /managed LiveKit Cloud/);
  assert.equal(MAX_REPLAY_SECONDS, 300);
  assert.equal(MAX_REPLAY_BYTES, 48_000_000);
  assert.equal(MAX_REPLAY_OUTPUT_SECONDS, 305);
});

test('LIVE replay starts a private 360p MP4 through unified StartEgress and Supabase S3', async () => {
  let request;
  const replayConfig = getLiveReplayConfig(env, liveKitConfig);
  const result = await startRoomCompositeEgress({
    roomName: 'zlive_01234567890123456789012345678901',
    filePath: 'creator/stream/replay.mp4',
    replayConfig,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ egress_id: 'EG_test', status: 'EGRESS_STARTING' }) };
    },
  });
  assert.equal(result.egress_id, 'EG_test');
  assert.equal(request.body.room_name, 'zlive_01234567890123456789012345678901');
  assert.equal(request.body.template.layout, 'grid');
  assert.equal(request.body.outputs.length, 1);
  assert.equal(request.body.outputs[0].file.file_type, 1);
  assert.equal(request.body.outputs[0].file.filepath, 'creator/stream/replay.mp4');
  assert.equal(request.body.storage.s3.bucket, 'live-replays');
  assert.equal(request.body.storage.s3.force_path_style, true);
  assert.equal(Object.hasOwn(request.body, 'outputs'), true);
  assert.equal(Object.hasOwn(request.body, 'file_outputs'), false);
  assert.equal(Object.hasOwn(request.body, 'file'), false);
  assert.equal(request.body.advanced.width, 640);
  assert.equal(request.body.advanced.height, 360);
  assert.equal(request.body.webhooks[0].url, env.LIVEKIT_REPLAY_WEBHOOK_URL);
  assert.equal(request.body.webhooks[0].signing_key, env.LIVEKIT_EGRESS_API_KEY);
  assert.match(request.options.headers.Authorization, /^Bearer /);
});

test('LIVE replay stop calls the Egress stop endpoint', async () => {
  let request;
  await stopEgress('EG_test', { url: liveKitConfig.url, apiKey: env.LIVEKIT_EGRESS_API_KEY, apiSecret: env.LIVEKIT_EGRESS_API_SECRET }, async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ egress_id: 'EG_test', status: 'EGRESS_ENDING' }) };
  });
  assert.equal(request.url, 'https://zannychat-test.livekit.cloud/twirp/livekit.Egress/StopEgress');
  assert.equal(request.body.egress_id, 'EG_test');
});

test('LIVE replay webhook verifies issuer, signature and exact raw-body digest', () => {
  const raw = Buffer.from(JSON.stringify({ event: 'egress_ended' }));
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: env.LIVEKIT_EGRESS_API_KEY,
    sha256: createHash('sha256').update(raw).digest('base64'),
    exp: 2000,
  })).toString('base64url');
  const unsigned = header + '.' + payload;
  const signature = createHmac('sha256', env.LIVEKIT_EGRESS_API_SECRET).update(unsigned).digest('base64url');
  const egressConfig = { apiKey: env.LIVEKIT_EGRESS_API_KEY, apiSecret: env.LIVEKIT_EGRESS_API_SECRET };
  const verified = verifyLiveKitWebhook(raw, 'Bearer ' + unsigned + '.' + signature, egressConfig, 1000);
  assert.ok(verified);
  assert.equal(verifyLiveKitWebhook(raw, 'Bearer ' + unsigned + '.bad', egressConfig, 1000), null);
  assert.equal(verifyLiveKitWebhook(Buffer.from('tampered'), 'Bearer ' + unsigned + '.' + signature, egressConfig, 1000), null);
});

test('LIVE replay can recover an active Egress by its persisted room name', async () => {
  let request;
  const egressConfig = { url: liveKitConfig.url, apiKey: env.LIVEKIT_EGRESS_API_KEY, apiSecret: env.LIVEKIT_EGRESS_API_SECRET };
  const result = await listEgress('zlive_recovery_room', egressConfig, async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ items: [{ egress_id: 'EG_recovered', status: 'EGRESS_ACTIVE' }] }) };
  });
  assert.equal(request.url, 'https://zannychat-test.livekit.cloud/twirp/livekit.Egress/ListEgress');
  assert.equal(request.body.room_name, 'zlive_recovery_room');
  assert.equal(request.body.active, true);
  assert.equal(result.items[0].egress_id, 'EG_recovered');
});

test('read-only replay credential validation authenticates Egress and Supabase S3 without starting a recording', async () => {
  const calls = [];
  const replayConfig = getLiveReplayConfig(env, liveKitConfig);
  const result = await validateReplayCredentials(replayConfig, async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/twirp/livekit.Egress/ListEgress')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, status: 200 };
  }, new Date('2026-11-14T12:00:00.000Z'));
  assert.deepEqual(result, { configured: true, egressApiAuthenticated: true, storageListAuthorized: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/twirp/livekit.Egress/ListEgress'));
  assert.equal(calls[1].options.method, 'GET');
  assert.ok(calls[1].url.includes('/storage/v1/s3/live-replays?list-type=2&max-keys=1'));
  assert.match(calls[1].options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=access\/20261114\/eu-central-1\/s3\/aws4_request/);
  assert.equal(calls.some((call) => call.url.includes('StartEgress')), false);
});

test('read-only replay credential validation fails closed when the S3 key cannot list the private bucket', async () => {
  const replayConfig = getLiveReplayConfig(env, liveKitConfig);
  let calls = 0;
  await assert.rejects(
    validateReplayCredentials(replayConfig, async (url) => {
      calls += 1;
      if (url.includes('/twirp/livekit.Egress/ListEgress')) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: false, status: 403 };
    }),
    /Supabase S3 credential validation failed with HTTP 403/,
  );
  assert.equal(calls, 2);
});



test('LIVE replay duration parses LiveKit FileInfo nanoseconds exactly', () => {
  assert.equal(getEgressDurationSeconds({ duration: '300000000000' }, {}), 300);
  assert.equal(getEgressDurationSeconds({ durationNs: '300000000001' }, {}), 301);
  assert.equal(getEgressDurationSeconds({ duration_ns: 1_500_000_000 }, {}), 2);
});

test('LIVE replay duration recovers from negative or missing FileInfo duration using Egress timestamps', () => {
  const startedAt = '1731660518186023947';
  const endedAt = '1731660818186023947';
  assert.equal(getEgressDurationSeconds({ duration: '-1731660518186023947' }, { startedAt, endedAt }), 300);
  assert.equal(getEgressDurationSeconds({}, { started_at: startedAt, ended_at: endedAt }), 300);
  assert.equal(getEgressDurationSeconds({ duration: '0' }, { startedAt, endedAt }), 300);
});

test('LIVE replay duration fails closed when both file duration and Egress timestamps are invalid', () => {
  assert.equal(getEgressDurationSeconds({ duration: '-1' }, { startedAt: '200', endedAt: '100' }), 0);
  assert.equal(getEgressDurationSeconds({}, {}), 0);
  assert.equal(getEgressDurationSeconds({ duration: 'not-a-number' }, { startedAt: '1.5', endedAt: '2.5' }), 0);
});

test('LIVE replay reconciliation can list completed Egress by persisted id', async () => {
  let request;
  const egressConfig = { url: liveKitConfig.url, apiKey: env.LIVEKIT_EGRESS_API_KEY, apiSecret: env.LIVEKIT_EGRESS_API_SECRET };
  const result = await listEgress('zlive_recovery_room', egressConfig, async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ items: [{ egress_id: 'EG_completed', status: 'EGRESS_COMPLETE' }] }) };
  }, { active: false, egressId: 'EG_completed' });
  assert.equal(request.url, 'https://zannychat-test.livekit.cloud/twirp/livekit.Egress/ListEgress');
  assert.equal(request.body.room_name, 'zlive_recovery_room');
  assert.equal(request.body.active, false);
  assert.equal(request.body.egress_id, 'EG_completed');
  assert.equal(result.items[0].status, 'EGRESS_COMPLETE');
});
