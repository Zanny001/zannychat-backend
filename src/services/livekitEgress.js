const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { getLiveKitConfig } = require('./livekitToken');

const MAX_REPLAY_SECONDS = 300;
const MAX_REPLAY_OUTPUT_SECONDS = 305;
const MAX_REPLAY_BYTES = 48_000_000;

function getLiveKitEgressConfig(env = process.env, liveKitConfig = getLiveKitConfig(env)) {
  if (!liveKitConfig) return null;
  let liveKitUrl;
  try { liveKitUrl = new URL(liveKitConfig.url); } catch { return null; }
  if (!['wss:', 'https:'].includes(liveKitUrl.protocol) || !liveKitUrl.hostname.endsWith('.livekit.cloud')) return null;
  const apiKey = String(env.LIVEKIT_EGRESS_API_KEY || '').trim();
  const apiSecret = String(env.LIVEKIT_EGRESS_API_SECRET || '').trim();
  if (!apiKey || !apiSecret) return null;
  return { url: liveKitConfig.url, apiKey, apiSecret };
}

function getLiveReplayConfig(env = process.env, liveKitConfig = getLiveKitConfig(env)) {
  const egressConfig = getLiveKitEgressConfig(env, liveKitConfig);
  if (!egressConfig) return null;
  let storageEndpoint;
  try { storageEndpoint = new URL(String(env.SUPABASE_STORAGE_S3_ENDPOINT || '').trim()); } catch { return null; }
  if (storageEndpoint.protocol !== 'https:' ||
      !storageEndpoint.hostname.endsWith('.storage.supabase.co') ||
      storageEndpoint.pathname.replace(/\/$/, '') !== '/storage/v1/s3') return null;
  const accessKey = String(env.SUPABASE_STORAGE_S3_ACCESS_KEY_ID || '').trim();
  const secret = String(env.SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY || '').trim();
  const region = String(env.SUPABASE_STORAGE_S3_REGION || '').trim();
  const webhookUrl = String(env.LIVEKIT_REPLAY_WEBHOOK_URL || '').trim();
  try {
    const webhook = new URL(webhookUrl);
    if (webhook.protocol !== 'https:' || !webhook.pathname.endsWith('/webhooks/livekit/egress')) return null;
  } catch {
    return null;
  }
  if (!accessKey || !secret || !region) return null;
  return {
    liveKitConfig: { url: liveKitConfig.url },
    egressConfig,
    storage: {
      endpoint: storageEndpoint.toString().replace(/\/$/, ''),
      accessKey,
      secret,
      region,
      bucket: 'live-replays',
      forcePathStyle: true,
    },
    webhookUrl,
  };
}
function isLiveReplayEnabled(env = process.env, liveKitConfig = getLiveKitConfig(env)) {
  return env.LIVEKIT_REPLAY_ENABLED === 'true' &&
    env.LIVEKIT_REPLAY_BUILD_PLAN_CONFIRMED === 'true' &&
    Boolean(getLiveReplayConfig(env, liveKitConfig));
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createEgressToken(config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!config?.apiKey || !config?.apiSecret) throw new Error('LiveKit Egress is not configured');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: config.apiKey,
    sub: 'zannychat-live-replay',
    nbf: nowSeconds - 5,
    exp: nowSeconds + 60,
    video: { roomRecord: true },
  });
  const unsigned = header + '.' + payload;
  const signature = createHmac('sha256', config.apiSecret).update(unsigned).digest('base64url');
  return unsigned + '.' + signature;
}

function liveKitEgressUrl(liveKitUrl, method) {
  if (!/^StartRoomCompositeEgress$|^StopEgress$|^ListEgress$/.test(method)) throw new Error('Unsupported LiveKit Egress method');
  const url = new URL(String(liveKitUrl || '').trim());
  if (!['wss:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.livekit.cloud')) {
    throw new Error('LIVE replay requires the managed LiveKit Cloud Egress service');
  }
  url.protocol = 'https:';
  url.pathname = '/twirp/livekit.Egress/' + method;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function requestLiveKitEgress(method, body, config, fetchImpl = globalThis.fetch) {
  if (!config || typeof fetchImpl !== 'function') throw new Error('LiveKit Egress is unavailable');
  const response = await fetchImpl(liveKitEgressUrl(config.url, method), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + createEgressToken(config),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error('LiveKit Egress request failed with HTTP ' + response.status);
  }
  return response.json();
}

async function startRoomCompositeEgress({ roomName, filePath, replayConfig, fetchImpl }) {
  if (!roomName || !filePath || !replayConfig?.storage) throw new Error('LIVE replay output is not configured');
  const config = replayConfig.egressConfig;
  return requestLiveKitEgress('StartRoomCompositeEgress', {
    room_name: roomName,
    layout: 'grid',
    file: {
      file_type: 1,
      filepath: filePath,
      s3: {
        access_key: replayConfig.storage.accessKey,
        secret: replayConfig.storage.secret,
        bucket: replayConfig.storage.bucket,
        region: replayConfig.storage.region,
        endpoint: replayConfig.storage.endpoint,
        force_path_style: true,
      },
    },
    webhooks: [{
      url: replayConfig.webhookUrl,
      signing_key: config.apiKey,
    }],
    advanced: {
      width: 640,
      height: 360,
      framerate: 24,
      video_bitrate: 500,
      audio_bitrate: 64,
      audio_frequency: 44100,
    },
  }, config, fetchImpl);
}

async function stopEgress(egressId, config, fetchImpl) {
  if (!egressId) throw new Error('Egress id is required');
  return requestLiveKitEgress('StopEgress', { egress_id: egressId }, config, fetchImpl);
}

async function listEgress(roomName, config, fetchImpl) {
  if (!roomName) throw new Error('Room name is required');
  return requestLiveKitEgress('ListEgress', { room_name: roomName, active: true }, config, fetchImpl);
}

function verifyLiveKitWebhook(rawBody, authorization, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  const token = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3 || !config?.apiKey || !config?.apiSecret || !Buffer.isBuffer(rawBody)) return null;
  let header;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (header.alg !== 'HS256') return null;
  const unsigned = parts[0] + '.' + parts[1];
  const expected = createHmac('sha256', config.apiSecret).update(unsigned).digest();
  let provided;
  try { provided = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (payload.iss !== config.apiKey) return null;
  if (Number.isFinite(payload.exp) && payload.exp < nowSeconds - 30) return null;
  if (Number.isFinite(payload.nbf) && payload.nbf > nowSeconds + 30) return null;
  let claimedDigest;
  try { claimedDigest = Buffer.from(payload.sha256 || '', 'base64'); } catch { return null; }
  const bodyDigest = createHash('sha256').update(rawBody).digest();
  if (claimedDigest.length !== bodyDigest.length || !timingSafeEqual(claimedDigest, bodyDigest)) return null;
  return payload;
}

module.exports = {
  MAX_REPLAY_SECONDS,
  MAX_REPLAY_OUTPUT_SECONDS,
  MAX_REPLAY_BYTES,
  getLiveReplayConfig,
  getLiveKitEgressConfig,
  isLiveReplayEnabled,
  createEgressToken,
  liveKitEgressUrl,
  requestLiveKitEgress,
  startRoomCompositeEgress,
  stopEgress,
  listEgress,
  verifyLiveKitWebhook,
};
