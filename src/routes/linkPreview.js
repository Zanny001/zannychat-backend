const express = require('express');
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { requireAuth } = require('../middleware/requireAuth');
const { linkPreviewLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Auth first (limiter keys on the user id), then a per-user throttle —
// this endpoint fetches arbitrary URLs server-side, so unlimited calls
// would be both a bandwidth drain and a wider SSRF surface.
router.use(requireAuth, linkPreviewLimiter);

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 200 * 1024;
const MAX_REDIRECTS = 4;

const { isBlockedHost, isBlockedIp } = require('../utils/networkSafety');

async function resolvePublicDestination(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isBlockedHost(hostname)) throw new Error('That host cannot be previewed');
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error('That host cannot be previewed');
  }
  return addresses;
}

// Connect directly to an address validated above while preserving the URL
// hostname for the HTTP Host header and TLS certificate/SNI verification.
// This closes the resolve-then-fetch DNS rebinding window created by global fetch.
function requestPinned(url, addresses, deadlineAt) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const chosen = addresses[0];
    const options = {
      protocol: url.protocol,
      hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZannyChatLinkPreview/1.1)' },
      lookup: (_host, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) {
          callback(null, [{ address: chosen.address, family: chosen.family }]);
        } else {
          callback(null, chosen.address, chosen.family);
        }
      },
      ...(url.protocol === 'https:' && !net.isIP(hostname) ? { servername: hostname } : {}),
    };
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(Object.assign(new Error('Request timed out'), { name: 'AbortError' }));
      return;
    }
    const req = transport.request(options, response => resolve(response));
    // Socket timeout is an inactivity guard; the absolute deadline below is
    // also enforced while resolving DNS and consuming the response body.
    req.setTimeout(remaining, () => req.destroy(Object.assign(new Error('Request timed out'), { name: 'AbortError' })));
    const deadlineTimer = setTimeout(() => req.destroy(Object.assign(new Error('Request timed out'), { name: 'AbortError' })), remaining);
    req.on('close', () => clearTimeout(deadlineTimer));
    req.on('error', reject);
    req.end();
  });
}

function withDeadline(promise, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error('Request timed out'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('Request timed out'), { name: 'AbortError' })), remaining);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return decodeEntities(match[1]);
  }
  return null;
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? decodeEntities(match[1].trim()) : null;
}

// GET /link-preview?url=<encoded>. Redirects are followed manually so each
// destination is checked before a new request is made.
router.get('/', async (req, res) => {
  const { url } = req.query;
  if (typeof url !== 'string' || !url) return res.status(400).json({ error: 'url query param is required' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return res.status(400).json({ error: 'Only public http/https URLs are supported' });
  }

  const deadlineAt = Date.now() + FETCH_TIMEOUT_MS;
  try {
    let response;
    let current = parsed;
    for (let redirects = 0; ; redirects++) {
      const addresses = await withDeadline(resolvePublicDestination(current), deadlineAt);
      response = await requestPinned(current, addresses, deadlineAt);
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) break;
      const location = response.headers.location;
      if (!location) break;
      if (redirects >= MAX_REDIRECTS) {
        response.destroy();
        return res.status(502).json({ error: 'Too many redirects' });
      }
      let next;
      try { next = new URL(location, current); } catch {
        response.destroy();
        return res.status(502).json({ error: 'Invalid redirect destination' });
      }
      response.destroy();
      if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) {
        return res.status(400).json({ error: 'Redirect destination is not allowed' });
      }
      current = next;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      return res.status(502).json({ error: `Fetching that link returned ${response.statusCode}` });
    }

    const chunks = [];
    let received = 0;
    const body = response[Symbol.asyncIterator]();
    while (true) {
      // Bound each read by the same absolute deadline used for DNS and connect.
      const step = await withDeadline(body.next(), deadlineAt).catch(err => {
        response.destroy();
        throw err;
      });
      if (step.done) break;
      const chunk = step.value;
      const remaining = MAX_BYTES - received;
      if (remaining <= 0) { response.destroy(); break; }
      const limited = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(limited);
      received += limited.length;
      if (limited.length < chunk.length) { response.destroy(); break; }
    }
    const html = Buffer.concat(chunks).toString('utf8');
    res.json({
      url: parsed.toString(),
      title: extractMeta(html, 'og:title') || extractTitle(html),
      description: extractMeta(html, 'og:description') || extractMeta(html, 'description'),
      image: extractMeta(html, 'og:image'),
      siteName: extractMeta(html, 'og:site_name') || parsed.hostname,
    });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Fetching that link timed out' });
    if (err.message === 'That host cannot be previewed' || ['ENOTFOUND', 'EAI_AGAIN'].includes(err.code)) {
      return res.status(400).json({ error: 'That host cannot be previewed' });
    }
    return res.status(502).json({ error: 'Could not fetch that link' });
  }

});

module.exports = router;
// Exported separately for tests — the SSRF host blocklist is the one
// piece of logic here worth pinning down with assertions.
module.exports.isBlockedHost = isBlockedHost;
module.exports.isBlockedIp = isBlockedIp;
module.exports.withDeadline = withDeadline;
