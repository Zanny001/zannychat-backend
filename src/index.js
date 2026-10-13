require('dotenv').config();
const express = require('express');
const cors = require('cors');

const healthRouter = require('./routes/health');
const conversationsRouter = require('./routes/conversations');
const aiRouter = require('./routes/ai');
const internalRouter = require('./routes/internal');
const linkPreviewRouter = require('./routes/linkPreview');
const safetyRouter = require('./routes/safety');
const accountRouter = require('./routes/account');

const app = express();

// Render (like most PaaS hosts) terminates TLS at a proxy one hop in
// front of this process — trust exactly that one hop so req.ip is the
// real client IP, which the rate limiter keys on when there's no
// authenticated user. Setting this to `true` instead would let a
// client spoof X-Forwarded-For and dodge the IP fallback limit.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

app.use('/health', healthRouter);
app.use('/conversations', conversationsRouter);
app.use('/ai', aiRouter);
app.use('/link-preview', linkPreviewRouter);
app.use('/safety', safetyRouter);
app.use('/account', accountRouter);
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
  res.status(500).json({ error: 'Internal server error' });
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
