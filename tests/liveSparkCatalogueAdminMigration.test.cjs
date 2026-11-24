const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261124030000_live_spark_catalogue_admin.sql'),
  'utf8',
);
const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveSparkCatalogueAdmin.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('Sparks catalogue administration stores only NGN provider packages as inactive drafts', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_live_spark_package_draft/);
  assert.match(migration, /VALUES \(p_provider, p_package_id, p_sparks, p_amount_minor, 'NGN', false, p_sort_order, now\(\)\)/);
  assert.match(migration, /p_provider NOT IN \('paystack', 'google_play', 'apple_iap'\)/);
  assert.match(migration, /p_sparks NOT BETWEEN 1 AND 10000000/);
  assert.match(migration, /p_amount_minor NOT BETWEEN 1 AND 9007199254740991/);
  assert.match(migration, /FOREIGN KEY \(provider, package_id, currency\)/);
});

test('Sparks package state changes are atomic, explicit and append-only audited', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.set_live_spark_package_active/);
  assert.match(migration, /SET is_active = p_is_active, updated_at = now\(\)/);
  assert.match(migration, /CHECK \(action IN \('draft_created', 'activated', 'deactivated'\)\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON public\.live_spark_package_admin_audit/);
  assert.match(migration, /RAISE EXCEPTION 'LIVE Sparks package audit is append-only'/);
});

test('Sparks administration database writes are service-role-only', () => {
  assert.match(migration, /ALTER TABLE public\.live_spark_package_admin_audit ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.live_spark_package_admin_audit FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_live_spark_package_draft[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.set_live_spark_package_active[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_live_spark_package_draft[\s\S]*TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.set_live_spark_package_active[\s\S]*TO service_role/);
});

test('Sparks catalogue API requires a verified session and separate LIVE economy admin allowlist', () => {
  assert.match(route, /router\.use\(requireAuth,/);
  assert.match(route, /LIVE_ECONOMY_ADMIN_USER_IDS/);
  assert.match(route, /return res\.status\(403\)/);
  assert.match(route, /ACTIVATE_SPARKS_PACKAGE/);
  assert.match(route, /DEACTIVATE_SPARKS_PACKAGE/);
  assert.match(route, /p_admin_id: req\.user\.id/);
  assert.match(index, /require\('\.\/routes\/liveSparkCatalogueAdmin'\)/);
  assert.match(index, /app\.use\('\/live\/admin\/spark-catalogue'/);
});
