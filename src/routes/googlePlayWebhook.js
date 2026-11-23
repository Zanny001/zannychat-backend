const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { createGooglePlayBillingClient, sha256Hex } = require('../services/googlePlayBilling');
const { verifyGooglePubSubOidcToken } = require('../utils/googlePubSubOidc');

const router = express.Router();

function decodePubSubMessage(message) {
  if (typeof message?.data !== 'string' || message.data.length > 256 * 1024) {
    throw new Error('Google Pub/Sub message data is missing or too large');
  }
  const decoded = Buffer.from(message.data, 'base64').toString('utf8');
  return JSON.parse(decoded);
}

router.post('/', async (req, res) => {
  const audience = process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE;
  const serviceAccountEmail = process.env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL;
  if (!audience || !serviceAccountEmail || !process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
      || process.env.LIVE_GOOGLE_PLAY_BILLING_ENABLED !== 'true') {
    return res.status(503).json({ error: 'Google Play purchase notifications are not configured' });
  }

  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Google Pub/Sub authentication is required' });

  try {
    await verifyGooglePubSubOidcToken(match[1], { audience, serviceAccountEmail });
  } catch (error) {
    console.warn('[google-play-webhook] OIDC authentication failed:', error?.code || 'invalid_token');
    if (error?.code === 'GOOGLE_CERTS_UNAVAILABLE') {
      return res.status(503).json({ error: 'Google Pub/Sub identity verification is temporarily unavailable' });
    }
    return res.status(401).json({ error: 'Invalid Google Pub/Sub identity token' });
  }

  let notification;
  try {
    if (!req.body || typeof req.body !== 'object' || !req.body.message?.messageId) {
      return res.status(400).json({ error: 'Google Pub/Sub message envelope is invalid' });
    }
    notification = decodePubSubMessage(req.body.message);
  } catch (_) {
    return res.status(400).json({ error: 'Google Play notification payload is invalid' });
  }

  const expectedPackageName = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.zannychat.app';
  if (notification?.packageName !== expectedPackageName) {
    return res.status(200).json({ received: true, ignored: true });
  }

  const voided = notification?.voidedPurchaseNotification;
  if (!voided) {
    // Purchase-completed notifications are fulfilled from the authenticated
    // app purchase flow. Only void notifications can revoke credited Sparks.
    return res.status(200).json({ received: true, ignored: true });
  }
  if (Number(voided.productType) !== 2 || !voided.purchaseToken || !voided.orderId) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const billing = createGooglePlayBillingClient();
    const verified = await billing.verifyVoidedPurchase({
      packageName: expectedPackageName,
      purchaseToken: String(voided.purchaseToken),
      orderId: String(voided.orderId),
      voidedTimeMillis: notification.eventTimeMillis,
    });

    const transactionKey = 'gplay:' + sha256Hex(verified.purchaseToken);
    const { data: purchase, error: purchaseError } = await supabaseAdmin
      .from('live_spark_purchases')
      .select('id,provider_reference,provider_order_id,amount_minor,currency,status')
      .eq('provider', 'google_play')
      .eq('provider_transaction_id', transactionKey)
      .maybeSingle();
    if (purchaseError) throw purchaseError;
    if (!purchase) {
      return res.status(200).json({ received: true, ignored: true, reason: 'purchase_not_fulfilled_by_zannychat' });
    }
    if (purchase.provider_order_id !== verified.orderId) {
      throw new Error('Voided Google Play order does not match the stored purchase');
    }

    const eventKey = 'google_play:google_play.voided:' + verified.orderId + ':' + verified.voidedTimeMillis;
    const { data: result, error: riskError } = await supabaseAdmin.rpc('record_live_google_play_voided_purchase', {
      p_event_key: eventKey,
      p_provider_reference: purchase.provider_reference,
      p_provider_order_id: verified.orderId,
      p_amount_minor: Number(purchase.amount_minor),
      p_currency: purchase.currency,
      p_refund_type: verified.refundType === 1 ? 'full' : 'partial',
      p_provider_resource_id: 'voided:' + verified.orderId,
    });
    if (riskError) throw riskError;

    return res.status(200).json({
      received: true,
      ...result,
    });
  } catch (error) {
    console.error('[google-play-webhook] voided purchase reconciliation failed:', error?.message || error);
    return res.status(503).json({ error: 'Google Play void reconciliation will be retried' });
  }
});

module.exports = router;
