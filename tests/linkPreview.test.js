const { isBlockedHost, isBlockedIp, withDeadline } = require('../src/routes/linkPreview');

describe('link preview SSRF destination checks', () => {
  test.each([
    'localhost', 'service.localhost', 'host.local', 'metadata.internal',
    '127.0.0.1', '10.0.0.4', '172.16.0.1', '172.31.255.255',
    '192.168.1.2', '169.254.169.254', '192.0.2.1', '198.51.100.4', '203.0.113.7', '::1', '::', 'fc00::1',
    'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001:0db8::1', '2001:0001::1', '2001:1::1', '2001:0001::1', '2001:0db8::1', '2002:7f00:1::', '::ffff:192.168.1.1',
  ])('blocks private/local host %s', host => expect(isBlockedHost(host)).toBe(true));
  test.each(['8.8.8.8', '1.1.1.1', 'example.com'])('allows public host %s at hostname layer', host => expect(isBlockedHost(host)).toBe(false));
  test.each(['0.0.0.0', '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.1', '172.20.0.1', '192.168.0.1', '192.0.2.1', '198.51.100.4', '203.0.113.7', '224.0.0.1', '::1', 'fc00::1', '2001:1::1', '2001:0001::1', '2001:0db8::1', '2002:7f00:1::', '::ffff:192.168.1.1'])('blocks non-public IP %s', ip => expect(isBlockedIp(ip)).toBe(true));
  test('allows ordinary public IP addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
});


describe('link preview absolute deadline', () => {
  test('rejects immediately when the deadline has expired', async () => {
    await expect(withDeadline(Promise.resolve('ok'), Date.now() - 1))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  test('rejects a pending operation at the deadline', async () => {
    const pending = new Promise(() => {});
    await expect(withDeadline(pending, Date.now() + 15))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  test('returns a result before the deadline', async () => {
    await expect(withDeadline(Promise.resolve('ok'), Date.now() + 100))
      .resolves.toBe('ok');
  });
});
