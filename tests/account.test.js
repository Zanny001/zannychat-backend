const request = require('supertest');

const mockDeleteUser = jest.fn(async () => ({ data: { user: null }, error: null }));
let authTime = Math.floor(Date.now() / 1000);

jest.mock('../src/config/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: {
      getUser: jest.fn(async (token) => token === 'invalid'
        ? { data: { user: null }, error: { message: 'invalid' } }
        : { data: { user: { id: 'user-1', email: 'one@example.com' } }, error: null }),
      admin: { deleteUser: (...args) => mockDeleteUser(...args) },
    },
  },
}));

const app = require('../src/index');

function tokenWithAuthTime(timestamp) {
  const payload = Buffer.from(JSON.stringify({ auth_time: timestamp })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('POST /account/delete', () => {
  beforeEach(() => {
    mockDeleteUser.mockClear();
    authTime = Math.floor(Date.now() / 1000);
    mockDeleteUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  test('rejects missing explicit confirmation', async () => {
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .set('X-Forwarded-For', '198.51.100.14')
      .set('X-Forwarded-For', '198.51.100.13')
      .set('X-Forwarded-For', '198.51.100.12')
      .set('X-Forwarded-For', '198.51.100.11')
      .send({});
    expect(res.status).toBe(400);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  test('rejects an old session even with explicit confirmation', async () => {
    const oldTime = Math.floor(Date.now() / 1000) - 10 * 60;
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(oldTime)}`)
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  test('deletes only the authenticated user after fresh authentication', async () => {
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(mockDeleteUser).toHaveBeenCalledTimes(1);
    expect(mockDeleteUser).toHaveBeenCalledWith('user-1');
  });

  test('does not claim deletion succeeded when Supabase fails', async () => {
    mockDeleteUser.mockResolvedValueOnce({ data: null, error: { message: 'failed' } });
    const res = await request(app)
      .post('/account/delete')
      .set('Authorization', `Bearer ${tokenWithAuthTime(authTime)}`)
      .send({ confirmation: 'DELETE' });
    expect(res.status).toBe(500);
    expect(res.body.deleted).not.toBe(true);
  });
});
