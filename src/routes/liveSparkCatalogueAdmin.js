const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Sparks catalogue administration is rate-limited.' }));

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
function adminIds() {
  return new Set(String(process.env.LIVE_ECONOMY_ADMIN_USER_IDS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(validUuid));
}
function requireAdmin(req, res, next) {
  const allowed = adminIds();
  if (!allowed.size) return res.status(503).json({ error: 'LIVE economy administration is not configured' });
  if (!allowed.has(String(req.user?.id || '').toLowerCase())) {
    return res.status(403).json({ error: 'LIVE economy administrator access is required' });
  }
  return next();
}
const providers = new Set(['paystack', 'google_play', 'apple_iap']);
function validPackageId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,149}$/.test(value);
}

router.get('/access', (req, res) => res.json({
  isAdmin: adminIds().has(String(req.user?.id || '').toLowerCase()),
}));

router.get('/packages', requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_spark_packages')
      .select('provider,package_id,sparks,amount_minor,currency,is_active,sort_order,updated_at')
      .eq('currency', 'NGN').order('provider').order('sort_order').order('package_id');
    if (error) throw error;
    return res.json({ packages: data || [] });
  } catch (error) {
    console.error('[live-spark-catalogue] list failed:', error?.message || error);
    return res.status(503).json({ error: 'Sparks catalogue is temporarily unavailable' });
  }
});

router.post('/packages', requireAdmin, async (req, res) => {
  const { provider, packageId, sparks, amountMinor, sortOrder = 0 } = req.body || {};
  if (!providers.has(provider) || !validPackageId(packageId)
      || !Number.isSafeInteger(sparks) || sparks < 1 || sparks > 10000000
      || !Number.isSafeInteger(amountMinor) || amountMinor < 1
      || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
    return res.status(400).json({ error: 'Provide a valid provider product ID, Sparks quantity, NGN amount in minor units, and sort order' });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('create_live_spark_package_draft', {
      p_admin_id: req.user.id, p_provider: provider, p_package_id: packageId,
      p_sparks: sparks, p_amount_minor: amountMinor, p_sort_order: sortOrder,
    });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'This provider package ID already exists for NGN' });
      throw error;
    }
    return res.status(201).json({ package: data });
  } catch (error) {
    console.error('[live-spark-catalogue] draft creation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not create the inactive Sparks package draft' });
  }
});

async function setActive(req, res, isActive) {
  const { provider, packageId } = req.params;
  if (!providers.has(provider) || !validPackageId(packageId)) {
    return res.status(400).json({ error: 'Invalid provider or package ID' });
  }
  const expected = isActive ? 'ACTIVATE_SPARKS_PACKAGE' : 'DEACTIVATE_SPARKS_PACKAGE';
  if (req.body?.confirmation !== expected) {
    return res.status(400).json({ error: 'Explicit Sparks package change confirmation is required' });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('set_live_spark_package_active', {
      p_admin_id: req.user.id, p_provider: provider, p_package_id: packageId, p_is_active: isActive,
    });
    if (error) {
      if (error.code === 'P0002') return res.status(404).json({ error: 'Sparks package not found' });
      throw error;
    }
    return res.json({ package: data });
  } catch (error) {
    console.error('[live-spark-catalogue] package state change failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not update the Sparks package state' });
  }
}
router.post('/packages/:provider/:packageId/activate', requireAdmin, (req, res) => setActive(req, res, true));
router.post('/packages/:provider/:packageId/deactivate', requireAdmin, (req, res) => setActive(req, res, false));

module.exports = router;
