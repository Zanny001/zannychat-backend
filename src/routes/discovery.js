const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { makeLimiter } = require('../middleware/rateLimit');
const { normalizeE164, phoneHash, hashContactBatch } = require('../utils/phoneDiscovery');

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
  const { data, error } = await supabaseAdmin.from('phone_discovery').select('user_id, profiles:user_id(id,name,avatar_url,avatar_color,status)').in('phone_hash', hashes).eq('discoverable', true).neq('user_id', req.user.id).limit(100);
  if (error) { console.error('[discovery] match query failed'); return res.status(500).json({ error: 'Unable to match contacts right now' }); }
  const matches = (data || []).filter((row) => row.profiles).map((row) => ({ id: row.profiles.id, name: row.profiles.name || 'ZannyChat member', avatarUrl: row.profiles.avatar_url || null, avatarColor: row.profiles.avatar_color || null, status: row.profiles.status || null }));
  return res.json({ matches });
});

module.exports = router;
