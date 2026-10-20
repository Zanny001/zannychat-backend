const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
const { safeHealthDiagnostic } = require('../utils/healthDiagnostics');

// Readiness must not hang indefinitely if Supabase stalls. Keep this bounded
// independently of the platform's HTTP request timeout.
const HEALTH_QUERY_TIMEOUT_MS = Math.max(1000, Math.min(10000, Number.parseInt(process.env.HEALTH_QUERY_TIMEOUT_MS || '4000', 10) || 4000));
function healthQuery() {
  const query = supabaseAdmin.from('profiles').select('id').limit(1);
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    && typeof query.abortSignal === 'function'
    ? query.abortSignal(AbortSignal.timeout(HEALTH_QUERY_TIMEOUT_MS))
    : query;
}

// Liveness is deliberately dependency-free so the platform can distinguish
// a running Node process from a database outage.
router.get('/live', (req, res) => {
  res.json({ status: 'ok', service: 'zannychat-backend', time: new Date().toISOString() });
});

// Readiness is strict: it returns 503 when the backend cannot serve database-backed
// requests. Keep the legacy '/' health response stable for existing monitors.
router.get('/ready', async (req, res) => {
  let reachable = false;
  let error = null;
  if (supabaseAdmin) {
    try {
      const result = await healthQuery();
      error = result.error || null;
      reachable = !error;
    } catch (err) {
      error = err;
    }
  }
  const configured = Boolean(supabaseAdmin);
  const diagnostic = safeHealthDiagnostic(error, reachable, configured);
  const status = reachable ? 200 : 503;
  res.status(status).json({
    status: reachable ? 'ready' : 'not_ready',
    service: 'zannychat-backend',
    supabaseConfigured: configured,
    supabaseReachable: reachable,
    diagnostic,
    time: new Date().toISOString(),
  });
});

// This used to only report whether SUPABASE_URL/SERVICE_ROLE_KEY were
// present at startup — true even if they're just wrong. Now it makes
// one real, cheap query, so "supabaseReachable: true" actually means
// the deployed service can talk to the deployed database, not just
// that two env vars are non-empty. Always returns 200 (even when the
// check fails) so Render's own health monitor doesn't flap the
// service over a transient Supabase blip — the failure shows up in
// the body, not the status code.
router.get('/', async (req, res) => {
  let supabaseReachable = false;
  let supabaseError = null;

  if (supabaseAdmin) {
    try {
      const { error } = await healthQuery();
      supabaseReachable = !error;
      if (error) supabaseError = error;
    } catch (err) {
      supabaseError = err;
    }
  }

  res.json({
    status: 'ok',
    service: 'zannychat-backend',
    supabaseConfigured: Boolean(supabaseAdmin),
    supabaseReachable,
    supabaseError: safeHealthDiagnostic(supabaseError, supabaseReachable, Boolean(supabaseAdmin)),
    time: new Date().toISOString(),
  });
});

module.exports = router;
