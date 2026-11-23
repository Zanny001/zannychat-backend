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

test('wallet and PK writes stay behind server RPCs and audit rows are immutable', () => {
  assert.match(migration, /GRANT SELECT ON public\.live_gift_catalog, public\.live_gift_wallets/);
  assert.doesNotMatch(migration, /GRANT ALL ON public\.live_gift_catalog/);
  assert.match(migration, /CREATE TRIGGER live_gift_ledger_append_only/);
  assert.match(migration, /CREATE TRIGGER live_gift_transactions_append_only/);
  assert.match(migration, /LIVE gift audit records are append-only/);
});

test('LIVE gift catalogue is seeded deterministically and gifts debit Sparks atomically', () => {
  for (const gift of ['heart', 'spark', 'crown', 'aurora', 'royal_star']) assert.ok(migration.includes("'" + gift + "'"));
  assert.match(migration, /SELECT balance_sparks INTO v_balance[\s\S]*FOR UPDATE/);
  assert.match(migration, /insufficient LIVE Sparks/);
  assert.match(migration, /INSERT INTO public\.live_gift_transactions/);
  assert.match(migration, /INSERT INTO public\.live_gift_ledger/);
  assert.match(migration, /UNIQUE \(sender_id, idempotency_key\)/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_sender_id::text \|\| ':' \|\| p_idempotency_key, 0\)\)/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_user_id::text \|\| ':' \|\| p_idempotency_key, 0\)\)/);
  assert.match(migration, /v_existing\.reference_id IS DISTINCT FROM p_reference_id/);
  assert.doesNotMatch(migration, /^AS \$$/m);
  assert.doesNotMatch(migration, /^\$$/m);
  assert.match(migration, /battle_id uuid REFERENCES public\.live_pk_battles\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /score_points, battle_id, idempotency_key/);
  assert.match(migration, /p_quantity NOT BETWEEN 1 AND 20/);
});

test('PK gift attribution is derived from the active battle on the server, not from client input', () => {
  assert.match(migration, /Battle attribution is derived from locked server state/);
  assert.match(migration, /p_recipient_id IN \(creator_a_id, creator_b_id\)/);
  assert.match(migration, /v_effective_battle_id := v_battle\.id/);
  assert.match(migration, /score_a = score_a \+ v_points/);
  assert.match(migration, /score_b = score_b \+ v_points/);
  assert.match(migration, /user_id = v_battle\.creator_a_id[\s\S]*role = 'creator'/);
  assert.doesNotMatch(route, /p_battle_id/);
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
  assert.ok(route.includes("router.get('/wallet'"));
  assert.ok(route.includes("router.get('/catalog'"));
  assert.ok(route.includes("router.post('/send'"));
  assert.doesNotMatch(route, /grant_live_sparks/);
  assert.match(route, /p_idempotency_key: idempotencyKey/);
  assert.doesNotMatch(route, /p_battle_id/);
  assert.ok(index.includes("app.use('/live/gifts', liveGiftsRouter)"));
});

const battles = fs.readFileSync(path.join(__dirname, '../src/routes/liveBattles.js'), 'utf8');
const captions = fs.readFileSync(path.join(__dirname, '../src/routes/liveCaptions.js'), 'utf8');

test('PK battle routes require authentication and expose creator-controlled lifecycle actions', () => {
  assert.match(battles, /router\.use\(requireAuth/);
  assert.match(battles, /p_creator_a_id: req\.user\.id/);
  assert.match(battles, /p_creator_id: req\.user\.id/);
  assert.ok(battles.includes("router.post('/',"));
  assert.ok(battles.includes("router.post('/:battleId/start'"));
  assert.ok(battles.includes("router.post('/:battleId/finish'"));
  assert.ok(battles.includes("router.get('/stream/:streamId/current'"));
  assert.match(battles, /Join this LIVE to view its PK battle/);
  assert.ok(index.includes("app.use('/live/battles', liveBattlesRouter)"));
});

test('PK expiry is performed by a privileged RPC, not direct service-role table writes', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.expire_live_pk_battle_challenges/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.expire_live_pk_battle_challenges\(uuid\) TO service_role/);
  assert.match(battles, /rpc\('expire_live_pk_battle_challenges'/);
  assert.ok(battles.indexOf(".eq('user_id', req.user.id)") < battles.indexOf("rpc('expire_live_pk_battle_challenges'"));
  assert.ok(battles.includes('if (!participant) return res.status(403)'));
  assert.doesNotMatch(battles, /\.from\('live_pk_battles'\)\.update/);
});

test('PK challenges require explicit guest consent before the host can start', () => {
  assert.match(migration, /status IN \('pending', 'accepted', 'live', 'ended', 'cancelled'\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.accept_live_pk_battle/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.decline_live_pk_battle/);
  assert.match(migration, /v_battle\.status <> 'accepted'/);
  assert.match(migration, /status = 'pending' AND created_at < now\(\) - interval '2 minutes'/);
  assert.match(migration, /status = 'live' AND ends_at <= now\(\)/);
  assert.match(migration, /v_battle.created_at < now\(\) - interval '10 minutes'/);
  assert.ok(battles.includes("router.post('/:battleId/accept'"));
  assert.ok(battles.includes("router.post('/:battleId/decline'"));
  assert.match(battles, /live_pk_challenge/);
  assert.match(battles, /live_pk_accepted/);
});

test('LIVE captions never fabricate text and require explicit opt-in provider-backed translation', () => {
  assert.match(captions, /\.from\('live_streams'\)/);
  assert.match(captions, /stream.status !== 'live'/);
  assert.ok(battles.includes("participant?.role === 'guest'"));
  assert.ok(battles.includes("participant?.role === 'creator'"));

  assert.match(captions, /LIVE_TRANSLATION_ENABLED !== 'true'/);
  assert.ok(captions.includes('isAiConfigured()'));
  assert.ok(captions.includes('await askClaude('));
  assert.match(captions, /status: false|transcription: false/);
  assert.match(captions, /transcriptStored: false/);
  assert.match(captions, /\.eq\('status', 'joined'\)/);
  assert.ok(index.includes("app.use('/live/captions', liveCaptionsRouter)"));
});


const accountDeletionMigration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123130000_live_gift_account_deletion_privacy.sql'),
  'utf8',
);
const accountRoute = fs.readFileSync(path.join(__dirname, '../src/routes/account.js'), 'utf8');

test('LIVE gift audit history is anonymized safely instead of blocking Auth account deletion', () => {
  assert.match(accountRoute, /supabaseAdmin\.auth\.admin\.deleteUser\(req\.user\.id\)/);
  assert.match(accountDeletionMigration, /live_gift_ledger_user_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(accountDeletionMigration, /live_gift_transactions_sender_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(accountDeletionMigration, /live_gift_transactions_recipient_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(accountDeletionMigration, /live_gift_transactions_stream_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(accountDeletionMigration, /live_gift_transactions_battle_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(accountDeletionMigration, /live_pk_battles_creator_a_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(accountDeletionMigration, /live_pk_battles_creator_b_id_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(accountDeletionMigration, /Auth deletion may redact only the personal identifier/);
  assert.match(accountDeletionMigration, /FK-driven anonymisation may null only references/);
  assert.match(accountDeletionMigration, /RAISE EXCEPTION 'LIVE gift audit records are append-only'/);
});


const privilegeHardeningMigration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123140000_lock_live_economy_service_role_readonly.sql'),
  'utf8',
);

test('LIVE economy service_role is read-only; all mutations remain RPC-owned', () => {
  assert.match(privilegeHardeningMigration, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(privilegeHardeningMigration, /GRANT SELECT ON TABLE[\s\S]*TO service_role/);
  assert.doesNotMatch(privilegeHardeningMigration, /GRANT (?:INSERT|UPDATE|DELETE|ALL)/i);
});


test('LIVE gift activity is visible only to joined stage participants and contains server facts', () => {
  assert.match(route, /router\.get\('\/stream\/:streamId\/recent'/);
  assert.match(route, /stream\.status !== 'live'/);
  assert.match(route, /\.eq\('user_id', req\.user\.id\)[\s\S]*\.eq\('status', 'joined'\)[\s\S]*\.is\('left_at', null\)/);
  assert.match(route, /\.from\('live_gift_transactions'\)[\s\S]*\.eq\('stream_id', streamId\)[\s\S]*\.limit\(20\)/);
  assert.match(route, /senderName:[\s\S]*recipientName:[\s\S]*scorePoints:/);
  assert.doesNotMatch(route.slice(route.indexOf("router.get('/stream/:streamId/recent'"), route.indexOf("router.post('/send'")), /\.insert\(|\.update\(|\.delete\(/);
});


const liveEconomyIndexesMigration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123110901_live_economy_foreign_key_indexes.sql'),
  'utf8',
);

test('LIVE economy foreign keys have supporting indexes for production joins and deletes', () => {
  for (const statement of [
    'CREATE INDEX IF NOT EXISTS live_gift_transactions_gift_id_idx',
    'ON public.live_gift_transactions (gift_id)',
    'CREATE INDEX IF NOT EXISTS live_pk_battles_created_by_idx',
    'ON public.live_pk_battles (created_by)',
    'CREATE INDEX IF NOT EXISTS live_pk_battles_creator_b_idx',
    'ON public.live_pk_battles (creator_b_id)',
    'CREATE INDEX IF NOT EXISTS live_pk_battles_winner_id_idx',
    'ON public.live_pk_battles (winner_id)',
  ]) assert.ok(liveEconomyIndexesMigration.includes(statement), 'Missing index contract: ' + statement);
});
