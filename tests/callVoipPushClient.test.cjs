const test = require('node:test');
const assert = require('node:assert/strict');
const { sendCallVoipPushToUser, sendCallEndedToUser } = require('../src/config/callVoipPushClient');

function adminWithTokens(tokens, error = null) {
  return {
    from(table) {
      assert.equal(table, 'call_voip_tokens');
      const query = {
        select() { return this; },
        eq() { return this; },
        then(resolve) { return Promise.resolve({ data: tokens, error }).then(resolve); },
      };
      return query;
    },
  };
}

test('native VoIP sender reports missing tokens without making network calls', async () => {
  const result = await sendCallVoipPushToUser(adminWithTokens([]), 'user-1', { serverCallId: 'call-1' });
  assert.equal(result.noTokens, true);
  assert.equal(result.sent, 0);
});

test('native VoIP sender safely falls back when APNs and FCM credentials are not configured', async () => {
  const names = ['APNS_PRIVATE_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'FCM_SERVICE_ACCOUNT_JSON'];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const result = await sendCallVoipPushToUser(adminWithTokens([
      { token: 'a'.repeat(64), token_type: 'APNS_VOIP' },
      { token: 'fcm-device-token-example-123456', token_type: 'FCM' },
    ]), 'user-1', { serverCallId: 'call-1' });
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 2);
    assert.equal(result.notConfigured, true);
    const ended = await sendCallEndedToUser(adminWithTokens([{ token: 'fcm-device-token-example-123456' }]), 'user-1', 'call-1');
    assert.equal(ended.sent, 0);
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
});

test('missing VoIP token schema degrades to Expo fallback', async () => {
  const result = await sendCallVoipPushToUser(adminWithTokens(null, { message: 'relation missing' }), 'user-1', { serverCallId: 'call-1' });
  assert.equal(result.notConfigured, true);
  assert.equal(result.sent, 0);
});




test('remote call-ended supports standard APNs alerts but never sends terminal events as PushKit VoIP', async () => {
  const result = await sendCallEndedToUser(adminWithTokens([
    { token: 'a'.repeat(64), token_type: 'APNS_VOIP' },
  ]), 'user-1', 'call-1', 'missed');
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/config/callVoipPushClient.js'), 'utf8');
  assert.match(source, /async function sendApnsAlert/);
  assert.match(source, /'apns-push-type': 'alert'/);
  assert.match(source, /row\.token_type === 'APNS_ALERT'/);
  assert.match(source, /row\.token_type === 'FCM'/);
  const endedSender = source.slice(source.indexOf('async function sendCallEndedToUser'));
  assert.doesNotMatch(endedSender, /APNS_VOIP|sendApnsVoip/);
});
