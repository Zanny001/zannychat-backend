const test = require('node:test');
const assert = require('node:assert/strict');
const { getScheduledMessageBatchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } = require('../src/utils/scheduledMessageBatch');

test('scheduled-message worker defaults to a bounded batch size', () => {
  assert.equal(DEFAULT_BATCH_SIZE, 100);
  assert.equal(MAX_BATCH_SIZE, 500);
  assert.equal(getScheduledMessageBatchSize(undefined), 100);
  assert.equal(getScheduledMessageBatchSize(''), 100);
});

test('scheduled-message worker accepts safe integer batch overrides', () => {
  assert.equal(getScheduledMessageBatchSize('1'), 1);
  assert.equal(getScheduledMessageBatchSize('250'), 250);
  assert.equal(getScheduledMessageBatchSize(' 250 '), 250);
  assert.equal(getScheduledMessageBatchSize('500'), 500);
});

test('scheduled-message worker rejects invalid or excessive batch overrides', () => {
  for (const value of ['0', '-1', '501', '1.5', '1e2', '2e2', '0x64', '+100', '1_0', 'NaN', 'Infinity', 'not-a-number']) {
    assert.equal(getScheduledMessageBatchSize(value), 100, `expected safe default for ${value}`);
  }
});
