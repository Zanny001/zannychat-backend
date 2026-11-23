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
