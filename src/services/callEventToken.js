const { createHmac, timingSafeEqual } = require('node:crypto');

const TOKEN_TTL_SECONDS = 4 * 60 * 60;
const TOKEN_CONTEXT = 'zannychat-native-call-event:v1';

function getSecret() {
  return process.env.CALL_EVENT_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function sign(callId, expiresAt) {
  return createHmac('sha256', getSecret())
    .update(`${TOKEN_CONTEXT}:${callId}:${expiresAt}`)
    .digest('base64url');
}

function createCallEventToken(callId, nowMs = Date.now()) {
  if (!getSecret() || !callId) return null;
  const expiresAt = Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS;
  return {
    token: `${expiresAt}.${sign(callId, expiresAt)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

function verifyCallEventToken(callId, token, nowMs = Date.now()) {
  if (!getSecret() || !callId || typeof token !== 'string') return false;
  const separator = token.indexOf('.');
  if (separator < 1) return false;
  const expiresText = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  if (!/^\d{10}$/.test(expiresText) || !/^[A-Za-z0-9_-]{40,50}$/.test(supplied)) return false;
  const expiresAt = Number(expiresText);
  const now = Math.floor(nowMs / 1000);
  if (expiresAt < now || expiresAt > now + TOKEN_TTL_SECONDS + 60) return false;
  const expected = Buffer.from(sign(callId, expiresAt), 'base64url');
  const actual = Buffer.from(supplied, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = { createCallEventToken, verifyCallEventToken, TOKEN_TTL_SECONDS };
