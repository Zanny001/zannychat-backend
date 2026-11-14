const { createHmac } = require('node:crypto');
const { getLiveKitConfig } = require('./livekitToken');

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createRoomAdminToken(config, roomName, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!config?.apiKey || !config?.apiSecret || !roomName) {
    throw new Error('LiveKit room administration is not configured');
  }
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: config.apiKey,
    sub: 'zannychat-live-stage-admin',
    nbf: nowSeconds - 5,
    exp: nowSeconds + 60,
    video: { room: roomName, roomAdmin: true },
  });
  const unsigned = header + '.' + payload;
  const signature = createHmac('sha256', config.apiSecret).update(unsigned).digest('base64url');
  return unsigned + '.' + signature;
}

function roomServiceUrl(liveKitUrl, method) {
  if (!['ListParticipants', 'RemoveParticipant', 'MutePublishedTrack'].includes(method)) {
    throw new Error('Unsupported LiveKit room service method');
  }
  const url = new URL(String(liveKitUrl || '').trim());
  if (!['wss:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.livekit.cloud')) {
    throw new Error('LIVE stage management requires managed LiveKit Cloud');
  }
  url.protocol = 'https:';
  url.pathname = '/twirp/livekit.RoomService/' + method;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function requestRoomService(method, body, config, fetchImpl = globalThis.fetch) {
  if (!config || typeof fetchImpl !== 'function') throw new Error('LiveKit room service is unavailable');
  const response = await fetchImpl(roomServiceUrl(config.url, method), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + createRoomAdminToken(config, body.room),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error('LiveKit room service request failed with HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function getRoomAdminConfig() {
  return getLiveKitConfig();
}

async function listRoomParticipants(roomName, config = getRoomAdminConfig(), fetchImpl) {
  return requestRoomService('ListParticipants', { room: roomName }, config, fetchImpl);
}

async function removeRoomParticipant(roomName, identity, config = getRoomAdminConfig(), fetchImpl) {
  return requestRoomService('RemoveParticipant', {
    room: roomName,
    identity,
    revoke_token_ts: Math.floor(Date.now() / 1000),
  }, config, fetchImpl);
}

async function muteRoomParticipantTrack(roomName, identity, trackSid, muted, config = getRoomAdminConfig(), fetchImpl) {
  if (typeof muted !== 'boolean') throw new Error('A valid mute state is required');
  return requestRoomService('MutePublishedTrack', {
    room: roomName,
    identity,
    track_sid: trackSid,
    muted,
  }, config, fetchImpl);
}

module.exports = {
  createRoomAdminToken,
  roomServiceUrl,
  requestRoomService,
  listRoomParticipants,
  removeRoomParticipant,
  muteRoomParticipantTrack,
};
