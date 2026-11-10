require('dotenv').config();

const { supabaseAdmin } = require('../config/supabaseAdmin');
const { runMessageAttachmentCleanup } = require('./messageAttachmentCleanup');

async function main() {
  if (!supabaseAdmin) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const summary = await runMessageAttachmentCleanup({ admin: supabaseAdmin });
  console.log('[attachment-cleanup] ' + JSON.stringify(summary));
  return summary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[attachment-cleanup] Worker failed:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
