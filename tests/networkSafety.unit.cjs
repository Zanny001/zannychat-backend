'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedHost, isBlockedIp } = require('../src/utils/networkSafety');

test('blocks private, loopback, link-local and special-purpose IPv4 destinations', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1', '224.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, `expected ${ip} to be blocked`);
  }
});

test('blocks non-global IPv6 and special-purpose/documentation ranges', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001:20::1', '3fff::1', '::ffff:192.168.1.1']) {
    assert.equal(isBlockedIp(ip), true, `expected ${ip} to be blocked`);
  }
});

test('allows representative globally routable IPs and hostnames', () => {
  assert.equal(isBlockedIp('8.8.8.8'), false);
  // Avoid overblocking unrelated public allocations sharing only the first
  // one or two octets with a reserved prefix.
  for (const ip of ['192.0.1.1', '198.51.99.1', '203.0.1.1']) {
    assert.equal(isBlockedIp(ip), false, `expected public-range address ${ip} to remain allowed`);
  }
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedHost('example.com'), false);
});

test('blocks local hostnames and IP literals at hostname layer', () => {
  for (const host of ['localhost', 'api.localhost', 'router.local', 'metadata.internal', 'printer.home.arpa', 'nas.lan', 'wiki.corp', 'vault.private', 'portal.intranet', '127.0.0.1', '[::1]']) {
    assert.equal(isBlockedHost(host), true, `expected ${host} to be blocked`);
  }
});


test('fails closed for malformed IP literals and unknown address families', () => {
  for (const ip of ['', 'not-an-ip', '300.1.1.1', '2001:::1', 'fe80::1%']) {
    assert.equal(isBlockedIp(ip), true, `expected malformed address ${JSON.stringify(ip)} to be blocked`);
  }
});

test('blocks hostnames with a trailing dot when they are local-only', () => {
  for (const host of ['localhost.', 'printer.home.arpa.', 'home.arpa', 'router.local.']) {
    assert.equal(isBlockedHost(host), true, `expected ${host} to be blocked`);
  }
});
