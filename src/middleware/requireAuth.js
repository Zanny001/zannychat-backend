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

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = data.user;
  next();
}

module.exports = { requireAuth };
