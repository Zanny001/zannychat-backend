const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();

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
      const { error } = await supabaseAdmin.from('profiles').select('id').limit(1);
      supabaseReachable = !error;
      if (error) supabaseError = error.message;
    } catch (err) {
      supabaseError = err.message;
    }
  }

  res.json({
    status: 'ok',
    service: 'zannychat-backend',
    supabaseConfigured: Boolean(supabaseAdmin),
    supabaseReachable,
    supabaseError,
    time: new Date().toISOString(),
  });
});

module.exports = router;
