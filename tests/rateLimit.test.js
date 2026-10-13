const { keyForRequest } = require('../src/middleware/rateLimit');

describe('rate limiter key generation', () => {
  test('keys on the authenticated user id when one is attached', () => {
    const req = { user: { id: 'abc-123' }, ip: '10.0.0.1' };
    expect(keyForRequest(req)).toBe('user:abc-123');
  });

  test('falls back to the client IP when there is no user', () => {
    const req = { ip: '203.0.113.7' };
    expect(keyForRequest(req)).toBe('ip:203.0.113.7');
  });

  test('different users on the same IP get different buckets', () => {
    const a = keyForRequest({ user: { id: 'user-a' }, ip: '10.0.0.1' });
    const b = keyForRequest({ user: { id: 'user-b' }, ip: '10.0.0.1' });
    expect(a).not.toBe(b);
  });
});
