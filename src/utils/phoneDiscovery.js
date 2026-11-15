const crypto = require('crypto');

// Discovery accepts E.164 only. Never guess a country code: incorrect
// normalization can match the wrong person or silently miss a contact.
function normalizeE164(value) {
  if (typeof value !== 'string') return null;
  const valueTrimmed = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(valueTrimmed)) return null;
  return valueTrimmed;
}

function phoneHash(phone, secret = process.env.PHONE_DISCOVERY_HMAC_SECRET) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('Phone discovery HMAC secret must be at least 32 bytes');
  }
  const normalized = normalizeE164(phone);
  if (!normalized) throw new Error('Phone number must be in E.164 format');
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}

function hashContactBatch(values, secret, max = 100) {
  if (!Array.isArray(values) || values.length > max) {
    const error = new Error(`Provide no more than ${max} phone numbers`);
    error.status = 400;
    throw error;
  }
  const normalized = [...new Set(values.map(normalizeE164).filter(Boolean))];
  return normalized.map((phone) => phoneHash(phone, secret));
}

function filterPhoneDiscoveryMatches({ profiles = [], profileDetails = [], sharedUserIds = [], blockedUserIds = [] }) {
  const detailsByUser = new Map(profileDetails.map((row) => [row.user_id, row]));
  const shared = new Set(sharedUserIds);
  const blocked = new Set(blockedUserIds);

  return profiles
    .filter((profile) => {
      if (!profile?.id || blocked.has(profile.id)) return false;
      const details = detailsByUser.get(profile.id) || {};
      const visibility = details.profile_visibility || 'everyone';
      return visibility === 'everyone' || (visibility === 'contacts' && shared.has(profile.id));
    })
    .map((profile) => {
      const details = detailsByUser.get(profile.id) || {};
      const photoVisibility = details.photo_visibility || 'everyone';
      const canSeeAvatar = photoVisibility === 'everyone'
        || (photoVisibility === 'contacts' && shared.has(profile.id));
      return {
        id: profile.id,
        name: profile.name || 'ZannyChat member',
        avatarUrl: canSeeAvatar ? profile.avatar_url || null : null,
        avatarColor: profile.avatar_color || null,
        status: profile.status || null,
      };
    });
}

module.exports = { normalizeE164, phoneHash, hashContactBatch, filterPhoneDiscoveryMatches };
