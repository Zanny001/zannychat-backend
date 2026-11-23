const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('one Paystack integration endpoint dispatches purchases, refunds/disputes and payouts before JSON parsing', () => {
  const index = read('src/index.js');
  const purchase = read('src/routes/paystackLiveWebhook.js');
  const risk = read('src/routes/paystackLiveRiskWebhook.js');
  const payout = read('src/routes/paystackCreatorPayoutWebhook.js');
  const dispatcher = index.indexOf("app.use('/webhooks/paystack',");
  const jsonParser = index.indexOf("app.use(express.json");
  assert.ok(dispatcher > 0 && dispatcher < jsonParser);
  assert.ok(index.indexOf('express.raw({ type: \'application/json\'') < index.indexOf('paystackLiveWebhookRouter', dispatcher));
  const chain = index.slice(dispatcher, jsonParser);
  assert.ok(chain.indexOf('paystackLiveWebhookRouter') < chain.indexOf('paystackLiveRiskWebhookRouter'));
  assert.ok(chain.indexOf('paystackLiveRiskWebhookRouter') < chain.indexOf('paystackCreatorPayoutWebhookRouter'));
  assert.match(purchase, /async \(req, res, next\)/);
  assert.match(purchase, /event\?\.event !== 'charge\.success'[\s\S]*?return next\(\)/);
  assert.match(risk, /async \(req, res, next\)/);
  assert.match(risk, /!isRefund && !isDispute\) return next\(\)/);
  assert.match(payout, /async \(req, res, next\)/);
  assert.match(payout, /transfer\.reversed'[\s\S]*?return next\(\)/);
});

test('unified Paystack endpoint passes a signed unrelated event through every raw-body handler', async () => {
  const crypto = require('node:crypto');
  const request = require('supertest');
  const secret = 'sk_test_dispatch_only';
  process.env.PAYSTACK_SECRET_KEY = secret;
  const { validPaystackWebhookSignature } = require('../src/utils/paystackWebhookSignature.cjs');
  const app = require('../src/index');
  const body = Buffer.from(JSON.stringify({ event: 'customeridentification.success', data: { id: 123 } }));
  const signature = crypto.createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(validPaystackWebhookSignature({ rawBody: body, headers: { 'x-paystack-signature': signature }, apiSecret: secret }), true);
  const response = await request(app)
    .post('/webhooks/paystack')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', signature)
    .set('Content-Length', String(body.length))
    .send(body.toString('utf8'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { received: true, ignored: true });
});
