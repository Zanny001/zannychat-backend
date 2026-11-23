const crypto = require('node:crypto');

function safeHexEqual(expectedHex, receivedHex) {
  if (typeof receivedHex !== 'string' || !/^[a-f0-9]{128}$/i.test(receivedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function validLegacySignature(rawBody, signature, apiSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !apiSecret) return false;
  const expected = crypto.createHmac('sha512', apiSecret).update(rawBody).digest('hex');
  return safeHexEqual(expected, signature);
}

function validTimestampedSignature(rawBody, header, webhookSecret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || !webhookSecret) return false;
  const fields = header.split(',').map((part) => part.trim()).filter(Boolean);
  const timestamps = fields.filter((part) => part.startsWith('t='));
  const signatures = fields.filter((part) => part.startsWith('v1='));
  if (timestamps.length !== 1 || signatures.length < 1) return false;

  const timestampText = timestamps[0].slice(2);
  if (!/^\\d{1,12}$/.test(timestampText)) return false;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;

  const expected = crypto.createHmac('sha512', webhookSecret)
    .update(timestampText + '.')
    .update(rawBody)
    .digest('hex');

  return signatures.some((field) => {
    const value = field.slice(3);
    const separator = value.indexOf(':');
    if (separator <= 0) return false;
    const keyId = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (!/^whk_[a-zA-Z0-9_-]+$/.test(keyId)) return false;
    return safeHexEqual(expected, signature);
  });
}

function validPaystackWebhookSignature({
  rawBody,
  headers = {},
  apiSecret = process.env.PAYSTACK_SECRET_KEY,
  webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (!Buffer.isBuffer(rawBody)) return false;
  const timestampedHeader = headers['paystack-signature'] || headers['Paystack-Signature'];
  if (timestampedHeader !== undefined) {
    // Never downgrade to the legacy signature if a v2 header was supplied but invalid.
    return validTimestampedSignature(rawBody, timestampedHeader, webhookSecret, nowSeconds);
  }
  const legacyHeader = headers['x-paystack-signature'] || headers['X-Paystack-Signature'];
  return validLegacySignature(rawBody, legacyHeader, apiSecret);
}

module.exports = {
  validPaystackWebhookSignature,
  validTimestampedSignature,
  validLegacySignature,
};
