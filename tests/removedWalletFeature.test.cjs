const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('removed wallet preview has no active API mount or route implementation', () => {
  const index = read('src/index.js');
  assert.doesNotMatch(index, /require\(['"]\.\/routes\/wallet['"]\)/);
  assert.doesNotMatch(index, /app\.use\(['"]\/wallet['"]/);
  assert.equal(fs.existsSync(path.join(root, 'src/routes/wallet.js')), false);
});

test('removed wallet schema is not referenced by active Stripe webhook implementation', () => {
  const webhookPath = path.join(root, 'src/routes/webhooks.js');
  if (!fs.existsSync(webhookPath)) return;
  const source = fs.readFileSync(webhookPath, 'utf8');
  assert.doesNotMatch(source, /ledger_entries|wallet_id|stripe_topup/);
});
