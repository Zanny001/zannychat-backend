const test = require('node:test');
const assert = require('node:assert/strict');
const { isAiQuotaUnavailable, respondToAiFailure } = require('../src/utils/aiProviderFailure.cjs');

test('recognizes exhausted Anthropic credits without matching unrelated failures', () => {
  assert.equal(isAiQuotaUnavailable(new Error('Anthropic API error (400): Your credit balance is too low to access the Anthropic API.')), true);
  assert.equal(isAiQuotaUnavailable(new Error('insufficient_quota')), true);
  assert.equal(isAiQuotaUnavailable(new Error('network timeout')), false);
  assert.equal(isAiQuotaUnavailable(null), false);
});

test('quota exhaustion returns a safe retryable service-unavailable response', () => {
  let statusCode;
  let body;
  const response = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  respondToAiFailure(response, new Error('credit balance is too low'));
  assert.equal(statusCode, 503);
  assert.equal(body.code, 'AI_TEMPORARILY_UNAVAILABLE');
  assert.match(body.error, /temporarily unavailable/i);
  assert.doesNotMatch(JSON.stringify(body), /Anthropic|billing|credit balance/i);
});

test('unclassified provider failures retain a generic 500 response', () => {
  let statusCode;
  let body;
  const response = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  respondToAiFailure(response, new Error('private provider payload'));
  assert.equal(statusCode, 500);
  assert.deepEqual(body, { error: 'Unable to complete AI request' });
});
