const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/account.js'), 'utf8');

test('account deletion only blocks genuinely active creator streams and calls', () => {
  const liveStart = route.indexOf("from('live_streams')");
  const liveEnd = route.indexOf('if (activeLive)', liveStart);
  const liveQuery = route.slice(liveStart, liveEnd);
  assert.match(liveQuery, /\.eq\('status', 'live'\)/);
  assert.match(liveQuery, /\.is\('ended_at', null\)/);

  const callStart = route.indexOf("from('call_sessions')");
  const callEnd = route.indexOf('if (activeCall)', callStart);
  const callQuery = route.slice(callStart, callEnd);
  assert.match(callQuery, /\.in\('status', \['ringing', 'accepted'\]\)/);
  assert.match(callQuery, /\.is\('ended_at', null\)/);
});
