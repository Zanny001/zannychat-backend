const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261124030000_live_spark_catalogue_admin.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveSparkCatalogueAdmin.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('Sparks catalogue drafts are provider-specific, NGN-only and inactive by default', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_live_spark_package_draft/);
  assert.match(migration, /VALUES \(p_provider, p_package_id, p_sparks, p_amount_minor, 'NGN', false/);
  assert.match(migration, /p_sparks NOT BETWEEN 1 AND 10000000/);
  assert.match(migration, /p_amount_minor NOT BETWEEN 1 AND 9007199254740991/);
  assert.match(migration, /provider IN \('paystack', 'google_play', 'apple_iap'\)/);
});

test('package activation and deactivation are audited and service-role-only', () => {
  assert.match(migration, /live_spark_package_admin_audit/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON public\.live_spark_package_admin_audit/);
  assert.match(migration, /CASE WHEN p_is_active THEN 'activated' ELSE 'deactivated' END/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.set_live_spark_package_active[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.set_live_spark_package_active[\s\S]*TO service_role/);
});

test('catalogue admin API is allowlisted, rate-limited and requires explicit state-change confirmation', () => {
  assert.match(route, /LIVE_ECONOMY_ADMIN_USER_IDS/);
  assert.match(route, /makeLimiter/);
  assert.match(route, /ACTIVATE_SPARKS_PACKAGE/);
  assert.match(route, /DEACTIVATE_SPARKS_PACKAGE/);
  assert.match(route, /create_live_spark_package_draft/);
  assert.match(route, /set_live_spark_package_active/);
  assert.match(index, /app\.use\('\/live\/admin\/spark-catalogue'/);
});
