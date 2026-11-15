const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { makeLimiter } = require('../middleware/rateLimit');
const { normalizeE164, phoneHash, hashContactBatch, filterPhoneDiscoveryMatches } = require('../utils/phoneDiscovery');

const router = express.Router();
// Discovery responses contain privacy-sensitive account/profile state and must never be cached.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const discoveryLimiter = makeLimiter({ windowMs: 60 * 1000, max: 8, error: 'Contact discovery is rate-limited. Please wait before trying again.' });
const matchLimiter = makeLimiter({ windowMs: 60 * 1000, max: 3, error: 'Contact matching is rate-limited. Please wait before trying again.' });
router.use(requireAuth, discoveryLimiter);

function configured(res) {
  if (!supabaseAdmin) { res.status(500).json({ error: 'Backend is not configured' }); return false; }
  return true;
}
function hasDiscoverySecret() {
  return typeof process.env.PHONE_DISCOVERY_HMAC_SECRET === 'string' && Buffer.byteLength(process.env.PHONE_DISCOVERY_HMAC_SECRET) >= 32;
}

// Enrollment derives the number exclusively from verified Supabase Auth claims.
// Client-supplied phone numbers are never accepted for enrollment.
router.post('/enrollment', async (req, res) => {
  if (!configured(res)) return;
  const user = req.user;
  const discoverable = req.body?.discoverable;
  if (typeof discoverable !== 'boolean') return res.status(400).json({ error: 'discoverable must be true or false' });
  // Opt-out must remain possible even if a user has lost verification or
  // changed their phone since enrollment.
  if (!discoverable) {
    const { error } = await supabaseAdmin.from('phone_discovery').delete().eq('user_id', user.id);
    if (error) { console.error('[discovery] opt-out failed'); return res.status(500).json({ error: 'Unable to update contact discovery settings' }); }
    return res.json({ discoverable: false });
  }
  if (!user.phone || !user.phone_confirmed_at) {
    return res.status(403).json({ error: 'Verify a phone number on your account before enabling contact discovery.' });
  }
  const normalized = normalizeE164(user.phone);
  if (!normalized) return res.status(403).json({ error: 'Your verified account phone must be in international E.164 format.' });
  let hash;
  try { hash = phoneHash(normalized); } catch (_) { return res.status(503).json({ error: 'Contact discovery is not configured yet' }); }
  const { error } = await supabaseAdmin.from('phone_discovery').upsert({ user_id: user.id, phone_hash: hash, discoverable: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) { console.error('[discovery] enrollment failed'); return res.status(500).json({ error: 'Unable to enable contact discovery' }); }
  return res.json({ discoverable: true });
});

router.get('/enrollment', async (req, res) => {
  if (!configured(res)) return;
  const verifiedPhone = Boolean(req.user.phone && req.user.phone_confirmed_at);
  const { data, error } = await supabaseAdmin.from('phone_discovery').select('discoverable,phone_hash').eq('user_id', req.user.id).maybeSingle();
  if (error) { console.error('[discovery] settings read failed'); return res.status(500).json({ error: 'Unable to load contact discovery settings' }); }

  // A verified phone can change after enrollment. Never leave the old number
  // discoverable: retire stale rows if verification was removed or the number
  // no longer matches the keyed index. This is deliberately fail-closed.
  if (data?.discoverable && !verifiedPhone) {
    const { error: deleteError } = await supabaseAdmin.from('phone_discovery').delete().eq('user_id', req.user.id);
    if (deleteError) { console.error('[discovery] stale enrollment cleanup failed'); return res.status(500).json({ error: 'Unable to load contact discovery settings' }); }
    return res.json({ discoverable: false, verifiedPhone: false });
  }
  if (data?.discoverable && verifiedPhone) {
    if (!hasDiscoverySecret()) return res.status(503).json({ error: 'Contact discovery is not configured yet' });
    const normalizedPhone = normalizeE164(req.user.phone);
    let currentHash = null;
    if (normalizedPhone) {
      try { currentHash = phoneHash(normalizedPhone); }
      catch (_) { return res.status(503).json({ error: 'Contact discovery is not configured yet' }); }
    }
    if (!currentHash || currentHash !== data.phone_hash) {
      const { error: deleteError } = await supabaseAdmin.from('phone_discovery').delete().eq('user_id', req.user.id);
      if (deleteError) { console.error('[discovery] stale enrollment cleanup failed'); return res.status(500).json({ error: 'Unable to load contact discovery settings' }); }
      return res.json({ discoverable: false, verifiedPhone: true });
    }
  }
  return res.json({ discoverable: data?.discoverable === true, verifiedPhone });
});

// The client sends only selected contact phone fields over TLS. The backend
// hashes in memory, never stores/logs request values, and returns only profile
// identifiers/public profile fields. Batch capped to 100; result cap 100.
router.post('/match', matchLimiter, async (req, res) => {
  if (!configured(res)) return;
  if (!req.user.phone || !req.user.phone_confirmed_at) return res.status(403).json({ error: 'Verify a phone number on your account before matching contacts.' });
  if (!hasDiscoverySecret()) return res.status(503).json({ error: 'Contact discovery is not configured yet' });
  // Validate and normalize before spending the persistent quota. Malformed
  // requests must not consume the user's legitimate matching budget.
  const phones = req.body?.phones;
  if (!Array.isArray(phones) || phones.length > 100) return res.status(400).json({ error: 'phones must be an array of at most 100 entries' });
  if (phones.some((value) => typeof value !== 'string' || value.length > 32)) return res.status(400).json({ error: 'Each phone entry must be a short string' });
  let hashes;
  try { hashes = hashContactBatch(phones, process.env.PHONE_DISCOVERY_HMAC_SECRET); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message || 'Invalid contact batch' }); }
  if (!hashes.length) return res.json({ matches: [] });
  const { data: withinQuota, error: quotaError } = await supabaseAdmin.rpc('consume_phone_discovery_match_limit', { p_user_id: req.user.id });
  if (quotaError) { console.error('[discovery] persistent rate limit check failed'); return res.status(503).json({ error: 'Contact discovery is temporarily unavailable' }); }
  if (withinQuota !== true) return res.status(429).json({ error: 'Contact matching is rate-limited. Please wait before trying again.' });
  const { data: candidates, error: candidateError } = await supabaseAdmin
    .from('phone_discovery')
    .select('user_id')
    .in('phone_hash', hashes)
    .eq('discoverable', true)
    .neq('user_id', req.user.id)
    .limit(100);
  if (candidateError) { console.error('[discovery] match query failed'); return res.status(500).json({ error: 'Unable to match contacts right now' }); }
  const candidateIds = [...new Set((candidates || []).map((row) => row.user_id).filter(Boolean))];
  if (!candidateIds.length) return res.json({ matches: [] });

  const [profilesResult, detailsResult, viewerMembershipsResult, blockedByViewerResult, blockingViewerResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('id,name,avatar_url,avatar_color,status').in('id', candidateIds),
    supabaseAdmin.from('profile_details').select('user_id,profile_visibility,photo_visibility').in('user_id', candidateIds),
    supabaseAdmin.from('conversation_participants').select('conversation_id').eq('user_id', req.user.id),
    supabaseAdmin.from('blocked_users').select('blocked_id').eq('blocker_id', req.user.id).in('blocked_id', candidateIds),
    supabaseAdmin.from('blocked_users').select('blocker_id').eq('blocked_id', req.user.id).in('blocker_id', candidateIds),
  ]);
  const lookupError = profilesResult.error || detailsResult.error || viewerMembershipsResult.error
    || blockedByViewerResult.error || blockingViewerResult.error;
  if (lookupError) {
    console.error('[discovery] privacy-filtered match lookup failed');
    return res.status(503).json({ error: 'Contact matching is temporarily unavailable' });
  }

  const conversationIds = [...new Set((viewerMembershipsResult.data || []).map((row) => row.conversation_id).filter(Boolean))];
  let sharedUserIds = [];
  if (conversationIds.length) {
    const { data: sharedParticipants, error: sharedError } = await supabaseAdmin
      .from('conversation_participants')
      .select('user_id')
      .in('conversation_id', conversationIds)
      .in('user_id', candidateIds);
    if (sharedError) {
      console.error('[discovery] shared-contact privacy lookup failed');
      return res.status(503).json({ error: 'Contact matching is temporarily unavailable' });
    }
    sharedUserIds = [...new Set((sharedParticipants || []).map((row) => row.user_id).filter(Boolean))];
  }

  const blockedUserIds = [
    ...(blockedByViewerResult.data || []).map((row) => row.blocked_id),
    ...(blockingViewerResult.data || []).map((row) => row.blocker_id),
  ];
  const matches = filterPhoneDiscoveryMatches({
    profiles: profilesResult.data || [],
    profileDetails: detailsResult.data || [],
    sharedUserIds,
    blockedUserIds,
  });
  return res.json({ matches });
});

module.exports = router;
