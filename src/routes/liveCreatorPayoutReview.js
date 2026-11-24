const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 20, error: 'Payout review requests are rate-limited.' }));

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function payoutReviewAdminIds() {
  return new Set(String(process.env.LIVE_PAYOUT_ADMIN_USER_IDS || '')
    .split(',').map((value) => value.trim().toLowerCase())
    .filter((value) => validUuid(value)));
}

function requirePayoutReviewAdmin(req, res, next) {
  const allowed = payoutReviewAdminIds();
  if (allowed.size === 0) return res.status(503).json({ error: 'Payout review administration is not configured' });
  if (!allowed.has(String(req.user?.id || '').toLowerCase())) {
    return res.status(403).json({ error: 'Payout review administrator access is required' });
  }
  return next();
}

router.get('/queue', requirePayoutReviewAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_payout_profiles')
      .select('creator_id,verification_status,verification_provider,verified_at,payout_hold,updated_at')
      .in('verification_status', ['pending', 'unverified', 'rejected'])
      .order('updated_at', { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ reviews: data || [] });
  } catch (error) {
    console.error('[live-payout-review] queue lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Payout review queue is temporarily unavailable' });
  }
});

router.post('/:creatorId', requirePayoutReviewAdmin, async (req, res) => {
  if (!validUuid(req.params.creatorId)) return res.status(400).json({ error: 'Invalid creator id' });
  const { verificationStatus, verificationProvider, verificationReference, payoutHold = false } = req.body || {};
  if (!['pending', 'verified', 'rejected'].includes(verificationStatus)
      || typeof payoutHold !== 'boolean') {
    return res.status(400).json({ error: 'Provide a valid verification decision and payout hold state' });
  }
  if (verificationStatus === 'verified'
      && (typeof verificationProvider !== 'string' || verificationProvider.trim().length < 2
        || verificationProvider.trim().length > 80
        || typeof verificationReference !== 'string' || verificationReference.trim().length < 3
        || verificationReference.trim().length > 200)) {
    return res.status(400).json({ error: 'Verified decisions require a verification provider and evidence reference' });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('review_live_creator_payout_profile', {
      p_admin_id: req.user.id,
      p_creator_id: req.params.creatorId,
      p_verification_status: verificationStatus,
      p_verification_provider: verificationStatus === 'verified' ? verificationProvider.trim() : null,
      p_verification_reference: verificationStatus === 'verified' ? verificationReference.trim() : null,
      p_payout_hold: payoutHold,
    });
    if (error) {
      if (error.code === '22023') return res.status(400).json({ error: 'Invalid payout review decision' });
      if (error.code === 'P0002') return res.status(404).json({ error: 'Creator account not found' });
      throw error;
    }
    return res.json({ review: data });
  } catch (error) {
    console.error('[live-payout-review] decision failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not save the payout review decision' });
  }
});

module.exports = router;
