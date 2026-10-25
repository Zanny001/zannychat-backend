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

module.exports = { normalizeE164, phoneHash, hashContactBatch };
