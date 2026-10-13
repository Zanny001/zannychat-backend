'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isUuid } = require('../src/utils/safetyValidation');

test('accepts valid UUIDs without changing their value', () => {
  assert.equal(isUuid('a1b2c3d4-e5f6-4789-8abc-1234567890ab'), true);
  assert.equal(isUuid('A1B2C3D4-E5F6-4789-8ABC-1234567890AB'), true);
});

test('rejects missing, non-string, malformed and non-RFC variant identifiers', () => {
  for (const value of [undefined, null, 123, {}, '', 'not-a-uuid',
    'a1b2c3d4-e5f6-4789-7abc-1234567890ab',
    'a1b2c3d4-e5f6-0789-8abc-1234567890ab',
    'a1b2c3d4-e5f6-4789-8abc-1234567890ab-extra']) {
    assert.equal(isUuid(value), false, `expected invalid UUID: ${String(value)}`);
  }
});
