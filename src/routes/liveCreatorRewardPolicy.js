const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Creator reward policy requests are rate-limited.' }));

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function rewardPolicyAdminIds() {
  return new Set(String(process.env.LIVE_ECONOMY_ADMIN_USER_IDS || '')
    .split(',').map((value) => value.trim().toLowerCase())
    .filter(validUuid));
}

function requireRewardPolicyAdmin(req, res, next) {
  const allowed = rewardPolicyAdminIds();
  if (allowed.size === 0) return res.status(503).json({ error: 'Creator reward policy administration is not configured' });
  if (!allowed.has(String(req.user?.id || '').toLowerCase())) {
    return res.status(403).json({ error: 'Creator reward policy administrator access is required' });
  }
  return next();
}

router.get('/access', (req, res) => res.json({
  isAdmin: rewardPolicyAdminIds().has(String(req.user?.id || '').toLowerCase()),
}));

router.get('/rules', requireRewardPolicyAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_reward_rules')
      .select('id,currency,creator_share_bps,clearance_hours,minimum_withdrawal_minor,is_active,created_by,created_at')
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ rules: data || [] });
  } catch (error) {
    console.error('[live-reward-policy] rule list failed:', error?.message || error);
    return res.status(503).json({ error: 'Creator reward policies are temporarily unavailable' });
  }
});

router.post('/rules', requireRewardPolicyAdmin, async (req, res) => {
  const { creatorShareBps, clearanceHours, minimumWithdrawalMinor } = req.body || {};
  if (!Number.isSafeInteger(creatorShareBps) || creatorShareBps < 1 || creatorShareBps > 10000
      || !Number.isSafeInteger(clearanceHours) || clearanceHours < 0 || clearanceHours > 720
      || !Number.isSafeInteger(minimumWithdrawalMinor) || minimumWithdrawalMinor <= 0) {
    return res.status(400).json({ error: 'Provide a valid creator share (basis points), clearance period (hours), and minimum withdrawal (NGN minor units)' });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('create_live_creator_reward_rule', {
      p_admin_id: req.user.id,
      p_creator_share_bps: creatorShareBps,
      p_clearance_hours: clearanceHours,
      p_minimum_withdrawal_minor: minimumWithdrawalMinor,
    });
    if (error) throw error;
    return res.status(201).json({ rule: data });
  } catch (error) {
    console.error('[live-reward-policy] draft creation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not create the inactive reward policy draft' });
  }
});

router.post('/rules/:ruleId/activate', requireRewardPolicyAdmin, async (req, res) => {
  if (!validUuid(req.params.ruleId)) return res.status(400).json({ error: 'Invalid reward rule id' });
  if (req.body?.confirmation !== 'ACTIVATE_CREATOR_REWARD_RULE') {
    return res.status(400).json({ error: 'Explicit reward policy activation confirmation is required' });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('activate_live_creator_reward_rule', {
      p_admin_id: req.user.id,
      p_rule_id: req.params.ruleId,
    });
    if (error) {
      if (error.code === 'P0002') return res.status(404).json({ error: 'Reward policy draft not found' });
      throw error;
    }
    return res.json({ rule: data });
  } catch (error) {
    console.error('[live-reward-policy] activation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not activate the creator reward policy' });
  }
});

module.exports = router;
