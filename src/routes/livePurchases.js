const express = require('express');
const crypto = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'LIVE purchase requests are rate-limited.' }));

function validPackageId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(value);
}

function paystackConfigured() {
  return process.env.LIVE_PURCHASES_ENABLED === 'true'
    && process.env.LIVE_PURCHASES_RISK_WEBHOOKS_READY === 'true'
    && Boolean(process.env.PAYSTACK_SECRET_KEY);
}

router.get('/packages', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_spark_packages')
      .select('package_id,sparks,amount_minor,currency,sort_order')
      .eq('provider', 'paystack').eq('currency', 'NGN').eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return res.json({
      packages: data || [],
      provider: 'paystack',
      currency: 'NGN',
      purchasable: paystackConfigured() && Boolean(data?.length),
    });
  } catch (error) {
    console.error('[live-purchases] package catalogue lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE purchase packages are temporarily unavailable' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_spark_purchases')
      .select('id,package_id,sparks,amount_minor,currency,status,verified_at,created_at')
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    const purchases = data || [];
    const purchaseIds = purchases.map((purchase) => purchase.id);
    let receiptsByPurchase = new Map();
    if (purchaseIds.length) {
      const { data: receipts, error: receiptError } = await supabaseAdmin.from('live_spark_purchase_receipts')
        .select('purchase_id,receipt_number').in('purchase_id', purchaseIds);
      if (receiptError) throw receiptError;
      receiptsByPurchase = new Map((receipts || []).map((receipt) => [receipt.purchase_id, receipt]));
    }
    return res.json({
      purchases: purchases.map((purchase) => {
        const receipt = receiptsByPurchase.get(purchase.id);
        return { ...purchase, receiptAvailable: Boolean(receipt), receiptNumber: receipt?.receipt_number || null };
      }),
    });
  } catch (error) {
    console.error('[live-purchases] purchase history lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Purchase history is temporarily unavailable' });
  }
});

router.get('/:purchaseId/receipt', async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.purchaseId)) {
    return res.status(400).json({ error: 'Invalid purchase id' });
  }
  try {
    const { data: purchase, error: purchaseError } = await supabaseAdmin.from('live_spark_purchases')
      .select('id,status').eq('id', req.params.purchaseId).eq('user_id', req.user.id).maybeSingle();
    if (purchaseError) throw purchaseError;
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status !== 'paid') return res.status(409).json({ error: 'A receipt is available only for a verified paid purchase' });

    const { data: receipt, error: receiptError } = await supabaseAdmin.from('live_spark_purchase_receipts')
      .select('receipt_number,storage_path').eq('purchase_id', purchase.id).maybeSingle();
    if (receiptError) throw receiptError;
    if (!receipt) return res.status(404).json({ error: 'Receipt is still being prepared. Refresh and try again shortly.' });

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from('live-purchase-receipts').createSignedUrl(receipt.storage_path, 60);
    if (signedError || !signed?.signedUrl) throw signedError || new Error('Receipt download URL could not be created');
    return res.json({ receiptNumber: receipt.receipt_number, downloadUrl: signed.signedUrl, expiresInSeconds: 60 });
  } catch (error) {
    console.error('[live-purchases] receipt download link failed:', error?.message || error);
    return res.status(503).json({ error: 'Receipt download is temporarily unavailable' });
  }
});

router.get('/:purchaseId', async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.purchaseId)) {
    return res.status(400).json({ error: 'Invalid purchase id' });
  }
  try {
    const { data, error } = await supabaseAdmin.from('live_spark_purchases')
      .select('id,package_id,sparks,amount_minor,currency,status,verified_at,created_at')
      .eq('id', req.params.purchaseId).eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Purchase not found' });
    return res.json({ purchase: data });
  } catch (error) {
    console.error('[live-purchases] purchase status lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Purchase status is temporarily unavailable' });
  }
});

router.post('/initialize', async (req, res) => {
  const { packageId } = req.body || {};
  if (!validPackageId(packageId)) return res.status(400).json({ error: 'Select a valid Sparks package' });
  if (!paystackConfigured()) {
    return res.status(503).json({ error: 'LIVE purchases are not configured yet', code: 'PAYMENTS_NOT_CONFIGURED' });
  }
  if (!req.user?.email || !req.user?.email_confirmed_at) return res.status(403).json({ error: 'Verify your account email before purchasing Sparks' });

  try {
    const { data: pack, error: packageError } = await supabaseAdmin.from('live_spark_packages')
      .select('package_id,sparks,amount_minor,currency')
      .eq('provider', 'paystack').eq('currency', 'NGN').eq('package_id', packageId)
      .eq('is_active', true).maybeSingle();
    if (packageError) throw packageError;
    if (!pack) return res.status(404).json({ error: 'This Sparks package is not available' });

    const reference = 'ZC_LIVE_' + crypto.randomUUID().replace(/-/g, '');
    const { data: purchase, error: insertError } = await supabaseAdmin.from('live_spark_purchases')
      .insert({
        user_id: req.user.id,
        provider: 'paystack',
        provider_reference: reference,
        package_id: pack.package_id,
        sparks: pack.sparks,
        amount_minor: pack.amount_minor,
        currency: pack.currency,
        status: 'pending',
      })
      .select('id,provider_reference,sparks,amount_minor,currency')
      .single();
    if (insertError) throw insertError;

    const amountMinor = Number(purchase.amount_minor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      await supabaseAdmin.from('live_spark_purchases').update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', purchase.id).eq('status', 'pending');
      return res.status(409).json({ error: 'This purchase amount cannot be processed safely' });
    }
    const payload = {
      email: req.user.email,
      amount: amountMinor,
      currency: purchase.currency,
      reference: purchase.provider_reference,
      metadata: { purchase_id: purchase.id, product: 'zannychat_live_sparks' },
    };
    if (process.env.LIVE_PURCHASE_CALLBACK_URL) payload.callback_url = process.env.LIVE_PURCHASE_CALLBACK_URL;

    let providerResponse;
    try {
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12000),
      });
      providerResponse = await response.json();
      if (!response.ok || providerResponse?.status !== true
          || providerResponse?.data?.reference !== purchase.provider_reference
          || typeof providerResponse?.data?.authorization_url !== 'string') {
        throw new Error('Paystack did not initialize the purchase');
      }
    } catch (providerError) {
      // Keep the order pending when the network outcome is uncertain. A delayed
      // signed provider event can still be independently verified and reconciled.
      console.error('[live-purchases] checkout initialization failed:', providerError?.message || providerError);
      return res.status(502).json({ error: 'Checkout could not be confirmed. Do not retry if your bank shows a debit; contact support with your purchase reference.' });
    }

    return res.status(201).json({
      purchaseId: purchase.id,
      reference: purchase.provider_reference,
      sparks: purchase.sparks,
      amountMinor: purchase.amount_minor,
      currency: purchase.currency,
      checkoutUrl: providerResponse.data.authorization_url,
      accessCode: providerResponse.data.access_code || null,
      status: 'pending',
    });
  } catch (error) {
    console.error('[live-purchases] purchase initialization failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not create a LIVE purchase' });
  }
});

module.exports = router;
