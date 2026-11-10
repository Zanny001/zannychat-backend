const { createSign, randomUUID } = require('node:crypto');
const { connect: http2Connect } = require('node:http2');

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function envKey(name) {
  return String(process.env[name] || '').replace(/\\n/g, '\n').trim();
}

function makeJwt(header, claims, key, algorithm) {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(claims));
  const signer = createSign('SHA256');
  signer.update(`${head}.${body}`);
  const signature = signer.sign(algorithm === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return `${head}.${body}.${b64url(signature)}`;
}

async function sendApnsVoipPayload(token, payload, expiration) {
  const key = envKey('APNS_PRIVATE_KEY');
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!key || !keyId || !teamId || !bundleId) return false;
  const jwt = makeJwt({ alg: 'ES256', kid: keyId, typ: 'JWT' }, { iss: teamId, iat: Math.floor(Date.now() / 1000) }, key, 'ES256');
  const host = process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const client = http2Connect(`https://${host}`);
  try {
    await new Promise((resolve, reject) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': `${bundleId}.voip`,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': String(expiration),
        'content-type': 'application/json',
      });
      let status = 0, responseBody = '';
      req.on('response', (headers) => { status = Number(headers[':status']); });
      req.on('data', (chunk) => { responseBody += chunk; });
      req.on('end', () => status === 200 ? resolve() : reject(new Error(`APNs ${status}: ${responseBody}`)));
      req.on('error', reject);
      req.end(JSON.stringify(payload));
    });
    return true;
  } finally {
    client.close();
  }
}

async function sendApnsVoip(token, event) {
  const expiration = event.expiresAt
    ? Math.floor(new Date(event.expiresAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 45;
  return sendApnsVoipPayload(token, { incomingCall: event }, expiration);
}


function nativeEndedReason(status) {
  if (status === 'missed') return 'unanswered';
  if (status === 'declined') return 'declinedElsewhere';
  if (status === 'failed') return 'failed';
  return 'remoteEnded';
}

async function getFcmAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }, account.private_key, 'RS256');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!response.ok) throw new Error(`Google OAuth ${response.status}`);
  const body = await response.json();
  return body.access_token;
}

async function sendFcmData(token, data) {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return false;
  let account;
  try { account = JSON.parse(raw); } catch (_) { throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!account.project_id || !account.client_email || !account.private_key) return false;
  const accessToken = await getFcmAccessToken(account);
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '45s' } } }),
  });
  if (!response.ok) throw new Error(`FCM ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return true;
}


async function sendApnsAlert(token, event) {
  const key = envKey('APNS_PRIVATE_KEY');
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!key || !keyId || !teamId || !bundleId) return false;
  const jwt = makeJwt({ alg: 'ES256', kid: keyId, typ: 'JWT' }, { iss: teamId, iat: Math.floor(Date.now() / 1000) }, key, 'ES256');
  const host = process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const client = http2Connect(`https://${host}`);
  try {
    await new Promise((resolve, reject) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 60),
        'content-type': 'application/json',
      });
      let status = 0, responseBody = '';
      req.on('response', (headers) => { status = Number(headers[':status']); });
      req.on('data', (chunk) => { responseBody += chunk; });
      req.on('end', () => status === 200 ? resolve() : reject(new Error(`APNs alert ${status}: ${responseBody}`)));
      req.on('error', reject);
      req.end(JSON.stringify({
        aps: { alert: { title: 'Call ended', body: 'This call has ended.' }, sound: 'default', category: 'ZANNY_CALL_ENDED' },
        callEnded: event,
      }));
    });
    return true;
  } finally {
    client.close();
  }
}

async function sendCallVoipPushToUser(admin, userId, event) {
  try {
    const { data: tokens, error } = await admin.from('call_voip_tokens').select('token,token_type').eq('user_id', userId);
    if (error) return { sent: 0, failed: 0, notConfigured: true };
    if (!tokens?.length) return { sent: 0, failed: 0, noTokens: true };
    let sent = 0, failed = 0, skipped = 0;
    for (const row of tokens) {
      try {
        const accepted = row.token_type === 'APNS_VOIP'
          ? await sendApnsVoip(row.token, event)
          : row.token_type === 'FCM'
            ? await sendFcmData(row.token, { messageType: 'incomingCall', incomingCall: JSON.stringify(event) })
            : false;
        if (accepted) sent += 1; else skipped += 1;
      } catch (error) {
        failed += 1;
        console.error('[calls] native VoIP push failed:', error?.message || error);
      }
    }
    return { sent, failed, skipped, notConfigured: sent === 0 && failed === 0 };
  } catch (_) {
    return { sent: 0, failed: 0, notConfigured: true };
  }
}

async function sendCallEndedToUser(admin, userId, serverCallId, status = 'ended') {
  try {
    const { data: tokens, error } = await admin.from('call_voip_tokens')
      .select('token,token_type').eq('user_id', userId);
    const endTokens = (tokens || []).filter((row) => ['FCM', 'APNS_ALERT'].includes(row.token_type) && row.token);
    if (error || !endTokens.length) return { sent: 0, failed: 0 };
    const event = { eventId: randomUUID(), serverCallId, reason: nativeEndedReason(status) };
    let sent = 0, failed = 0;
    for (const row of endTokens) {
      try {
        const accepted = row.token_type === 'APNS_ALERT'
          ? await sendApnsAlert(row.token, event)
          : await sendFcmData(row.token, {
            messageType: 'callEnded',
            callEnded: JSON.stringify(event),
          });
        if (accepted) sent += 1;
      } catch (error) {
        failed += 1;
        console.error('[calls] native call-ended push failed:', error?.message || error);
      }
    }
    return { sent, failed };
  } catch (_) {
    return { sent: 0, failed: 0, skipped: 0 };
  }
}

module.exports = { sendCallVoipPushToUser, sendCallEndedToUser };
