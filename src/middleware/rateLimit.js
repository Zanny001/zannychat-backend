const rateLimit = require('express-rate-limit');

// Abuse-resistance layer, added after the Oct 2026 audit found zero
// rate limiting anywhere in the request path. Keys on the
// authenticated user id (attached by requireAuth, which always runs
// before these limiters — see the router files) so one abusive account
// can't hide behind rotating IPs, and so two users sharing an office
// NAT don't eat each other's budget. Falls back to IP for requests
// that never made it through auth (bad/expired tokens still cost this
// service a Supabase round-trip, so they're worth throttling too).
//
// ipKeyGenerator exists on express-rate-limit >= 7.5 and handles the
// IPv6 subnetting correctly — a naive `req.ip` key lets an IPv6 client
// rotate through its /64 to dodge the limit. Fall back gracefully if
// an older version is installed.
const { ipKeyGenerator } = rateLimit;

function keyForRequest(req) {
  if (req.user?.id) return `user:${req.user.id}`;
  const ip = ipKeyGenerator ? ipKeyGenerator(req.ip) : req.ip;
  return `ip:${ip}`;
}

function makeLimiter({ windowMs, max, error }) {
  return rateLimit({
    windowMs,
    limit: max,
    keyGenerator: keyForRequest,
    standardHeaders: true, // RateLimit-* headers, so a well-behaved client can back off
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error });
    },
  });
}

// Conversation/group creation and general routes — generous, since a
// normal session reads /health and lists conversations freely.
const conversationsLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  error: "You're doing that too quickly — wait a moment and try again.",
});

// Every call here spends real Anthropic tokens against this project's
// own key — the audit called unlimited AI calls the most exploitable
// gap in the app, so this is deliberately the tightest limit.
const aiLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 10,
  error: 'AI features are rate-limited — wait a moment before trying again.',
});

// Server-side fetching on arbitrary URLs: throttled harder than plain
// routes but looser than AI (no token spend, just bandwidth + SSRF
// surface).
const linkPreviewLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  error: 'Too many link previews — wait a moment and try again.',
});

// Block/report/list-blocked — not expensive, but an abuser scripting
// these is itself an abuse vector (mass-blocking, report flooding).
const safetyLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  error: 'Too many requests — wait a moment and try again.',
});

module.exports = {
  makeLimiter,
  keyForRequest, // exported for tests
  conversationsLimiter,
  aiLimiter,
  linkPreviewLimiter,
  safetyLimiter,
};
