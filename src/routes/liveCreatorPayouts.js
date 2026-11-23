const express = require('express');
const crypto = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 12, error: 'Creator payout requests are rate-limited.' }));

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function payoutConfigured() {
  return Boolean(process.env.PAYSTACK_SECRET_KEY) && process.env.LIVE_PAYOUTS_ENABLED === 'true';
}

async function paystackRequest(path, options = {}) {
  const response = await fetch('https://api.paystack.co' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status !== true) {
    const error = new Error('Paystack payout provider request failed');
    error.providerRejected = response.status >= 400 && response.status < 500;
    throw error;
  }
  return payload.data;
}

router.get('/eligibility', async (req, res) => {
  try {
    const [{ data: profile, error: profileError }, { data: rule, error: ruleError }] = await Promise.all([
      supabaseAdmin.from('live_creator_payout_profiles')
        .select('verification_status,payout_hold,verified_at').eq('creator_id', req.user.id).maybeSingle(),
      supabaseAdmin.from('live_creator_reward_rules')
        .select('minimum_withdrawal_minor').eq('is_active', true).maybeSingle(),
    ]);
    if (profileError) throw profileError;
    if (ruleError) throw ruleError;
    const verified = profile?.verification_status === 'verified' && profile?.payout_hold !== true;
    return res.json({
      enabled: payoutConfigured() && verified && Boolean(rule),
      verificationStatus: profile?.verification_status || 'unverified',
      payoutHold: profile?.payout_hold === true,
      minimumWithdrawalMinor: rule?.minimum_withdrawal_minor || null,
      currency: 'NGN',
      reason: !payoutConfigured() ? 'PAYOUTS_NOT_CONFIGURED'
        : !verified ? 'PAYOUT_KYC_REQUIRED'
          : !rule ? 'CREATOR_REWARD_POLICY_NOT_CONFIGURED' : null,
    });
  } catch (error) {
    console.error('[live-payouts] eligibility lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Payout eligibility is temporarily unavailable' });
  }
});

router.get('/banks', async (_req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Bank verification is not configured' });
  try {
    const data = await paystackRequest('/bank?country=nigeria&perPage=200', { method: 'GET' });
    return res.json({ banks: (data || []).map((bank) => ({ name: bank.name, code: bank.code, slug: bank.slug })) });
  } catch (error) {
    console.error('[live-payouts] bank list lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Nigerian bank list is temporarily unavailable' });
  }
});

router.get('/beneficiaries', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_payout_beneficiaries')
      .select('id,bank_code,bank_name,account_name,account_last4,currency,status,verified_at,created_at')
      .eq('creator_id', req.user.id).order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    return res.json({ beneficiaries: data || [] });
  } catch (error) {
    console.error('[live-payouts] beneficiary lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Saved bank accounts are temporarily unavailable' });
  }
});

router.post('/beneficiaries', async (req, res) => {
  if (!payoutConfigured()) return res.status(503).json({ error: 'Payout setup is not enabled yet' });
  const { bankCode, accountNumber } = req.body || {};
  if (typeof bankCode !== 'string' || !/^[a-zA-Z0-9_-]{2,20}$/.test(bankCode)
      || typeof accountNumber !== 'string' || !/^\d{10}$/.test(accountNumber)) {
    return res.status(400).json({ error: 'Enter a valid bank and 10-digit account number' });
  }

  try {
    const resolved = await paystackRequest('/bank/resolve?account_number='
      + encodeURIComponent(accountNumber) + '&bank_code=' + encodeURIComponent(bankCode), { method: 'GET' });
    if (!resolved?.account_name) return res.status(422).json({ error: 'The bank account could not be verified' });

    const bankResponse = await paystackRequest('/bank?country=nigeria&perPage=200', { method: 'GET' });
    const bank = (bankResponse || []).find((item) => String(item.code) === bankCode);
    if (!bank) return res.status(400).json({ error: 'Select a supported Nigerian bank' });

    const recipient = await paystackRequest('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({
        type: 'nuban',
        name: resolved.account_name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      }),
    });
    if (!recipient?.recipient_code) throw new Error('Payout provider did not return a beneficiary reference');

    const { data, error } = await supabaseAdmin.from('live_payout_beneficiaries')
      .insert({
        creator_id: req.user.id,
        provider: 'paystack',
        provider_recipient_code: recipient.recipient_code,
        bank_code: bankCode,
        bank_name: bank.name,
        account_name: resolved.account_name,
        account_last4: accountNumber.slice(-4),
        currency: 'NGN',
        status: 'verified',
        verified_at: new Date().toISOString(),
      })
      .select('id,bank_code,bank_name,account_name,account_last4,currency,status,verified_at')
      .single();
    if (error) throw error;
    return res.status(201).json({ beneficiary: data });
  } catch (error) {
    console.error('[live-payouts] beneficiary creation failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not verify and save this bank account' });
  }
});

router.delete('/beneficiaries/:beneficiaryId', async (req, res) => {
  if (!validUuid(req.params.beneficiaryId)) return res.status(400).json({ error: 'Invalid bank account id' });
  try {
    const { data, error } = await supabaseAdmin.from('live_payout_beneficiaries')
      .update({ status: 'disabled', updated_at: new Date().toISOString() })
      .eq('id', req.params.beneficiaryId).eq('creator_id', req.user.id)
      .select('id,status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Bank account not found' });
    return res.json({ beneficiary: data });
  } catch (error) {
    console.error('[live-payouts] beneficiary disable failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not disable this bank account' });
  }
});

router.post('/request', async (req, res) => {
  if (!payoutConfigured()) return res.status(503).json({ error: 'Creator withdrawals are not enabled yet' });
  const { beneficiaryId, amountMinor } = req.body || {};
  if (!validUuid(beneficiaryId) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return res.status(400).json({ error: 'Enter a valid withdrawal amount and verified bank account' });
  }

  try {
    const reference = 'ZC_PAYOUT_' + crypto.randomUUID().replace(/-/g, '');
    const { data: payout, error } = await supabaseAdmin.rpc('request_live_creator_payout', {
      p_creator_id: req.user.id,
      p_beneficiary_id: beneficiaryId,
      p_amount_minor: amountMinor,
      p_provider_reference: reference,
    });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: error.message || 'Payout verification is required' });
      if (error.code === '22023') return res.status(400).json({ error: error.message || 'Invalid withdrawal request' });
      if (error.code === 'P0001') return res.status(409).json({ error: error.message || 'Not enough available creator earnings' });
      throw error;
    }

    try {
      const beneficiary = await supabaseAdmin.from('live_payout_beneficiaries')
        .select('provider_recipient_code').eq('id', beneficiaryId).eq('creator_id', req.user.id).single();
      if (beneficiary.error) throw beneficiary.error;
      const transfer = await paystackRequest('/transfer', {
        method: 'POST',
        body: JSON.stringify({
          source: 'balance',
          amount: amountMinor,
          recipient: beneficiary.data.provider_recipient_code,
          reason: 'ZannyChat LIVE creator earnings',
          reference,
        }),
      });
      const { error: updateError } = await supabaseAdmin.from('live_creator_payouts')
        .update({ status: 'processing', provider_transfer_code: transfer.transfer_code, updated_at: new Date().toISOString() })
        .eq('id', payout.id).eq('status', 'requested');
      if (updateError) throw updateError;
      return res.status(202).json({ payout: { id: payout.id, amountMinor, currency: 'NGN', status: 'processing', reference } });
    } catch (providerError) {
      if (providerError?.providerRejected) {
        await supabaseAdmin.from('live_creator_payouts')
          .update({ status: 'failed', failure_message: 'Payment provider rejected the transfer', updated_at: new Date().toISOString() })
          .eq('id', payout.id).eq('status', 'requested');
        return res.status(502).json({ error: 'The payment provider rejected the withdrawal. Reserved earnings have been released.' });
      }
      // Do not release the reservation after an uncertain network outcome. Reconcile by
      // provider reference before allowing another withdrawal.
      console.error('[live-payouts] transfer submission outcome is uncertain:', providerError?.message || providerError);
      return res.status(202).json({ payout: { id: payout.id, amountMinor, currency: 'NGN', status: 'requested', reference, reconciliationPending: true } });
    }
  } catch (error) {
    console.error('[live-payouts] payout request failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not create this withdrawal request' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_payouts')
      .select('id,beneficiary_id,amount_minor,currency,status,provider_reference,failure_code,failure_message,requested_at,completed_at,updated_at')
      .eq('creator_id', req.user.id).order('requested_at', { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ payouts: data || [] });
  } catch (error) {
    console.error('[live-payouts] payout history lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Withdrawal history is temporarily unavailable' });
  }
});

module.exports = router;
