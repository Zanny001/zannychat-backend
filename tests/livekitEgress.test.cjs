const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, createHash } = require('node:crypto');
const {
  getLiveReplayConfig,
  createEgressToken,
  liveKitEgressUrl,
  startRoomCompositeEgress,
  stopEgress,
  verifyLiveKitWebhook,
  MAX_REPLAY_SECONDS,
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
  assert.equal(getLiveReplayConfig({ ...env, LIVEKIT_REPLAY_ENABLED: 'false' }, liveKitConfig), null);
  assert.equal(getLiveReplayConfig({ ...env, LIVEKIT_REPLAY_BUILD_PLAN_CONFIRMED: 'false' }, liveKitConfig), null);
  assert.equal(getLiveReplayConfig({ ...env, SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: '' }, liveKitConfig), null);
  assert.equal(getLiveReplayConfig({ ...env, SUPABASE_STORAGE_S3_ENDPOINT: 'https://evil.example/s3' }, liveKitConfig), null);
  assert.ok(getLiveReplayConfig(env, liveKitConfig));
});

test('LIVE replay Egress only targets managed LiveKit Cloud and uses a roomRecord grant', () => {
  const egressConfig = { apiKey: env.LIVEKIT_EGRESS_API_KEY, apiSecret: env.LIVEKIT_EGRESS_API_SECRET };
  const token = createEgressToken(egressConfig, 1000);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.video.roomRecord, true);
  assert.equal(payload.exp - payload.nbf, 65);
  assert.equal(liveKitEgressUrl(liveKitConfig.url, 'StartRoomCompositeEgress'), 'https://zannychat-test.livekit.cloud/twirp/livekit.Egress/StartRoomCompositeEgress');
  assert.throws(() => liveKitEgressUrl('wss://self-hosted.example', 'StartRoomCompositeEgress'), /managed LiveKit Cloud/);
  assert.equal(MAX_REPLAY_SECONDS, 300);
  assert.equal(MAX_REPLAY_BYTES, 50 * 1024 * 1024);
});

test('LIVE replay starts a private 360p MP4 in Supabase S3', async () => {
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
  assert.equal(request.body.file.file_type, 1);
  assert.equal(request.body.file.s3.bucket, 'live-replays');
  assert.equal(request.body.file.s3.force_path_style, true);
  assert.equal(request.body.advanced.width, 640);
  assert.equal(request.body.advanced.height, 360);
  assert.equal(request.body.webhooks, undefined);
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
