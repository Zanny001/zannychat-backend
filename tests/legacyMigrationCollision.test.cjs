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

test('legacy migrations use explicit timestamped replacements without duplicate pending versions', () => {
  const files = fs.readdirSync(migrations).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort();
  const versions = files.map((n) => n.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(versions[0], '0001');
  for (const version of ['0059', '0065', '0067', '0069', '0075']) {
    assert.ok(versions.includes(version), `expected retained historical migration ${version}`);
  }
  const timestampedReplacements = [
    '20261110192943_profile_privacy_and_attachment_cleanup_0066.sql',
    '20261110192957_bind_attachment_cleanup_to_conversation_0068.sql',
    '20261110193010_presence_and_read_receipt_projection_0070.sql',
    '20261110193028_private_avatar_compatibility_stage_0071.sql',
    '20261110193050_attachment_cleanup_claim_conversation_binding_0072.sql',
    '20261110193055_private_profile_cover_compatibility_0073.sql',
  ];
  for (const filename of timestampedReplacements) {
    assert.ok(fs.existsSync(path.join(migrations, filename)), `missing recorded replacement ${filename}`);
  }
  for (const version of ['0066', '0068', '0070', '0071', '0072', '0073']) {
    assert.ok(!versions.includes(version), `legacy version ${version} must not be replayed`);
  }
});
