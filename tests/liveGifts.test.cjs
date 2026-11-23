const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261123110000_live_gifts_pk_battles.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveGifts.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('LIVE Sparks are non-cash promotional credits with a server-only ledger', () => {
  assert.match(migration, /balance_sparks bigint NOT NULL DEFAULT 0 CHECK \(balance_sparks >= 0\)/);
  assert.match(migration, /entry_type IN \('grant', 'spend', 'refund', 'adjustment'\)/);
  assert.match(migration, /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(migration, /not money, not purchasable, and not redeemable for cash/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.grant_live_sparks[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.grant_live_sparks[\s\S]*TO service_role/);
});

test('LIVE gift catalogue is seeded deterministically and gifts debit Sparks atomically', () => {
  for (const gift of ['heart', 'spark', 'crown', 'aurora', 'royal_star']) assert.ok(migration.includes("'" + gift + "'"));
  assert.match(migration, /SELECT balance_sparks INTO v_balance[\s\S]*FOR UPDATE/);
  assert.match(migration, /insufficient LIVE Sparks/);
  assert.match(migration, /INSERT INTO public\.live_gift_transactions/);
  assert.match(migration, /INSERT INTO public\.live_gift_ledger/);
  assert.match(migration, /UNIQUE \(sender_id, idempotency_key\)/);
  assert.doesNotMatch(migration, /^AS \$$/m);
  assert.match(migration, /battle_id uuid REFERENCES public\.live_pk_battles/);
  assert.match(migration, /score_points, battle_id, idempotency_key/);
  assert.match(migration, /p_quantity NOT BETWEEN 1 AND 20/);
});

test('LIVE PK score is server-owned, time-bounded, and sourced from committed gift points only', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.live_pk_battles/);
  assert.match(migration, /score_a bigint NOT NULL DEFAULT 0/);
  assert.match(migration, /score_b bigint NOT NULL DEFAULT 0/);
  assert.match(migration, /now\(\) >= started_at AND now\(\) < ends_at/);
  assert.match(migration, /score_a = score_a \+ v_points/);
  assert.match(migration, /score_b = score_b \+ v_points/);
  assert.match(migration, /score increases only from committed gift transactions/i);
});

test('LIVE gift API derives sender from authentication and exposes no client balance mutation', () => {
  assert.match(route, /router\.use\(requireAuth/);
  assert.match(route, /p_sender_id: req\.user\.id/);
  assert.match(route, /router\.get\('\/wallet'/);
  assert.match(route, /router\.get\('\/catalog'/);
  assert.match(route, /router\.post\('\/send'/);
  assert.doesNotMatch(route, /grant_live_sparks/);
  assert.match(route, /p_idempotency_key: idempotencyKey/);
  assert.match(route, /p_battle_id: battleId/);
  assert.match(index, /app\.use\('\/live\/gifts', liveGiftsRouter\)/);
});

const battles = fs.readFileSync(path.join(__dirname, '../src/routes/liveBattles.js'), 'utf8');
const captions = fs.readFileSync(path.join(__dirname, '../src/routes/liveCaptions.js'), 'utf8');

test('PK battle routes require authentication and expose creator-controlled lifecycle actions', () => {
  assert.match(battles, /router\.use\(requireAuth/);
  assert.match(battles, /p_creator_a_id: req\.user\.id/);
  assert.match(battles, /p_creator_id: req\.user\.id/);
  assert.match(battles, /router\.post\('\/\'/);
  assert.match(battles, /router\.post\('\/:battleId\/start'/);
  assert.match(battles, /router\.post\('\/:battleId\/finish'/);\n  assert.match(battles, /router\.get\('\/stream\/:streamId\/current'/);\n  assert.match(battles, /\.in\('status', \['pending', 'live', 'ended'\]\)/);
  assert.match(battles, /Join this LIVE to view its PK battle/);
  assert.match(index, /app\.use\('\/live\/battles', liveBattlesRouter\)/);
});

test('PK challenges require explicit guest consent before the host can start', () => {
  assert.match(migration, /status IN \\('pending', 'accepted', 'live', 'ended', 'cancelled'\\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\\.accept_live_pk_battle/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\\.decline_live_pk_battle/);
  assert.match(migration, /v_battle\\.status <> 'accepted'/);
  assert.match(migration, /status = 'pending' AND created_at < now\\(\\) - interval '2 minutes'/);
  assert.match(battles, /router\\.post\\('\/:battleId\\/accept'/);
  assert.match(battles, /router\\.post\\('\/:battleId\\/decline'/);
  assert.match(battles, /live_pk_challenge/);
  assert.match(battles, /live_pk_accepted/);
});

test('LIVE captions never fabricate text and require explicit opt-in provider-backed translation', () => {
  assert.match(captions, /LIVE_TRANSLATION_ENABLED !== 'true'/);
  assert.match(captions, /isAiConfigured\(\)/);
  assert.match(captions, /await askClaude\(/);
  assert.match(captions, /status: false|transcription: false/);
  assert.match(captions, /transcriptStored: false/);
  assert.match(captions, /\.eq\('status', 'joined'\)/);
  assert.match(index, /app\.use\('\/live\/captions', liveCaptionsRouter\)/);
});
