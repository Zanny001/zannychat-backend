const { createHmac, timingSafeEqual } = require('node:crypto');

const TOKEN_TTL_SECONDS = 4 * 60 * 60;
const TOKEN_CONTEXT = 'zannychat-native-call-event:v1';

function getSecret() {
  return process.env.CALL_EVENT_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function sign(callId, expiresAt, actorId = '') {
  return createHmac('sha256', getSecret())
    .update(`${TOKEN_CONTEXT}:${callId}:${actorId}:${expiresAt}`)
    .digest('base64url');
}

function createCallEventToken(callId, nowMs = Date.now(), actorId = '') {
  if (!getSecret() || !callId) return null;
  const expiresAt = Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS;
  const normalizedActorId = typeof actorId === 'string' && actorId ? actorId : '';
  return {
    token: `${expiresAt}.${normalizedActorId || '-' }.${sign(callId, expiresAt, normalizedActorId)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

function parseToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d{10}$/.test(parts[0])) return null;
  const actorId = parts[1] === '-' ? '' : parts[1];
  if (actorId && !/^[0-9a-f-]{36}$/i.test(actorId)) return null;
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(parts[2])) return null;
  return { expiresAt: Number(parts[0]), actorId, supplied: parts[2] };
}

function getCallEventTokenActor(callId, token, nowMs = Date.now()) {
  if (!getSecret() || !callId) return null;
  const parsed = parseToken(token);
  if (!parsed) return null;
  const now = Math.floor(nowMs / 1000);
  if (parsed.expiresAt < now || parsed.expiresAt > now + TOKEN_TTL_SECONDS + 60) return null;
  if (parsed.legacy) return null;
  const expected = Buffer.from(sign(callId, parsed.expiresAt, parsed.actorId), 'base64url');
  const actual = Buffer.from(parsed.supplied, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return parsed.actorId || null;
}

function verifyCallEventToken(callId, token, nowMs = Date.now()) {
  if (!getSecret() || !callId) return false;
  const parsed = parseToken(token);
  if (!parsed) return false;
  const now = Math.floor(nowMs / 1000);
  if (parsed.expiresAt < now || parsed.expiresAt > now + TOKEN_TTL_SECONDS + 60) return false;
  const expected = parsed.legacy
    ? createHmac('sha256', getSecret())
      .update(`${TOKEN_CONTEXT}:${callId}:${parsed.expiresAt}`)
      .digest('base64url')
    : sign(callId, parsed.expiresAt, parsed.actorId);
  const expectedBytes = Buffer.from(expected, 'base64url');
  const actual = Buffer.from(parsed.supplied, 'base64url');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

module.exports = { createCallEventToken, verifyCallEventToken, getCallEventTokenActor, TOKEN_TTL_SECONDS };
