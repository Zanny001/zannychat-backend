const { deleteLiveKitRoom } = require('../services/livekitRoomAdmin');

const MEDIA_CLEANUP_LEASE_MS = 15 * 60 * 1000;
let legacyLeaseWarningLogged = false;

function isMissingColumn(error, column) {
  const message = String(error?.message || '').toLowerCase();
  return ['42703', 'PGRST204', 'PGRST200'].includes(String(error?.code || '')) && message.includes(column.toLowerCase());
}

async function cleanupEndedGroupCallMedia({ admin, roomIds = null, limit = 25, now = () => new Date(), deleteRoom = deleteLiveKitRoom } = {}) {
  if (!admin) admin = require('../config/supabaseAdmin').supabaseAdmin;
  if (!admin) throw new Error('Supabase service client is not configured');

  let query = admin.from('group_call_rooms').select('id,room_name').eq('status', 'ended')
    .is('media_terminated_at', null).order('ended_at', { ascending: true })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)));
  if (Array.isArray(roomIds)) {
    if (!roomIds.length) return { checked: 0, terminated: 0, failed: 0 };
    query = query.in('id', roomIds);
  }
  const { data: rooms, error } = await query;
  if (error) throw error;
  const summary = { checked: (rooms || []).length, terminated: 0, failed: 0 };
  let leaseSupported = true;

  for (const room of rooms || []) {
    const claimedAt = now().toISOString();
    let claim = room;
    if (leaseSupported) {
      const expiredBefore = new Date(now().getTime() - MEDIA_CLEANUP_LEASE_MS).toISOString();
      const { data: claims, error: claimError } = await admin.from('group_call_rooms')
        .update({ media_cleanup_claimed_at: claimedAt }).eq('id', room.id).eq('status', 'ended')
        .is('media_terminated_at', null)
        .or('media_cleanup_claimed_at.is.null,media_cleanup_claimed_at.lt.' + expiredBefore)
        .select('id,room_name');
      if (claimError && isMissingColumn(claimError, 'media_cleanup_claimed_at')) {
        leaseSupported = false;
        if (!legacyLeaseWarningLogged) {
          legacyLeaseWarningLogged = true;
          console.warn('[group-calls] durable media-cleanup lease migration is pending; using idempotent legacy teardown');
        }
      } else if (claimError) throw claimError;
      else {
        claim = claims?.[0];
        if (!claim) continue;
      }
    }
    try {
      await deleteRoom(claim.room_name);
      const patch = { media_terminated_at: now().toISOString() };
      if (leaseSupported) patch.media_cleanup_claimed_at = null;
      let completeQuery = admin.from('group_call_rooms').update(patch)
        .eq('id', claim.id).eq('status', 'ended').is('media_terminated_at', null);
      if (leaseSupported) completeQuery = completeQuery.eq('media_cleanup_claimed_at', claimedAt);
      const { data: completed, error: updateError } = await completeQuery.select('id');
      if (updateError) throw updateError;
      if (!completed?.length) throw new Error('Group-call media cleanup lease was lost before completion');
      summary.terminated += 1;
    } catch (cleanupError) {
      if (leaseSupported) {
        await admin.from('group_call_rooms').update({ media_cleanup_claimed_at: null })
          .eq('id', claim.id).eq('media_cleanup_claimed_at', claimedAt);
      }
      summary.failed += 1;
      console.warn('[group-calls] SFU teardown pending for room ' + claim.id + ': ' + (cleanupError?.message || cleanupError));
    }
  }
  return summary;
}

module.exports = { cleanupEndedGroupCallMedia, MEDIA_CLEANUP_LEASE_MS };
