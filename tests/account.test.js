const request = require('supertest');

const mockDeleteUser = jest.fn(async () => ({ data: { user: null }, error: null }));
const mockQueueSingle = jest.fn(async () => ({ data: { id: 'cleanup-1' }, error: null }));
const mockQueueInsert = jest.fn(() => ({ select: jest.fn(() => ({ single: mockQueueSingle })) }));
const mockQueueUpdateEq = jest.fn(async () => ({ error: null }));
const mockQueueUpdate = jest.fn(() => ({ eq: mockQueueUpdateEq }));
const mockQueueDeleteEq = jest.fn(async () => ({ error: null }));
const mockQueueDelete = jest.fn(() => ({ eq: mockQueueDeleteEq }));
let activeSessionTable = null;
let terminalReplayRows = [];
const mockRpc = jest.fn(async () => ({ data: false, error: null }));
function makeQueryBuilder(table) {
  const builder = {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    in: jest.fn(() => builder),
    or: jest.fn(() => builder),
    is: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    maybeSingle: jest.fn(async () => {
      const active = activeSessionTable === table
        || (table === 'group_call_rooms' && activeSessionTable === 'group_call_participants')
        || (table === 'live_streams' && activeSessionTable === 'live_stream_participants');
      return { data: active ? { id: 'active-session' } : null, error: null };
    }),
    then: (resolve, reject) => {
      let data = [];
      if (table === 'live_stream_replays') data = terminalReplayRows;
      if (table === 'group_call_participants' && activeSessionTable === table) data = [{ room_id: 'room-1' }];
      if (table === 'live_stream_participants' && activeSessionTable === table) data = [{ stream_id: 'stream-1' }];
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return builder;
}
const mockFrom = jest.fn((table) => {
  if (table === 'account_storage_cleanup_jobs') {
    return { insert: mockQueueInsert, update: mockQueueUpdate, delete: mockQueueDelete };
  }
  return makeQueryBuilder(table);
});
let authTime = Math.floor(Date.now() / 1000);

jest.mock('../src/config/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (...args) => mockFrom(...args),
    rpc: (...args) => mockRpc(...args),
    auth: {
      getUser: jest.fn(async (token) => token === 'invalid'
        ? { data: { user: null }, error: { message: 'invalid' } }
        : { data: { user: { id: 'user-1', email: 'one@example.com' } }, error: null }),
      admin: { deleteUser: (...args) => mockDeleteUser(...args) },
    },
  },
}));

jest.mock('../src/jobs/accountStorageCleanup', () => ({
  runAccountStorageCleanup: jest.fn(async () => ({ processed: 1, removed: 3, failed: 0 })),
}));

const app = require('../src/index');

function tokenWithAuthTime(timestamp) {
  const payload = Buffer.from(JSON.stringify({ auth_time: timestamp })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('POST /account/delete', () => {
  beforeEach(() => {
    mockDeleteUser.mockClear();
    mockFrom.mockClear();
    mockQueueSingle.mockClear();
    mockQueueInsert.mockClear();
    mockQueueUpdate.mockClear();
    mockQueueUpdateEq.mockClear();
    mockQueueDelete.mockClear();
    mockQueueDeleteEq.mockClear();
    mockRpc.mockClear();
    activeSessionTable = null;
    terminalReplayRows = [];
    authTime = Math.floor(Date.now() / 1000);
    mockDeleteUser.mockResolvedValue({ data: { user: null }, error: null });
    mockQueueSingle.mockResolvedValue({ data: { id: 'cleanup-1' }, error: null });
    mockQueueUpdateEq.mockResolvedValue({ error: null });
    mockQueueDeleteEq.mockResolvedValue({ error: null });
  });

  test('rejects missing explicit confirmation', async () => {
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .set('X-Forwarded-For', '198.51.100.21')
      .send({});
    expect(res.status).toBe(400);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockQueueInsert).not.toHaveBeenCalled();
  });

  test('rejects an old session even with explicit confirmation', async () => {
    const oldTime = Math.floor(Date.now() / 1000) - 10 * 60;
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(oldTime)}`)
      .set('X-Forwarded-For', '198.51.100.22')
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockQueueInsert).not.toHaveBeenCalled();
  });

  test('queues personal media cleanup before deleting only the authenticated user', async () => {
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .set('X-Forwarded-For', '198.51.100.23')
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, storageCleanupPending: false });
    expect(mockQueueInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-1',
      status: 'held',
    }));
    expect(mockDeleteUser).toHaveBeenCalledTimes(1);
    expect(mockDeleteUser).toHaveBeenCalledWith('user-1');
    expect(mockQueueUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
  });


  test.each([
    'live_streams',
    'live_stream_replays',
    'call_sessions',
    'group_call_rooms',
    'group_call_participants',
    'live_stream_participants',
  ])('blocks account deletion while an active %s session exists', async (table) => {
    activeSessionTable = table;
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .set('X-Forwarded-For', `198.51.100.${30 + ['live_streams', 'live_stream_replays', 'call_sessions', 'group_call_rooms', 'group_call_participants', 'live_stream_participants'].indexOf(table)}`)
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(409);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockQueueInsert).not.toHaveBeenCalled();
  });

  test('releases failed/deleted replay reservations before deleting the account', async () => {
    terminalReplayRows = [{ id: 'replay-1', status: 'failed' }, { id: 'replay-2', status: 'deleted' }];
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .set('X-Forwarded-For', '198.51.100.31')
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenCalledWith('finalize_live_replay_quota', {
      p_replay_id: 'replay-1', p_actual_seconds: 0, p_success: false,
    });
    expect(mockRpc).toHaveBeenCalledWith('finalize_live_replay_quota', {
      p_replay_id: 'replay-2', p_actual_seconds: 0, p_success: false,
    });
  });

  test('does not delete the account when the cleanup job cannot be queued', async () => {
    mockQueueSingle.mockResolvedValueOnce({ data: null, error: { message: 'queue unavailable' } });
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .set('X-Forwarded-For', '198.51.100.24')
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(503);
    expect(res.body.deleted).not.toBe(true);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  test('does not claim deletion succeeded when Supabase Auth fails', async () => {
    mockDeleteUser.mockResolvedValueOnce({ data: null, error: { message: 'failed' } });
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .set('X-Forwarded-For', '198.51.100.25')
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(500);
    expect(res.body.deleted).not.toBe(true);
    expect(mockQueueDelete).toHaveBeenCalledTimes(1);
  });
});
