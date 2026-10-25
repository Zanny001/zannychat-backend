const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { buildIceConfig } = require('../utils/turnCredentials.cjs');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Call setup is rate-limited. Please wait before trying again.' }));

// Never expose the TURN shared secret to the mobile bundle. coturn REST-style
// credentials are short-lived and scoped to the authenticated account.
router.get('/ice-config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const urls = (process.env.TURN_URLS || '').split(',').map((url) => url.trim()).filter(Boolean);
  const requestedTtl = Number.parseInt(process.env.TURN_CREDENTIAL_TTL_SECONDS || '3600', 10);
  const config = buildIceConfig({
    userId: req.user.id,
    urls,
    secret: process.env.TURN_SHARED_SECRET || '',
    ttlSeconds: requestedTtl,
  });
  return res.json(config);
});

module.exports = router;
