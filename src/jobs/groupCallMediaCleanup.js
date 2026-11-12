const { deleteLiveKitRoom } = require('../services/livekitRoomAdmin');

async function cleanupEndedGroupCallMedia({ admin, roomIds = null, limit = 25, now = () => new Date(), deleteRoom = deleteLiveKitRoom } = {}) {
  if (!admin) admin = require('../config/supabaseAdmin').supabaseAdmin;
  if (!admin) throw new Error('Supabase service client is not configured');

  let query = admin.from('group_call_rooms')
    .select('id,room_name')
    .eq('status', 'ended')
    .is('media_terminated_at', null)
    .order('ended_at', { ascending: true })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)));
  if (Array.isArray(roomIds)) {
    if (!roomIds.length) return { checked: 0, terminated: 0, failed: 0 };
    query = query.in('id', roomIds);
  }

  const { data: rooms, error } = await query;
  if (error) throw error;
  const summary = { checked: (rooms || []).length, terminated: 0, failed: 0 };

  for (const room of rooms || []) {
    try {
      await deleteRoom(room.room_name);
      const { error: updateError } = await admin.from('group_call_rooms')
        .update({ media_terminated_at: now().toISOString() })
        .eq('id', room.id)
        .eq('status', 'ended')
        .is('media_terminated_at', null);
      if (updateError) throw updateError;
      summary.terminated += 1;
    } catch (cleanupError) {
      summary.failed += 1;
      console.warn('[group-calls] SFU teardown pending for room ' + room.id + ': ' + (cleanupError?.message || cleanupError));
    }
  }
  return summary;
}

module.exports = { cleanupEndedGroupCallMedia };
