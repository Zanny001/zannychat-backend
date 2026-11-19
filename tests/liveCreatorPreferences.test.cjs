const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261119180000_live_creator_preferences.sql'), 'utf8');

test('LIVE creator preferences are durable, account-scoped and protected by RLS', () => {
  assert.ok(migration.includes('public.live_creator_preferences'));
  assert.ok(migration.includes('user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE'));
  assert.ok(migration.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(migration.includes('REVOKE ALL ON public.live_creator_preferences FROM PUBLIC, anon, authenticated'));
  assert.ok(migration.includes('GRANT ALL ON public.live_creator_preferences TO service_role'));
  assert.ok(migration.includes("CHECK (experience_mode IN ('broadcast', 'video_chat', 'audio_room'))"));
  assert.ok(migration.includes("CHECK (visibility IN ('public', 'followers', 'private'))"));
  assert.ok(migration.includes('allow_guests boolean NOT NULL DEFAULT false'));
});

test('LIVE preferences API only reads and writes the authenticated account', () => {
  const getStart = route.indexOf("router.get('/creators/me/preferences'");
  const putStart = route.indexOf("router.put('/creators/me/preferences'");
  const profileStart = route.indexOf("router.get('/creators/me/profile'");
  assert.ok(getStart >= 0 && putStart > getStart && profileStart > putStart);
  const handlers = route.slice(getStart, profileStart);
  assert.ok(handlers.includes(".eq('user_id', req.user.id)"));
  assert.ok(handlers.includes("user_id: req.user.id"));
  assert.ok(handlers.includes("onConflict: 'user_id'"));
  assert.ok(handlers.includes("experience_mode: experienceMode"));
  assert.ok(handlers.includes("visibility,category,allow_guests,updated_at"));
});

test('LIVE preferences API rejects invalid formats, audiences, categories and guest values', () => {
  const getStart = route.indexOf("router.get('/creators/me/preferences'");
  const profileStart = route.indexOf("router.get('/creators/me/profile'");
  const handlers = route.slice(getStart, profileStart);
  assert.ok(handlers.includes("LIVE_EXPERIENCE_MODES.has(experienceMode)"));
  assert.ok(handlers.includes("['public', 'followers', 'private'].includes(visibility)"));
  assert.ok(handlers.includes('LIVE_CATEGORIES.has(category)'));
  assert.ok(handlers.includes("typeof allowGuests !== 'boolean'"));
  assert.ok(handlers.includes('Invalid LIVE creator preferences'));
  assert.ok(handlers.includes('Object.keys(body).some((key) => !allowedKeys.has(key))'));
  assert.ok(handlers.includes('updated_at: new Date().toISOString()'));
});

test('LIVE preferences production workflow is manually confirmed and narrowly scoped', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/live-creator-preferences-migration.yml'), 'utf8');
  assert.ok(workflow.includes('confirm_production_apply'));
  assert.ok(workflow.includes('default: false'));
  assert.ok(workflow.includes('EXPECTED="20261119180000"'));
  assert.ok(workflow.includes('supabase db push --dry-run --linked'));
  assert.ok(workflow.includes('supabase db push --linked --yes'));
  assert.ok(workflow.includes('test "$PENDING" = "20261119180000"'));
});
