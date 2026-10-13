const test = require('node:test');
const assert = require('node:assert/strict');
const { safeHealthDiagnostic } = require('../src/utils/healthDiagnostics');

test('healthy configured database returns no diagnostic', () => {
  assert.equal(safeHealthDiagnostic(null, true, true), null);
});

test('unconfigured backend returns a stable public diagnostic', () => {
  assert.equal(safeHealthDiagnostic(null, false, false), 'Backend is not configured');
});

test('database provider errors are replaced with a generic diagnostic', () => {
  const secret = new Error('postgres://internal-host/private_schema: permission denied');
  assert.equal(safeHealthDiagnostic(secret, false, true), 'Database connectivity check failed');
  assert.equal(safeHealthDiagnostic(secret, false, true).includes('internal-host'), false);
});
