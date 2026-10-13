const request = require('supertest');
const { resetMockSupabase, setTableResult, opsLog } = require('./helpers/mockSupabase');

jest.mock('../src/config/supabaseAdmin', () => {
  const helpers = require('./helpers/mockSupabase');
  return {
    supabaseAdmin: {
      from: (table) => helpers.makeBuilder(table),
      auth: helpers.makeAuth({ id: '11111111-1111-4111-8111-111111111111', email: 'one@example.com' }),
    },
  };
});

const app = require('../src/index');

describe('POST /conversations', () => {
  beforeEach(() => resetMockSupabase());

  test('rejects requests without a bearer token', async () => {
    const res = await request(app).post('/conversations').send({ participantId: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(401);
  });

  test('rejects a missing participantId', async () => {
    const res = await request(app)
      .post('/conversations')
      .set('Authorization', 'Bearer good-token')
      .send({});
    expect(res.status).toBe(400);
  });

  test('rejects starting a conversation with yourself', async () => {
    const res = await request(app)
      .post('/conversations')
      .set('Authorization', 'Bearer good-token')
      .send({ participantId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(400);
  });

  test('refuses to create a 1:1 when a block exists in either direction', async () => {
    setTableResult('blocked_users', { data: [{ blocker_id: '22222222-2222-4222-8222-222222222222', blocked_id: '11111111-1111-4111-8111-111111111111' }], error: null });

    const res = await request(app)
      .post('/conversations')
      .set('Authorization', 'Bearer good-token')
      .send({ participantId: '22222222-2222-4222-8222-222222222222' });

    expect(res.status).toBe(403);
    // The block check happens before any writes — nothing should have
    // been inserted.
    expect(opsLog.filter((op) => op.endsWith('.insert'))).toHaveLength(0);
  });

  test('creates the conversation and both participant rows on the happy path', async () => {
    setTableResult('blocked_users', { data: [], error: null });
    setTableResult('conversations', { data: { id: 'conv-1' }, error: null });
    setTableResult('conversation_participants', { data: null, error: null });

    const res = await request(app)
      .post('/conversations')
      .set('Authorization', 'Bearer good-token')
      .send({ participantId: '22222222-2222-4222-8222-222222222222' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('conv-1');
    expect(opsLog).toContain('conversations.insert');
    expect(opsLog).toContain('conversation_participants.insert');
  });

  test('rolls back the conversation row when participant insertion fails', async () => {
    setTableResult('blocked_users', { data: [], error: null });
    setTableResult('conversations', { data: { id: 'conv-1' }, error: null });
    setTableResult('conversation_participants', { data: null, error: { message: 'db exploded' } });

    const res = await request(app)
      .post('/conversations')
      .set('Authorization', 'Bearer good-token')
      .send({ participantId: '22222222-2222-4222-8222-222222222222' });

    expect(res.status).toBe(500);
    // The orphaned conversation must be deleted rather than left behind.
    expect(opsLog).toContain('conversations.delete');
  });
});

describe('POST /conversations/group', () => {
  beforeEach(() => resetMockSupabase());

  test('requires at least 2 other participants', async () => {
    const res = await request(app)
      .post('/conversations/group')
      .set('Authorization', 'Bearer good-token')
      .send({ participantIds: ['22222222-2222-4222-8222-222222222222'], name: 'Too small' });
    expect(res.status).toBe(400);
  });

  test('requires a group name', async () => {
    const res = await request(app)
      .post('/conversations/group')
      .set('Authorization', 'Bearer good-token')
      .send({ participantIds: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'], name: '   ' });
    expect(res.status).toBe(400);
  });
});
