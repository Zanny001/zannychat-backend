const { supabaseAdmin } = require('../config/supabaseAdmin');
const { deleteLiveKitRoom } = require('../services/livekitRoomAdmin');

const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000;

async function cleanupStaleMediaParticipants({
  admin = supabaseAdmin,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
} = {}) {
  if (!admin) throw new Error('Supabase admin client is required for media participant cleanup');
  if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 30_000) {
    throw new Error('Invalid media participant cleanup clock or lease duration');
  }
  const staleBefore = new Date(now - staleAfterMs).toISOString();
  const { data, error } = await admin.rpc('cleanup_stale_media_participants', {
    p_stale_before: staleBefore,
  });
  if (error) throw error;
  return {
    staleBefore,
    liveStreamsEnded: Number(data?.liveStreamsEnded || 0),
    liveParticipantsLeft: Number(data?.liveParticipantsLeft || 0),
    groupParticipantsLeft: Number(data?.groupParticipantsLeft || 0),
    groupRoomsEnded: Number(data?.groupRoomsEnded || 0),
  };
}


async function cleanupEndedLiveRooms({
  admin = supabaseAdmin,
  deleteRoom = deleteLiveKitRoom,
  now = Date.now(),
  graceMs = 60_000,
  limit = 25,
} = {}) {
  if (!admin) throw new Error('Supabase admin client is required for ended LIVE room cleanup');
  const cutoff = new Date(now - graceMs).toISOString();
  const { data: streams, error } = await admin.from('live_streams')
    .select('id,room_name')
    .eq('status', 'ended')
    .lt('ended_at', cutoff)
    .limit(limit);
  if (error) throw error;

  const streamIds = (streams || []).map((stream) => stream.id);
  const { data: activeReplays, error: replayError } = streamIds.length
    ? await admin.from('live_stream_replays').select('stream_id')
      .in('stream_id', streamIds).in('status', ['starting', 'recording'])
    : { data: [], error: null };
  if (replayError) throw replayError;
  const activeStreamIds = new Set((activeReplays || []).map((replay) => replay.stream_id));

  let deleted = 0;
  let waitingForReplay = 0;
  let failed = 0;
  for (const stream of streams || []) {
    if (!stream.room_name) continue;
    if (activeStreamIds.has(stream.id)) {
      waitingForReplay += 1;
      continue;
    }
    try {
      await deleteRoom(stream.room_name);
      deleted += 1;
    } catch (roomError) {
      failed += 1;
      console.error('[media-presence] ended LIVE room deletion failed:', {
        streamId: stream.id,
        message: roomError?.message || roomError,
      });
    }
  }
  return { scanned: (streams || []).length, deleted, waitingForReplay, failed };
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  cleanupStaleMediaParticipants,
  cleanupEndedLiveRooms,
};
