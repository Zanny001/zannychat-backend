const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReceiptPdf } = require('../src/services/livePurchaseReceiptService');

test('receipt generator creates a valid compact PDF with verified purchase details and no customer PII', () => {
  const pdf = createReceiptPdf({
    receiptNumber: 'ZC-LIVE-123456789ABC',
    reference: 'paystack-verified-reference',
    packageId: 'spark_bundle_500',
    sparks: 500,
    amountMinor: 250000,
    currency: 'NGN',
    paymentDate: '2026-11-23T12:00:00.000Z',
    paymentChannel: 'card',
  });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.ok(pdf.toString('ascii').includes('ZC-LIVE-123456789ABC'));
  assert.ok(pdf.toString('ascii').includes('paystack-verified-reference'));
  assert.ok(pdf.toString('ascii').includes('NGN 2500.00'));
  assert.ok(pdf.toString('ascii').includes('%%EOF'));
  assert.ok(!pdf.toString('ascii').includes('@example.com'));
});

test('purchase webhook creates a receipt only after successful server-side fulfilment and the download route is owner checked', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '../src/routes/paystackLiveWebhook.js'), 'utf8');
  const purchases = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');
  assert.match(webhook, /ensureLivePurchaseReceipt\(eventReference, verified\)/);
  assert.match(purchases, /router\.get\('\/:purchaseId\/receipt'/);
  assert.match(purchases, /eq\('user_id', req\.user\.id\)/);
  assert.match(purchases, /createSignedUrl\(receipt\.storage_path, 60\)/);
  assert.match(purchases, /receiptAvailable: Boolean\(receipt\)/);
});
