const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  verifyRefundResource,
  verifyDisputeResource,
} = require('../src/routes/paystackLiveRiskWebhook');

function response(data, ok = true) {
  return { ok, json: async () => ({ status: ok, data }) };
}

test('refund verification resolves the original transaction reference and provider status', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return response([{
      id: 991,
      reference: 'refund-ref-991',
      status: 'processed',
      amount: 250000,
      currency: 'NGN',
      transaction: { id: 1234, reference: 'zanny-purchase-ref' },
    }]);
  };
  const verified = await verifyRefundResource({ id: 991, reference: 'refund-ref-991' }, 'sk_test', fetchImpl);
  assert.equal(verified.eventType, 'refund.processed');
  assert.equal(verified.resourceId, 'refund:991');
  assert.equal(verified.providerReference, 'zanny-purchase-ref');
  assert.equal(verified.amountMinor, 250000);
  assert.equal(verified.currency, 'NGN');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /refund\?reference=refund-ref-991/);
});

test('refund verification fetches the original transaction when Paystack returns only its numeric ID', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes('/refund?')) return response([{
      id: 992, reference: 'refund-ref-992', status: 'failed',
      amount: 10000, currency: 'NGN', transaction: 1235,
    }]);
    return response({ id: 1235, reference: 'zanny-purchase-ref-2', currency: 'NGN' });
  };
  const verified = await verifyRefundResource({ reference: 'refund-ref-992' }, 'sk_test', fetchImpl);
  assert.equal(verified.eventType, 'refund.failed');
  assert.equal(verified.providerReference, 'zanny-purchase-ref-2');
  assert.equal(calls, 2);
});

test('dispute verification uses Paystack state and resolution rather than trusting webhook payload fields', async () => {
  const fetchImpl = async () => response({
    id: 456,
    status: 'resolved',
    resolution: 'declined',
    refund_amount: null,
    dueAt: '2026-11-24T18:00:00.000Z',
    currency: 'NGN',
    transaction: { reference: 'zanny-purchase-ref-3', currency: 'NGN' },
  });
  const verified = await verifyDisputeResource({ id: 456, event: 'charge.dispute.create' }, 'sk_test', fetchImpl);
  assert.equal(verified.eventType, 'charge.dispute.resolve');
  assert.equal(verified.resourceId, 'dispute:456');
  assert.equal(verified.providerReference, 'zanny-purchase-ref-3');
  assert.equal(verified.resolution, 'declined');
  assert.equal(verified.providerDueAt, '2026-11-24T18:00:00.000Z');
});

test('dispute verification rejects unknown provider states and unresolved resolution values', async () => {
  const unknown = async () => response({
    id: 457, status: 'archived', resolution: null,
    transaction: { reference: 'zanny-purchase-ref-4' },
  });
  await assert.rejects(verifyDisputeResource({ id: 457, event: 'charge.dispute.create' }, 'sk_test', unknown), /status is not actionable/);
  const badResolved = async () => response({
    id: 458, status: 'resolved', resolution: 'unknown',
    transaction: { reference: 'zanny-purchase-ref-5' },
  });
  await assert.rejects(verifyDisputeResource({ id: 458, event: 'charge.dispute.resolve' }, 'sk_test', badResolved), /unsupported resolution/);
});

test('risk webhook is signature-gated and delegates all state changes to the service-role RPC', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/paystackLiveRiskWebhook.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(route, /validPaystackWebhookSignature/);
  assert.match(route, /express\.raw/);
  assert.match(route, /verifyRefundResource/);
  assert.match(route, /verifyDisputeResource/);
  assert.match(route, /rpc\('record_live_purchase_risk_event'/);
  assert.match(index, /\/webhooks\/paystack\/live-risk/);
});

test('refund verification rejects a provider response that does not match the requested refund reference', async () => {
  const fetchImpl = async () => response([{
    id: 999, reference: 'different-ref', status: 'processed',
    amount: 1000, currency: 'NGN', transaction: { reference: 'other-purchase' },
  }]);
  await assert.rejects(
    verifyRefundResource({ reference: 'expected-ref' }, 'sk_test', fetchImpl),
    /record is missing or invalid/,
  );
});
