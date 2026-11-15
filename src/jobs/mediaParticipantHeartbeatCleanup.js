const { supabaseAdmin } = require('../config/supabaseAdmin');

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

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  cleanupStaleMediaParticipants,
};
