const { supabaseAdmin } = require('../config/supabaseAdmin');

// The mobile app sends its Supabase session token as a bearer token.
// This verifies it server-side and attaches the resolved user to
// req.user so routes never have to trust a client-supplied user id.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Backend is not configured (missing Supabase env vars)' });
  }

  let data;
  let error;
  try {
    ({ data, error } = await supabaseAdmin.auth.getUser(token));
  } catch (authProviderError) {
    // Distinguish an unavailable auth provider from a rejected credential.
    // Never send provider exception details to the client.
    console.error('[auth] Token verification provider failed');
    return res.status(503).json({ error: 'Authentication service temporarily unavailable' });
  }
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = data.user;
  // getUser() has already validated the JWT with Supabase. Read only the
  // auth_time claim from that verified token so destructive routes can require
  // a recent password re-authentication rather than trusting a client flag.
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    req.authTime = Number.isFinite(payload.auth_time) ? payload.auth_time : null;
  } catch (_) {
    req.authTime = null;
  }
  next();
}

module.exports = { requireAuth };
