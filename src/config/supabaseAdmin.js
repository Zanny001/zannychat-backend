const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  // Not fatal — lets `npm start` boot and /health respond even before
  // the Supabase project is wired up. Every route that needs the DB
  // checks supabaseAdmin for null and fails clearly instead.
  console.warn(
    '[zannychat-backend] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — ' +
      'routes that touch the database will return 500 until they are configured.'
  );
}

// The service-role key bypasses Row Level Security entirely. It must
// only ever live here, in this backend's environment — never in the
// mobile app, never in a client bundle.
const supabaseAdmin =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    : null;

module.exports = { supabaseAdmin };
