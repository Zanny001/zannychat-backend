const { supabaseAdmin } = require('../config/supabaseAdmin');

async function cleanupStaleCallSessions({ admin = supabaseAdmin } = {}) {
  if (!admin) throw new Error('Supabase admin client is required for call-session cleanup');
  const { data, error } = await admin.rpc('cleanup_stale_call_signals');
  if (error) throw error;
  return { deletedSignals: Number(data || 0) };
}

module.exports = { cleanupStaleCallSessions };
