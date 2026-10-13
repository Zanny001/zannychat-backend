'use strict';
const net = require('node:net');

// Reject non-public IP ranges, including local/private IPv4 and IPv6 addresses.
function isBlockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    const c = Number(address.split('.')[2]);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && b >= 18 && b <= 19) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (family === 6) {
    const h = address.toLowerCase().split('%')[0];
    if (h.startsWith('::ffff:')) {
      const mapped = h.slice(7);
      if (net.isIP(mapped) === 4) return isBlockedIp(mapped);
      const parts = mapped.split(':');
      if (parts.length === 2 && parts.every(v => /^[0-9a-f]{1,4}$/.test(v))) {
        const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
        return isBlockedIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
      }
      return true;
    }
    // Only accept globally allocated unicast space (2000::/3), then deny
    // documentation, transition, and special-purpose blocks within that range.
    // This deliberately fails closed for unspecified, loopback, link-local,
    // unique-local, multicast, IPv4-compatible, and other non-global ranges.
    const halves = h.split('::');
    if (halves.length > 2) return true;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return true;
    const hextets = [...left, ...Array(missing).fill('0'), ...right].map(part => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return NaN;
      return parseInt(part, 16);
    });
    if (hextets.length !== 8 || hextets.some(value => !Number.isFinite(value))) return true;
    const [firstHextet, secondHextet] = hextets;
    if (firstHextet < 0x2000 || firstHextet > 0x3fff) return true;
    return (firstHextet === 0x2001 && secondHextet === 0x0db8) ||
      // IANA special-purpose IPv6 ranges and documentation prefixes are not
      // suitable link-preview destinations even though some sit inside 2000::/3.
      (firstHextet === 0x2001 && secondHextet <= 0x01ff) ||
      (firstHextet === 0x2001 && secondHextet === 0x0020) ||
      (firstHextet === 0x3fff && secondHextet <= 0x0fff) ||
      firstHextet === 0x2002;
  }
  return true;
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // These suffixes are reserved for loopback, home-network, or private naming.
  // Reject them before DNS lookup so a split-horizon resolver cannot turn a
  // local-only name into a server-side request target.
  if (h === 'localhost' ||
      ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.corp', '.private', '.intranet'].some(suffix => h === suffix.slice(1) || h.endsWith(suffix))) return true;
  return net.isIP(h) ? isBlockedIp(h) : false;
}

module.exports = { isBlockedHost, isBlockedIp };
