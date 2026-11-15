const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeE164, phoneHash, hashContactBatch, filterPhoneDiscoveryMatches } = require('../src/utils/phoneDiscovery');
const root = path.join(__dirname, '..');

test('E.164 normalization accepts international numbers and rejects ambiguous local values', () => {
  assert.equal(normalizeE164('+2348012345678'), '+2348012345678');
  assert.equal(normalizeE164('  +14155552671  '), '+14155552671');
  assert.equal(normalizeE164('08012345678'), null);
  assert.equal(normalizeE164('+012345678'), null);
  assert.equal(normalizeE164('+123'), null);
  assert.equal(normalizeE164(2348012345678), null);
});

test('phone lookup uses keyed HMAC, is deterministic, and is secret-dependent', () => {
  const secretA = 'a'.repeat(32); const secretB = 'b'.repeat(32);
  const first = phoneHash('+2348012345678', secretA);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, phoneHash('+2348012345678', secretA));
  assert.notEqual(first, phoneHash('+2348012345678', secretB));
  assert.throws(() => phoneHash('+2348012345678', 'short'), /at least 32 bytes/);
  assert.throws(() => phoneHash('08012345678', secretA), /E.164/);
});

test('contact batch deduplicates valid numbers and enforces maximum before hashing', () => {
  const hashes = hashContactBatch(['+2348012345678', '+2348012345678', '08012345678'], 'a'.repeat(32));
  assert.equal(hashes.length, 1);
  assert.throws(() => hashContactBatch(Array.from({ length: 101 }, () => '+2348012345678'), 'a'.repeat(32)), /no more than 100/);
  assert.throws(() => hashContactBatch('not-an-array', 'a'.repeat(32)), /no more than 100/);
});

test('private phone discovery migration stores only a keyed hash and denies client table access', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0057_private_phone_discovery.sql'), 'utf8');
  assert.match(sql, /phone_hash text not null unique/);
  assert.match(sql, /phone_hash text not null unique/);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.phone_discovery from anon, authenticated/i);
  assert.doesNotMatch(sql, /phone_number\s+text/i);
});

test('follow-up migration makes discovery opt-in by default and clears stale verified-phone enrollments', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0058_phone_discovery_opt_in_hardening.sql'), 'utf8');
  assert.match(sql, /alter column discoverable set default false/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(sql, /new\.phone is distinct from old\.phone/i);
  assert.match(sql, /new\.phone_confirmed_at is null/i);
  assert.match(sql, /delete from public\.phone_discovery where user_id = new\.id/i);
  assert.match(sql, /after update of phone, phone_confirmed_at on auth\.users/i);
  assert.match(sql, /revoke all on function .* from public, anon, authenticated/i);
  assert.match(sql, /phone_discovery_match_limits/i);
  assert.match(sql, /consume_phone_discovery_match_limit/i);
  assert.match(sql, /grant execute on function public\.consume_phone_discovery_match_limit\(uuid\) to service_role/i);
  assert.match(sql, /request_count <= 3/i);
});

test('discovery routes require verified auth enrollment, opt-in, bounded matching and rate limiting', () => {
  const route = fs.readFileSync(path.join(root, 'src/routes/discovery.js'), 'utf8');
  assert.match(route, /router\.use\(requireAuth, discoveryLimiter\)/);
  assert.match(route, /max: 3, error: 'Contact matching is rate-limited/);
  assert.match(route, /Verify a phone number on your account before matching contacts/);
  assert.match(route, /consume_phone_discovery_match_limit/);
  assert.match(route, /withinQuota !== true/);
  assert.match(route, /Cache-Control', 'no-store/);
  assert.match(route, /user\.phone_confirmed_at/);
  assert.match(route, /PHONE_DISCOVERY_HMAC_SECRET/);
  assert.match(route, /phones\.length > 100/);
  assert.match(route, /Cache-Control', 'no-store/);
  assert.match(route, /select\('discoverable,phone_hash'\)/);
  assert.match(route, /currentHash !== data\.phone_hash/);
  assert.match(route, /stale enrollment cleanup failed/);
  assert.doesNotMatch(route, /console\.(log|info|debug)\([^\n]*phones/);
  const validationIndex = route.indexOf("const phones = req.body?.phones");
  const hashingIndex = route.indexOf("hashes = hashContactBatch(phones");
  const emptyBatchIndex = route.indexOf("if (!hashes.length) return res.json({ matches: [] })");
  const quotaIndex = route.indexOf("consume_phone_discovery_match_limit");
  assert.ok(validationIndex >= 0 && hashingIndex > validationIndex && emptyBatchIndex > hashingIndex && quotaIndex > emptyBatchIndex,
    'validate and hash a non-empty batch before consuming the persistent quota');
});

test('phone discovery matches respect profile visibility, photo visibility and bidirectional blocks independently', () => {
  const profiles = [
    { id: 'everyone', name: 'Everyone', avatar_url: 'public-everyone', avatar_color: '#111', status: 'hello' },
    { id: 'private-profile', name: 'Private', avatar_url: 'private-profile-url' },
    { id: 'contacts-profile', name: 'Contacts', avatar_url: 'contacts-profile-url' },
    { id: 'private-photo', name: 'Private photo', avatar_url: 'private-photo-url' },
    { id: 'contacts-photo', name: 'Contacts photo', avatar_url: 'contacts-photo-url' },
    { id: 'blocked', name: 'Blocked', avatar_url: 'blocked-url' },
  ];
  const profileDetails = [
    { user_id: 'private-profile', profile_visibility: 'nobody', photo_visibility: 'everyone' },
    { user_id: 'contacts-profile', profile_visibility: 'contacts', photo_visibility: 'everyone' },
    { user_id: 'private-photo', profile_visibility: 'everyone', photo_visibility: 'nobody' },
    { user_id: 'contacts-photo', profile_visibility: 'everyone', photo_visibility: 'contacts' },
  ];
  const matches = filterPhoneDiscoveryMatches({
    profiles,
    profileDetails,
    sharedUserIds: ['contacts-profile', 'contacts-photo'],
    blockedUserIds: ['blocked'],
  });
  assert.deepEqual(matches.map((match) => match.id), ['everyone', 'contacts-profile', 'private-photo', 'contacts-photo']);
  assert.equal(matches.find((match) => match.id === 'private-photo').avatarUrl, null);
  assert.equal(matches.find((match) => match.id === 'contacts-photo').avatarUrl, 'contacts-photo-url');
  assert.equal(matches.find((match) => match.id === 'everyone').avatarUrl, 'public-everyone');
});

test('phone discovery hides contacts-only profiles and photos without a shared conversation', () => {
  const matches = filterPhoneDiscoveryMatches({
    profiles: [
      { id: 'profile', name: 'Profile', avatar_url: 'profile-url' },
      { id: 'photo', name: 'Photo', avatar_url: 'photo-url' },
    ],
    profileDetails: [
      { user_id: 'profile', profile_visibility: 'contacts', photo_visibility: 'everyone' },
      { user_id: 'photo', profile_visibility: 'everyone', photo_visibility: 'contacts' },
    ],
    sharedUserIds: [],
    blockedUserIds: [],
  });
  assert.deepEqual(matches, [{ id: 'photo', name: 'Photo', avatarUrl: null, avatarColor: null, status: null }]);
});
