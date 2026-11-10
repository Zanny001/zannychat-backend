const { createHmac } = require('node:crypto');

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function getLiveKitConfig(env = process.env) {
  const url = String(env.LIVEKIT_URL || '').trim();
  const apiKey = String(env.LIVEKIT_API_KEY || '').trim();
  const apiSecret = String(env.LIVEKIT_API_SECRET || '').trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

function createLiveKitToken({
  identity,
  name,
  room,
  canPublish = true,
  canSubscribe = true,
  canPublishData = true,
  ttlSeconds = 3600,
  nowSeconds = Math.floor(Date.now() / 1000),
  config = getLiveKitConfig(),
}) {
  if (!config) throw new Error('Group calling is not configured on this server');
  if (!identity || !room) throw new Error('LiveKit identity and room are required');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: config.apiKey,
    sub: String(identity),
    name: String(name || 'ZannyChat member').slice(0, 96),
    nbf: nowSeconds - 5,
    exp: nowSeconds + Math.max(60, Math.min(Number(ttlSeconds) || 3600, 6 * 60 * 60)),
    video: {
      roomJoin: true,
      room: String(room),
      canPublish: Boolean(canPublish),
      canSubscribe: Boolean(canSubscribe),
      canPublishData: Boolean(canPublishData),
    },
  });
  const unsigned = header + '.' + payload;
  const signature = createHmac('sha256', config.apiSecret).update(unsigned).digest('base64url');
  return unsigned + '.' + signature;
}

module.exports = { createLiveKitToken, getLiveKitConfig };
