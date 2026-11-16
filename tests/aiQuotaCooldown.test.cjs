const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_QUOTA_COOLDOWN_MS,
  markAiQuotaUnavailable,
  isAiQuotaCooldownActive,
  clearAiQuotaCooldown,
} = require('../src/utils/aiQuotaCooldown.cjs');

test('quota exhaustion opens a bounded cooldown and repeated failures cannot shorten it', () => {
  clearAiQuotaCooldown();
  assert.equal(isAiQuotaCooldownActive(1000), false);
  assert.equal(markAiQuotaUnavailable(1000), 1000 + DEFAULT_QUOTA_COOLDOWN_MS);
  assert.equal(isAiQuotaCooldownActive(1001), true);
  assert.equal(markAiQuotaUnavailable(2000, 1000), 1000 + DEFAULT_QUOTA_COOLDOWN_MS);
  assert.equal(isAiQuotaCooldownActive(1000 + DEFAULT_QUOTA_COOLDOWN_MS - 1), true);
  assert.equal(isAiQuotaCooldownActive(1000 + DEFAULT_QUOTA_COOLDOWN_MS), false);
  clearAiQuotaCooldown();
});

test('cooldown duration is bounded to one hour and invalid duration uses the default', () => {
  clearAiQuotaCooldown();
  assert.equal(markAiQuotaUnavailable(500, Infinity), 500 + DEFAULT_QUOTA_COOLDOWN_MS);
  clearAiQuotaCooldown();
  assert.equal(markAiQuotaUnavailable(500, 99 * 60 * 60 * 1000), 500 + 60 * 60 * 1000);
  clearAiQuotaCooldown();
});
