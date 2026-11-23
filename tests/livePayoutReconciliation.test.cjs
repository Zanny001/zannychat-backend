const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcilePendingCreatorPayouts,
  mapPaystackTransferStatus,
  DEFAULT_RECONCILIATION_AGE_MS,
  MAX_RECONCILIATION_BATCH,
} = require('../src/services/livePayoutReconciliation');

function fakeSupabase(payouts) {
  const state = { cutoff: null, statuses: null, limit: null, updates: [] };
  const supabase = {
    from(table) {
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

test('Paystack transfer statuses map only to the supported payout states', () => {
  assert.equal(mapPaystackTransferStatus('success'), 'paid');
  assert.equal(mapPaystackTransferStatus('failed'), 'failed');
  assert.equal(mapPaystackTransferStatus('reversed'), 'reversed');
  assert.equal(mapPaystackTransferStatus('pending'), 'processing');
  assert.equal(mapPaystackTransferStatus('otp'), 'processing');
  assert.equal(mapPaystackTransferStatus('unknown'), null);
});

test('reconciles an old pending payout only after Paystack verifies reference, amount and NGN currency', async () => {
  const payout = {
    id: 'payout-1',
    provider_reference: 'zanny-payout-123',
    amount_minor: 250000,
    currency: 'NGN',
    status: 'requested',
    requested_at: '2026-11-23T10:00:00.000Z',
  };
  const { supabase, state } = fakeSupabase([payout]);
  const summary = await reconcilePendingCreatorPayouts({
    supabase,
    secret: 'test-secret',
    now: new Date('2026-11-23T10:10:00.000Z'),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.paystack.co/transfer/verify/zanny-payout-123');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.signal instanceof AbortSignal, true);
      return paystackResponse({
        reference: 'zanny-payout-123',
        amount: 250000,
        currency: 'NGN',
        status: 'success',
        transfer_code: 'TRF_test',
      });
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
  assert.equal(state.updates[0].values.status, 'paid');
  assert.equal(state.updates[0].values.completed_at, '2026-11-23T10:10:00.000Z');
  assert.deepEqual(state.updates[0].allowedStatuses.values, ['requested', 'processing']);
});

test('does not mutate a payout when Paystack returns an unknown non-final state', async () => {
  const payout = { provider_reference: 'zanny-payout-123', amount_minor: 250000, currency: 'NGN' };
  const { supabase, state } = fakeSupabase([payout]);
  const summary = await reconcilePendingCreatorPayouts({
    supabase,
    secret: 'test-secret',
    fetchImpl: async () => paystackResponse({
      reference: 'zanny-payout-123', amount: 250000, currency: 'NGN', status: 'queued',
    }),
    logger: { info() {}, warn() {} },
  });
  assert.equal(summary.pending, 1);
  assert.equal(state.updates.length, 0);
});

test('does not mutate a payout when verified amount or currency differs', async () => {
  const payout = { provider_reference: 'zanny-payout-123', amount_minor: 250000, currency: 'NGN' };
  const { supabase, state } = fakeSupabase([payout]);
  const summary = await reconcilePendingCreatorPayouts({
    supabase,
    secret: 'test-secret',
    fetchImpl: async () => paystackResponse({
      reference: 'zanny-payout-123', amount: 249999, currency: 'NGN', status: 'success',
    }),
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
