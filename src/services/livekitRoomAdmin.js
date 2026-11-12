const { createHmac } = require('node:crypto');
const { getLiveKitConfig } = require('./livekitToken');

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createRoomDeletionToken(config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!config?.apiKey || !config?.apiSecret) {
    throw new Error('LiveKit room administration is not configured');
  }
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: config.apiKey,
    sub: 'zannychat-room-admin',
    nbf: nowSeconds - 5,
    exp: nowSeconds + 30,
    video: { roomCreate: true },
  });
  const unsigned = header + '.' + payload;
  const signature = createHmac('sha256', config.apiSecret).update(unsigned).digest('base64url');
  return unsigned + '.' + signature;
}

function liveKitHttpUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('LiveKit URL must use ws, wss, http, or https');
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/twirp/livekit.RoomService/DeleteRoom';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function deleteLiveKitRoom(roomName, {
  config = getLiveKitConfig(),
  fetchImpl = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (!/^zgc_[a-f0-9]{32}$/i.test(String(roomName || ''))) {
    throw new Error('Invalid ZannyChat LiveKit room name');
  }
  if (!config) throw new Error('Group calling is not configured on this server');
  if (typeof fetchImpl !== 'function') throw new Error('LiveKit room administration requires fetch');

  const token = createRoomDeletionToken(config, nowSeconds);
  const response = await fetchImpl(liveKitHttpUrl(config.url), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ room: roomName }),
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return { deleted: true, alreadyAbsent: true };
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('LiveKit room deletion failed with HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 160) : ''));
  }
  return { deleted: true, alreadyAbsent: false };
}

module.exports = { createRoomDeletionToken, liveKitHttpUrl, deleteLiveKitRoom };
