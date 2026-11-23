const express = require('express');
const crypto = require('node:crypto');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { createAppleStoreVerifier, appleBillingConfigured, minorUnitsFromApplePrice } = require('../services/appleStoreBilling');

const router = express.Router();

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function validTransactionId(value) {
  return typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
}

router.post('/', async (req, res) => {
  if (!appleBillingConfigured()) {
    return res.status(503).json({ error: 'Apple server notifications are not configured' });
  }
  const signedPayload = req.body?.signedPayload;
  if (typeof signedPayload !== 'string' || signedPayload.length < 100 || signedPayload.length > 100000) {
    return res.status(400).json({ error: 'Apple signed notification payload is invalid' });
  }

  try {
    const verifier = createAppleStoreVerifier({
      allowSandbox: true, // Verify sandbox notifications so they can be acknowledged without crediting production Sparks.
    });
    const verifiedResult = await verifier.verifyNotification(signedPayload);
    const notification = verifiedResult.notification;
    const notificationUuid = notification?.notificationUUID;
    const notificationType = notification?.notificationType;
    if (typeof notificationUuid !== 'string' || notificationUuid.length < 8
        || notificationUuid.length > 128 || typeof notificationType !== 'string') {
      return res.status(400).json({ error: 'Verified Apple notification is missing its event identity' });
    }

    const { data: prior, error: priorError } = await supabaseAdmin
      .from('live_apple_server_notifications')
      .select('notification_uuid')
      .eq('notification_uuid', notificationUuid)
      .maybeSingle();
    if (priorError) throw priorError;
    if (prior) return res.status(200).json({ received: true, duplicate: true });

    const payloadSha256 = crypto.createHash('sha256').update(signedPayload).digest('hex');
    let transactionKey = null;
    let processingResult = { ignored: true, reason: 'notification_type_not_actionable' };

    if (verifiedResult.environment !== 'Production') {
      processingResult = { ignored: true, reason: 'sandbox_notification' };
    } else if (notificationType === 'REFUND' || notificationType === 'REVOKE') {
      const signedTransaction = notification?.data?.signedTransactionInfo;
      if (typeof signedTransaction !== 'string') {
        throw new Error('Apple refund notification does not contain signed transaction information');
      }
      const transactionResult = await verifier.verifyTransaction(signedTransaction);
      const transaction = transactionResult.transaction;
      if (transactionResult.environment !== 'Production'
          || transaction.bundleId !== process.env.APPLE_APP_BUNDLE_ID
          || transaction.type !== 'Consumable'
          || !validTransactionId(transaction.transactionId)
          || transaction.revocationDate == null) {
        throw new Error('Apple refund notification transaction is not a valid revoked consumable');
      }
      transactionKey = 'apple:' + sha256Hex(transaction.transactionId);
      const amountMinor = minorUnitsFromApplePrice(transaction.price, transaction.currency);
      const refundType = Number(transaction.revocationPercentage) > 0
        && Number(transaction.revocationPercentage) < 100000 ? 'partial' : 'full';
      const { data: refundResult, error: refundError } = await supabaseAdmin.rpc('record_live_apple_refund', {
        p_event_key: 'apple:' + notificationUuid,
        p_provider_transaction_id: transactionKey,
        p_amount_minor: amountMinor,
        p_currency: transaction.currency,
        p_refund_type: refundType,
        p_provider_resource_id: 'transaction:' + sha256Hex(transaction.transactionId),
      });
      if (refundError) throw refundError;
      processingResult = refundResult || { received: true };
    }

    const { error: insertError } = await supabaseAdmin.from('live_apple_server_notifications')
      .insert({
        notification_uuid: notificationUuid,
        notification_type: notificationType,
        subtype: notification.subtype || null,
        environment: verifiedResult.environment,
        transaction_key: transactionKey,
        payload_sha256: payloadSha256,
        processing_result: processingResult,
      });
    if (insertError && insertError.code !== '23505') throw insertError;

    return res.status(200).json({ received: true, ...processingResult });
  } catch (error) {
    console.error('[apple-store-notifications] verification or reconciliation failed:', error?.code || 'provider_error');
    return res.status(503).json({ error: 'Apple notification could not be safely reconciled and will be retried' });
  }
});

module.exports = router;
