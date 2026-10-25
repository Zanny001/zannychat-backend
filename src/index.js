require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createCorsOptions } = require('./config/corsOptions');

const healthRouter = require('./routes/health');
const conversationsRouter = require('./routes/conversations');
const aiRouter = require('./routes/ai');
const internalRouter = require('./routes/internal');
const linkPreviewRouter = require('./routes/linkPreview');
const safetyRouter = require('./routes/safety');
const accountRouter = require('./routes/account');
const channelsRouter = require('./routes/channels');
const discoveryRouter = require('./routes/discovery');
const callsRouter = require('./routes/calls');

const app = express();

// This is a JSON API, not a document host. Disable Express fingerprinting
// and apply conservative browser security headers without adding a runtime
// dependency. HSTS is only emitted in production, where the public service is
// expected to be reached over HTTPS behind the trusted platform proxy.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Chat, account, and discovery responses can contain personal data. Avoid
  // browser/proxy storage of API payloads unless a future endpoint opts in.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

// Render (like most PaaS hosts) terminates TLS at a proxy one hop in
// front of this process — trust exactly that one hop so req.ip is the
// real client IP, which the rate limiter keys on when there's no
// authenticated user. Setting this to `true` instead would let a
// client spoof X-Forwarded-For and dodge the IP fallback limit.
app.set('trust proxy', 1);

app.use(cors(createCorsOptions()));
app.use(express.json());

// Root discovery endpoint: useful for platform smoke checks and avoids an
// ambiguous 404 when operators open the service URL directly. No secrets or
// internal configuration are exposed here.
app.get('/', (req, res) => {
  res.json({ service: 'zannychat-backend', status: 'ok', health: '/health', liveness: '/health/live', readiness: '/health/ready' });
});

app.use('/health', healthRouter);
app.use('/conversations', conversationsRouter);
app.use('/ai', aiRouter);
app.use('/link-preview', linkPreviewRouter);
app.use('/safety', safetyRouter);
app.use('/account', accountRouter);
app.use('/channels', channelsRouter);
app.use('/discovery', discoveryRouter);
app.use('/calls', callsRouter);
// Called by the Postgres trigger (see 0003_groups_voice_push.sql) on
// every new message, not by an external provider — JSON body, shared-
// secret auth. See internal.js / requireInternalSecret.
app.use('/webhooks', internalRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 403 ? 'Origin not allowed' : 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
// Only listen when run directly (`node src/index.js`) — requiring this
// module from a test (supertest drives app in-process) must not open a
// real port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ZannyChat backend listening on port ${PORT}`);
  });
}

module.exports = app;
