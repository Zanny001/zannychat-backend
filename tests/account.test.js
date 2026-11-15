const request = require('supertest');

const mockDeleteUser = jest.fn(async () => ({ data: { user: null }, error: null }));
const mockQueueSingle = jest.fn(async () => ({ data: { id: 'cleanup-1' }, error: null }));
const mockQueueInsert = jest.fn(() => ({ select: jest.fn(() => ({ single: mockQueueSingle })) }));
const mockQueueUpdateEq = jest.fn(async () => ({ error: null }));
const mockQueueUpdate = jest.fn(() => ({ eq: mockQueueUpdateEq }));
const mockQueueDeleteEq = jest.fn(async () => ({ error: null }));
const mockQueueDelete = jest.fn(() => ({ eq: mockQueueDeleteEq }));
const mockFrom = jest.fn((table) => {
  if (table !== 'account_storage_cleanup_jobs') throw new Error(`Unexpected table: ${table}`);
  return { insert: mockQueueInsert, update: mockQueueUpdate, delete: mockQueueDelete };
});
let authTime = Math.floor(Date.now() / 1000);

jest.mock('../src/config/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (...args) => mockFrom(...args),
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
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockQueueInsert).not.toHaveBeenCalled();
  });

  test('queues personal media cleanup before deleting only the authenticated user', async () => {
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
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

  test('does not delete the account when the cleanup job cannot be queued', async () => {
    mockQueueSingle.mockResolvedValueOnce({ data: null, error: { message: 'queue unavailable' } });
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
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
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(500);
    expect(res.body.deleted).not.toBe(true);
    expect(mockQueueDelete).toHaveBeenCalledTimes(1);
  });
});
