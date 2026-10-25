const crypto = require('crypto');

const STUN_SERVERS = Object.freeze([
  Object.freeze({ urls: Object.freeze(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']) }),
]);

function buildIceConfig({ userId, urls, secret, ttlSeconds = 3600, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const validUrls = (Array.isArray(urls) ? urls : []).map((url) => String(url).trim()).filter((url) => /^turns?:[^\s,]+$/i.test(url));
  if (!userId || validUrls.length === 0 || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    return { iceServers: STUN_SERVERS.map((server) => ({ urls: [...server.urls] })), turnConfigured: false, credentialExpiresAt: null };
  }
  const requestedTtl = Number.isInteger(ttlSeconds) ? ttlSeconds : 3600;
  const ttl = Math.max(300, Math.min(requestedTtl, 3600));
  const expires = nowSeconds + ttl;
  const username = `${expires}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return {
    iceServers: [
      ...STUN_SERVERS.map((server) => ({ urls: [...server.urls] })),
      { urls: validUrls, username, credential },
    ],
    turnConfigured: true,
    credentialExpiresAt: new Date(expires * 1000).toISOString(),
  };
}

module.exports = { buildIceConfig };
