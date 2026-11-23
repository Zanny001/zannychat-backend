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

test('refund verification uses Paystack transaction_reference and resolves the refund through the transaction ID', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/transaction/verify/')) {
      return response({ id: 1234, reference: 'zanny-purchase-ref', amount: 500000, currency: 'NGN' });
    }
    return response([{
      id: 991,
      transaction: 1234,
      status: 'processed',
      amount: 250000,
      currency: 'NGN',
    }]);
  };
  const verified = await verifyRefundResource({
    transaction_reference: 'zanny-purchase-ref',
    refund_reference: null,
    amount: '250000',
    currency: 'NGN',
    status: 'processed',
  }, 'sk_test', fetchImpl);
  assert.equal(verified.eventType, 'refund.processed');
  assert.equal(verified.resourceId, 'refund:991');
  assert.equal(verified.providerReference, 'zanny-purchase-ref');
  assert.equal(verified.amountMinor, 250000);
  assert.equal(verified.currency, 'NGN');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /transaction\/verify\/zanny-purchase-ref/);
  assert.match(calls[1], /refund\?transaction=1234/);
});

test('refund verification fetches a refund directly when refund_reference is supplied', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes('/transaction/verify/')) {
      return response({ id: 1235, reference: 'zanny-purchase-ref-2', amount: 500000, currency: 'NGN' });
    }
    return response({
      id: 992,
      transaction: 1235,
      status: 'failed',
      amount: 10000,
      currency: 'NGN',
    });
  };
  const verified = await verifyRefundResource({
    transaction_reference: 'zanny-purchase-ref-2',
    refund_reference: '992',
    amount: '10000',
    currency: 'NGN',
    status: 'failed',
  }, 'sk_test', fetchImpl);
  assert.equal(verified.eventType, 'refund.failed');
  assert.equal(verified.resourceId, 'refund:992');
  assert.equal(verified.providerReference, 'zanny-purchase-ref-2');
  assert.equal(calls, 2);
});

test('refund verification rejects ambiguous matches instead of applying a refund to the wrong transaction', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/transaction/verify/')) {
      return response({ id: 1236, reference: 'zanny-purchase-ref-3', amount: 500000, currency: 'NGN' });
    }
    return response([
      { id: 993, transaction: 1236, status: 'processed', amount: 10000, currency: 'NGN' },
      { id: 994, transaction: 1236, status: 'processed', amount: 10000, currency: 'NGN' },
    ]);
  };
  await assert.rejects(verifyRefundResource({
    transaction_reference: 'zanny-purchase-ref-3',
    refund_reference: null,
    amount: '10000',
    currency: 'NGN',
    status: 'processed',
  }, 'sk_test', fetchImpl), /missing or ambiguous/);
});

test('dispute verification uses Paystack state and resolution rather than trusting webhook payload fields', async () => {
  const fetchImpl = async () => response({
    id: 456,
    status: 'resolved',
    resolution: 'declined',
    refund_amount: null,
    dueAt: '2026-11-24T18:00:00.000Z',
    currency: 'NGN',
    transaction: { reference: 'zanny-purchase-ref-4', currency: 'NGN' },
  });
  const verified = await verifyDisputeResource({ id: 456, event: 'charge.dispute.create' }, 'sk_test', fetchImpl);
  assert.equal(verified.eventType, 'charge.dispute.resolve');
  assert.equal(verified.resourceId, 'dispute:456');
  assert.equal(verified.providerReference, 'zanny-purchase-ref-4');
  assert.equal(verified.resolution, 'declined');
  assert.equal(verified.providerDueAt, '2026-11-24T18:00:00.000Z');
});

test('dispute verification rejects unknown provider states and unresolved resolution values', async () => {
  const unknown = async () => response({
    id: 457, status: 'archived', resolution: null,
    transaction: { reference: 'zanny-purchase-ref-5' },
  });
  await assert.rejects(verifyDisputeResource({ id: 457, event: 'charge.dispute.create' }, 'sk_test', unknown), /status is not actionable/);
  const badResolved = async () => response({
    id: 458, status: 'resolved', resolution: 'unknown',
    transaction: { reference: 'zanny-purchase-ref-6' },
  });
  await assert.rejects(verifyDisputeResource({ id: 458, event: 'charge.dispute.resolve' }, 'sk_test', badResolved), /unsupported resolution/);
});

test('risk webhook is signature-gated and delegates all state changes to the service-role RPC', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/paystackLiveRiskWebhook.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(route, /validPaystackWebhookSignature/);
  assert.match(route, /express\.raw/);
  assert.match(route, /transaction_reference/);
  assert.match(route, /refund_reference/);
  assert.match(route, /verifyRefundResource/);
  assert.match(route, /verifyDisputeResource/);
  assert.match(route, /rpc\('record_live_purchase_risk_event'/);
  assert.match(index, /\/webhooks\/paystack\/live-risk/);
});
