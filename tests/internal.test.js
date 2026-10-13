const request = require('supertest');
const { resetMockSupabase, setTableResult } = require('./helpers/mockSupabase');

const mockSendPushToUser = jest.fn(async () => ({ sent: 1 }));

jest.mock('../src/config/supabaseAdmin', () => {
  const helpers = require('./helpers/mockSupabase');
  return {
    supabaseAdmin: {
      from: (table) => helpers.makeBuilder(table),
      auth: helpers.makeAuth(),
    },
  };
});

jest.mock('../src/config/pushClient', () => ({
  sendPushToUser: (...args) => mockSendPushToUser(...args),
}));

const app = require('../src/index');

const SECRET = 'test-webhook-secret';

describe('POST /webhooks/new-message', () => {
  beforeEach(() => {
    resetMockSupabase();
    mockSendPushToUser.mockClear();
    process.env.INTERNAL_WEBHOOK_SECRET = SECRET;

    setTableResult('conversations', { data: { name: null, is_group: false }, error: null });
    setTableResult('conversation_participants', {
      data: [
        { user_id: 'user-1', is_muted: false }, // the sender
        { user_id: 'user-2', is_muted: false },
        { user_id: 'user-3', is_muted: false }, // blocked the sender (see below)
        { user_id: 'user-4', is_muted: true }, // muted the conversation
      ],
      error: null,
    });
    setTableResult('profiles', { data: { name: 'One' }, error: null });
    setTableResult('blocked_users', { data: [{ blocker_id: 'user-3' }], error: null });
  });

  test('responds 501 when the backend has no secret configured', async () => {
    delete process.env.INTERNAL_WEBHOOK_SECRET;
    const res = await request(app).post('/webhooks/new-message').send({});
    expect(res.status).toBe(501);
  });

  test('rejects a wrong secret (constant-time compare)', async () => {
    const res = await request(app)
      .post('/webhooks/new-message')
      .set('Authorization', 'Bearer wrong-secret')
      .send({ conversationId: 'conv-1', senderId: 'user-1' });
    expect(res.status).toBe(401);
  });

  test('rejects a secret of the wrong length without crashing', async () => {
    const res = await request(app)
      .post('/webhooks/new-message')
      .set('Authorization', 'Bearer x')
      .send({ conversationId: 'conv-1', senderId: 'user-1' });
    expect(res.status).toBe(401);
  });

  test('requires conversationId and senderId', async () => {
    const res = await request(app)
      .post('/webhooks/new-message')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('skips muted participants and anyone who blocked the sender', async () => {
    const res = await request(app)
      .post('/webhooks/new-message')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ conversationId: 'conv-1', senderId: 'user-1', text: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recipients: 1, sent: 1 });
    // Only user-2 should receive a push: user-3 blocked the sender,
    // user-4 muted the conversation, user-1 is the sender.
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser.mock.calls[0][0]).toBe('user-2');
  });
});
