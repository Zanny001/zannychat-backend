const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { deleteLiveKitRoom } = require('../services/livekitRoomAdmin');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 8, error: 'LIVE history actions are rate-limited.' }));

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

router.delete('/:streamId', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream' });
  try {
    const { data: stream, error: streamError } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,status,room_name').eq('id', streamId).maybeSingle();
    if (streamError) throw streamError;
    if (!stream) return res.status(404).json({ error: 'LIVE broadcast not found' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can delete this broadcast' });
    if (stream.status !== 'ended') return res.status(409).json({ error: 'End the LIVE broadcast before deleting it' });

    const { data: replays, error: replayError } = await supabaseAdmin.from('live_stream_replays')
      .select('id,file_path,status').eq('stream_id', streamId);
    if (replayError) throw replayError;
    const rows = replays || [];
    if (rows.some((row) => ['starting', 'recording', 'processing'].includes(row.status))) {
      return res.status(409).json({ error: 'Wait until the LIVE replay finishes processing before deleting this broadcast' });
    }
    const paths = rows.map((row) => row.file_path).filter(Boolean);
    if (paths.some((path) => !path.startsWith(req.user.id + '/' + streamId + '/'))) {
      return res.status(409).json({ error: 'Broadcast media ownership could not be verified' });
    }
    if (stream.room_name) await deleteLiveKitRoom(stream.room_name);
    if (paths.length) {
      const { error: removeError } = await supabaseAdmin.storage.from('live-replays').remove(paths);
      if (removeError) throw removeError;
    }
    const { error: deleteError } = await supabaseAdmin.from('live_streams')
      .delete().eq('id', streamId).eq('creator_id', req.user.id).eq('status', 'ended');
    if (deleteError) throw deleteError;
    return res.json({ deleted: true, streamId, deletedReplayFiles: paths.length });
  } catch (error) {
    console.error('[live-history] broadcast deletion failed', { streamId, message: error.message });
    return res.status(503).json({ error: 'Could not delete this LIVE broadcast' });
  }
});

module.exports = router;
