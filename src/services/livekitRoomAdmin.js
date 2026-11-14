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
  if (process.env.NODE_ENV === 'production' && !['wss:', 'https:'].includes(url.protocol)) {
    throw new Error('LiveKit must use secure wss or https transport in production');
  }
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
  if (!['ListParticipants', 'RemoveParticipant', 'MutePublishedTrack', 'UpdateParticipant'].includes(method)) {
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

async function updateRoomParticipantAttributes(roomName, identity, attributes, config = getRoomAdminConfig(), fetchImpl) {
  if (!identity || !attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new Error('A valid participant identity and attribute map are required');
  }
  return requestRoomService('UpdateParticipant', {
    room: roomName,
    identity,
    attributes,
  }, config, fetchImpl);
}

async function updateRoomParticipantPermissions(roomName, identity, permission, config = getRoomAdminConfig(), fetchImpl) {
  if (!identity || !permission || typeof permission !== 'object' || Array.isArray(permission)) {
    throw new Error('A valid participant identity and permission object are required');
  }
  return requestRoomService('UpdateParticipant', {
    room: roomName,
    identity,
    permission,
  }, config, fetchImpl);
}

module.exports = {
  createRoomDeletionToken,
  liveKitHttpUrl,
  deleteLiveKitRoom,
  createRoomAdminToken,
  roomServiceUrl,
  requestRoomService,
  listRoomParticipants,
  removeRoomParticipant,
  muteRoomParticipantTrack,
  updateRoomParticipantAttributes,
  updateRoomParticipantPermissions,
};
