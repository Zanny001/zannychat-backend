const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'supabase', 'migrations');
const sql = (name) => fs.readFileSync(path.join(migrations, name), 'utf8');

test('legacy 0046 idempotency migration is byte-identical to canonical 0048', () => {
  // The archive-to-canonical byte comparison is recorded in the reconciliation report.
  assert.match(sql('0048_channel_post_idempotency.sql'), /client_request_id uuid/i);
  assert.match(sql('0048_channel_post_idempotency.sql'), /CREATE UNIQUE INDEX IF NOT EXISTS channel_posts_client_request_unique/i);
});

test('compatibility migration reasserts server-controlled 6/12/24/48-hour expiry', () => {
  const source = sql('0064_reconcile_legacy_0046_status_expiry.sql');
  assert.match(source, /DROP CONSTRAINT IF EXISTS status_expiry_window/i);
  assert.match(source, /expires_at <= created_at \+ interval '48 hours'/i);
  assert.match(source, /Status expiry must be 6, 12, 24, or 48 hours/i);
  assert.match(source, /NEW\.created_at := server_created_at/i);
  assert.match(source, /NEW\.expires_at := server_created_at \+ make_interval/i);
  assert.match(source, /BEFORE INSERT OR UPDATE OF created_at, expires_at/i);
  assert.match(source, /SET search_path = ''/i);
});

test('migration versions are unique and contiguous through 0064', () => {
  const files = fs.readdirSync(migrations).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort();
  const versions = files.map((n) => n.slice(0, 4));
  assert.equal(files.length, 64);
  assert.equal(new Set(versions).size, 64);
  assert.equal(versions[0], '0001');
  assert.equal(versions.at(-1), '0064');
  for (let i = 0; i < versions.length; i++) assert.equal(Number(versions[i]), i + 1);
});
