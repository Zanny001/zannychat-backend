require('dotenv').config();
const { supabaseAdmin } = require('../config/supabaseAdmin');

async function deliverScheduledMessages() {
  if (!supabaseAdmin) throw new Error('Supabase is not configured');
  const { data, error } = await supabaseAdmin.rpc('deliver_due_scheduled_messages', { p_limit: 100 });
  if (error) throw new Error('Scheduled-message delivery failed');
  const delivered = Number(data);
  if (!Number.isInteger(delivered) || delivered < 0) throw new Error('Scheduled-message worker returned an invalid count');
  console.log(`[scheduled-messages] delivered ${delivered} message(s) at ${new Date().toISOString()}`);
  return delivered;
}

if (require.main === module) {
  deliverScheduledMessages().then(() => process.exit(0)).catch((error) => {
    console.error('[scheduled-messages] run failed:', error.message);
    process.exit(1);
  });
}
module.exports = { deliverScheduledMessages };
