const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcilePendingCreatorPayouts,
  mapPaystackTransferStatus,
  transferMatchesPayout,
  DEFAULT_RECONCILIATION_AGE_MS,
  MAX_RECONCILIATION_BATCH,
} = require('../src/services/livePayoutReconciliation');

function fakeSupabase(payouts, recipientCode = 'RCP_test') {
  const state = { cutoff: null, statuses: null, limit: null, updates: [], beneficiaryLookups: [] };
  const supabase = {
    from(table) {
      if (table === 'live_payout_beneficiaries') {
        const lookup = {};
        const query = {
          select(columns) { lookup.columns = columns; return query; },
          eq(column, value) { lookup[column] = value; return query; },
          maybeSingle: async () => {
            state.beneficiaryLookups.push(lookup);
            return {
              data: recipientCode ? { provider_recipient_code: recipientCode } : null,
              error: null,
            };
          },
        };
        return query;
      }
      assert.equal(table, 'live_creator_payouts');
      const query = {
        select(columns) { state.columns = columns; return query; },
        in(column, values) { state.statuses = { column, values }; return query; },
        lt(column, value) { state.cutoff = { column, value }; return query; },
        order(column, options) { state.order = { column, options }; return query; },
        limit(value) { state.limit = value; return Promise.resolve({ data: payouts, error: null }); },
        update(values) {
          const update = { values };
          const updateQuery = {
            eq(column, value) { update.reference = { column, value }; return updateQuery; },
            in(column, values) { update.allowedStatuses = { column, values }; return updateQuery; },
            select(columns) { update.columns = columns; return updateQuery; },
            maybeSingle: async () => {
              state.updates.push(update);
              return { data: { id: 'payout-1', status: values.status }, error: null };
            },
          };
          return updateQuery;
        },
      };
      return query;
    },
  };
  return { supabase, state };
}

function paystackResponse(data) {
  return { ok: true, json: async () => ({ status: true, data }) };
}

function makePayout(overrides = {}) {
  return {
    id: 'payout-1',
    creator_id: 'creator-1',
    beneficiary_id: 'beneficiary-1',
    provider_reference: 'zanny-payout-123',
    amount_minor: 250000,
    currency: 'NGN',
    status: 'requested',
    requested_at: '2026-11-23T10:00:00.000Z',
    ...overrides,
  };
}

function makeTransfer(overrides = {}) {
  return {
    reference: 'zanny-payout-123',
    amount: 250000,
    currency: 'NGN',
    status: 'success',
    transfer_code: 'TRF_test',
    recipient: { recipient_code: 'RCP_test' },
    ...overrides,
  };
}

test('Paystack transfer statuses map only to the supported payout states', () => {
  assert.equal(mapPaystackTransferStatus('success'), 'paid');
  assert.equal(mapPaystackTransferStatus('failed'), 'failed');
  assert.equal(mapPaystackTransferStatus('reversed'), 'reversed');
  assert.equal(mapPaystackTransferStatus('pending'), 'processing');
  assert.equal(mapPaystackTransferStatus('otp'), 'processing');
  assert.equal(mapPaystackTransferStatus('unknown'), null);
});

test('reconciles a pending payout only after Paystack verifies reference, amount, NGN and reserved beneficiary', async () => {
  const { supabase, state } = fakeSupabase([makePayout()]);
  const summary = await reconcilePendingCreatorPayouts({
    supabase,
    secret: 'test-secret',
    now: new Date('2026-11-23T10:10:00.000Z'),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.paystack.co/transfer/verify/zanny-payout-123');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.signal instanceof AbortSignal, true);
      return paystackResponse(makeTransfer());
    },
    logger: { info() {}, warn() {} },
  });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.reconciled, 1);
  assert.equal(summary.errors, 0);
  assert.equal(state.cutoff.column, 'requested_at');
  assert.equal(state.cutoff.value, new Date(Date.parse('2026-11-23T10:10:00.000Z') - DEFAULT_RECONCILIATION_AGE_MS).toISOString());
  assert.equal(state.statuses.column, 'status');
  assert.deepEqual(state.statuses.values, ['requested', 'processing']);
  assert.equal(state.limit, MAX_RECONCILIATION_BATCH);
  assert.deepEqual(state.beneficiaryLookups[0], {
    columns: 'provider_recipient_code',
    id: 'beneficiary-1',
    creator_id: 'creator-1',
  });
  assert.equal(state.updates[0].values.status, 'paid');
  assert.equal(state.updates[0].values.completed_at, '2026-11-23T10:10:00.000Z');
  assert.deepEqual(state.updates[0].allowedStatuses.values, ['requested', 'processing']);
});

test('does not mutate a payout if verified Paystack transfer recipient differs from the reserved beneficiary', async () => {
  const { supabase, state } = fakeSupabase([makePayout()], 'RCP_reserved');
  const summary = await reconcilePendingCreatorPayouts({
    supabase,
    secret: 'test-secret',
    fetchImpl: async () => paystackResponse(makeTransfer({ recipient: { recipient_code: 'RCP_other' } })),
    logger: { info() {}, warn() {} },
  });
  assert.equal(summary.errors, 1);
  assert.equal(state.updates.length, 0);
});

test('does not mutate a payout when Paystack returns an unknown non-final state', async () => {
  const { supabase, state } = fakeSupabase([makePayout()]);
  const summary = await reconcilePendingCreatorPayouts({
    supabase,
    secret: 'test-secret',
    fetchImpl: async () => paystackResponse(makeTransfer({ status: 'queued' })),
    logger: { info() {}, warn() {} },
  });
  assert.equal(summary.pending, 1);
  assert.equal(state.updates.length, 0);
});

test('does not mutate a payout when verified amount or currency differs', async () => {
  const { supabase, state } = fakeSupabase([makePayout()]);
  const summary = await reconcilePendingCreatorPayouts({
    supabase,
    secret: 'test-secret',
    fetchImpl: async () => paystackResponse(makeTransfer({ amount: 249999 })),
    logger: { info() {}, warn() {} },
  });
  assert.equal(summary.errors, 1);
  assert.equal(state.updates.length, 0);
});

test('reconciliation stays disabled without Paystack credentials', async () => {
  const { supabase } = fakeSupabase([]);
  const summary = await reconcilePendingCreatorPayouts({ supabase, secret: '' });
  assert.deepEqual(summary, { skipped: true, reason: 'paystack_not_configured' });
});

test('verified transfer matching requires exact reserved reference, integer amount, currency and recipient code', () => {
  const payout = {
    provider_reference: 'zanny-payout-123',
    amount_minor: 250000,
    currency: 'NGN',
    provider_recipient_code: 'RCP_test',
  };
  assert.equal(transferMatchesPayout(makeTransfer(), payout), true);
  assert.equal(transferMatchesPayout(makeTransfer({ reference: 'another-reference' }), payout), false);
  assert.equal(transferMatchesPayout(makeTransfer({ amount: 249999 }), payout), false);
  assert.equal(transferMatchesPayout(makeTransfer({ currency: 'USD' }), payout), false);
  assert.equal(transferMatchesPayout(makeTransfer({ amount: 250000.5 }), payout), false);
  assert.equal(transferMatchesPayout(makeTransfer({ recipient: { recipient_code: 'RCP_other' } }), payout), false);
  assert.equal(transferMatchesPayout(makeTransfer({ recipient: null }), payout), false);
  assert.equal(transferMatchesPayout(makeTransfer(), { ...payout, provider_recipient_code: null }), false);
});
