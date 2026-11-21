const express = require('express');
const { randomUUID } = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const ALLOWED_SECTORS = new Set(['app', 'calls', 'live', 'chats', 'messages', 'profile', 'settings', 'media']);
const ALLOWED_ROUTES = new Set([
  'App', 'Main', 'Chats', 'Chat', 'Call', 'GroupCall', 'IncomingCall', 'OutgoingCall',
  'LIVE', 'LiveHub', 'LivePreflight', 'LiveStream', 'LiveReplay', 'LiveCreatorStudio',
  'LiveGuestQueue', 'LiveModeration', 'LiveReports', 'LiveAnalytics', 'LiveSettings',
  'LiveCreatorProfile', 'LiveReplayLibrary', 'LivePostStreamSummary', 'LiveLeaderboard', 'LiveEvents',
  'Profile', 'Settings', 'SharedMedia', 'Updates', 'Channels',
]);

// Client diagnostics are deliberately allow-listed and redacted. Never accept
// arbitrary user/session identifiers, request URLs, tokens, or message content.
function safeDiagnosticText(value, maxLength = 1200) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\b\d{7,}\b/g, '[number]')
    .slice(0, maxLength);
}

router.use(requireAuth, makeLimiter({
  windowMs: 60 * 1000,
  max: 10,
  error: 'Diagnostic reports are rate-limited. Please wait before retrying.',
}));

router.post('/client-error', (req, res) => {
  const body = req.body || {};
  const sector = typeof body.sector === 'string' ? body.sector : '';
  const routeName = typeof body.route === 'string' ? body.route : '';
  if (!ALLOWED_SECTORS.has(sector) || !ALLOWED_ROUTES.has(routeName)) {
    return res.status(400).json({ error: 'Invalid diagnostic context' });
  }

  const eventId = randomUUID();
  const record = {
    eventId,
    sector,
    route: routeName,
    platform: ['web', 'ios', 'android', 'unknown'].includes(body.platform) ? body.platform : 'unknown',
    errorName: safeDiagnosticText(body.errorName || 'Error', 80).replace(/[^A-Za-z0-9_$.-]/g, '') || 'Error',
    message: safeDiagnosticText(body.message || 'Render failed', 500),
    componentStack: safeDiagnosticText(body.componentStack || '', 1800),
    phase: body.phase === 'render' ? 'render' : 'unknown',
    occurredAt: typeof body.occurredAt === 'string' && Number.isFinite(Date.parse(body.occurredAt))
      ? new Date(body.occurredAt).toISOString()
      : null,
  };

  console.error('[client-diagnostic]', record);
  return res.status(202).json({ accepted: true, eventId });
});

module.exports = router;
