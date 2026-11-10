require('dotenv').config();

const { supabaseAdmin } = require('../config/supabaseAdmin');
const { runCallInvitationNotifications } = require('./callInvitationNotifications');

async function main() {
  if (!supabaseAdmin) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const summary = await runCallInvitationNotifications({ admin: supabaseAdmin });
  console.log('[call-notifications] ' + JSON.stringify(summary));
  return summary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[call-notifications] Worker failed:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
