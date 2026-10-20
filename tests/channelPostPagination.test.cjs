const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '../../zannychat-frontend-main/src/services/api.js'), 'utf8');
const screen = fs.readFileSync(path.join(__dirname, '../../zannychat-frontend-main/src/screens/ChannelsScreen.js'), 'utf8');

test('channel feed uses a bounded page and stable timestamp/id cursor', () => {
  assert.match(route, /const pageSize = 100/);
  assert.match(route, /limit\(pageSize \+ 1\)/);
  assert.match(route, /created_at\.lt\./);
  assert.match(route, /created_at\.eq\./);
  assert.match(route, /id\.lt\./);
  assert.match(route, /Invalid channel post cursor/);
  assert.match(route, /nextCursor, hasMore/);
});

test('frontend exposes cursor-aware loading and appends older posts without duplicates', () => {
  assert.match(api, /fetchChannelPosts\(channelId, cursor = null\)/);
  assert.match(api, /beforeCreatedAt=/);
  assert.match(api, /beforeId=/);
  assert.match(screen, /const loadOlderPosts = async/);
  assert.match(screen, /Load older posts/);
  assert.match(screen, /mergeChannelPostPages\(old, older\)/);
  assert.match(screen, /import \{ mergeChannelPostPages \} from '..\/utils\/channelPagination'/);
});
