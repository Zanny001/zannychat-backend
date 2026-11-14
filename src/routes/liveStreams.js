const express = require('express');
const { randomUUID } = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { createLiveKitToken, getLiveKitConfig } = require('../services/livekitToken');
const { sendPushToUser } = require('../config/pushClient');
const {
  getLiveReplayConfig,
  getLiveKitEgressConfig,
  listEgress,
  isLiveReplayEnabled,
  startRoomCompositeEgress,
  stopEgress,
  MAX_REPLAY_SECONDS,
  MAX_REPLAY_BYTES,
} = require('../services/livekitEgress');
const { scheduleLiveReplayStop, clearLiveReplayStop } = require('../jobs/liveReplayWorker');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 30, error: 'LIVE actions are rate-limited.' }));

const REASONS = new Set(['harassment','hate','nudity','violence','spam','copyright','other']);
const REACTIONS = new Set(['heart','clap','laugh','wow','fire','idea','support']);

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function issueToken(user, roomName, config, canPublish) {
  return createLiveKitToken({
    identity: user.id,
    name: user.user_metadata?.name || user.user_metadata?.full_name || 'ZannyChat viewer',
    room: roomName,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
    config,
  });
}

async function hasBlockBetween(userA, userB) {
  const { data: first, error: firstError } = await supabaseAdmin.from('blocked_users')
    .select('blocker_id').eq('blocker_id', userA).eq('blocked_id', userB).maybeSingle();
  if (firstError) throw firstError;
  const { data: second, error: secondError } = await supabaseAdmin.from('blocked_users')
    .select('blocker_id').eq('blocker_id', userB).eq('blocked_id', userA).maybeSingle();
  if (secondError) throw secondError;
  return Boolean(first || second);
}

async function canViewCreatorImpact(viewerId, creatorId) {
  if (viewerId === creatorId) return true;
  if (await hasBlockBetween(viewerId, creatorId)) return false;
  const { data: details, error: detailsError } = await supabaseAdmin.from('profile_details')
    .select('profile_visibility').eq('user_id', creatorId).maybeSingle();
  if (detailsError) throw detailsError;
  const visibility = details?.profile_visibility || 'everyone';
  if (visibility === 'nobody') return false;
  if (visibility !== 'contacts') return true;
  const { data: mine, error: mineError } = await supabaseAdmin.from('conversation_participants')
    .select('conversation_id').eq('user_id', viewerId);
  if (mineError) throw mineError;
  const conversationIds = [...new Set((mine || []).map((row) => row.conversation_id).filter(Boolean))];
  if (!conversationIds.length) return false;
  const { data: shared, error: sharedError } = await supabaseAdmin.from('conversation_participants')
    .select('conversation_id').eq('user_id', creatorId).in('conversation_id', conversationIds).limit(1);
  if (sharedError) throw sharedError;
  return Boolean(shared?.length);
}

async function getBlockedUserIds(userId, otherIds) {
  const ids = [...new Set((otherIds || []).filter((id) => validId(id) && id !== userId))];
  if (!ids.length) return new Set();
  const [blockedByUser, blockedUser] = await Promise.all([
    supabaseAdmin.from('blocked_users').select('blocked_id').eq('blocker_id', userId).in('blocked_id', ids),
    supabaseAdmin.from('blocked_users').select('blocker_id').eq('blocked_id', userId).in('blocker_id', ids),
  ]);
  if (blockedByUser.error || blockedUser.error) throw blockedByUser.error || blockedUser.error;
  return new Set([
    ...(blockedByUser.data || []).map((row) => row.blocked_id),
    ...(blockedUser.data || []).map((row) => row.blocker_id),
  ]);
}

async function notifyLiveUsers(userIds, notification) {
  const ids = [...new Set((userIds || []).filter(validId))];
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = ids.slice(offset, offset + 20);
    const results = await Promise.allSettled(batch.map((userId) => sendPushToUser(userId, notification)));
    results.forEach((result) => {
      if (result.status === 'rejected') {
        console.error('[live] push notification failed:', result.reason?.message || result.reason);
      }
    });
  }
}

async function notifyCreatorFollowers(creatorId, notification) {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_follows')
      .select('follower_id').eq('creator_id', creatorId).limit(500);
    if (error) throw error;
    const followerIds = [...new Set((data || []).map((row) => row.follower_id))];
    const blockedIds = await getBlockedUserIds(creatorId, followerIds);
    await notifyLiveUsers(followerIds.filter((id) => !blockedIds.has(id)), notification);
  } catch (error) {
    // A push outage must never turn a committed LIVE start into an API failure.
    console.error('[live] follower notification lookup failed:', error?.message || error);
  }
}

async function getProfileNames(userIds) {
  const ids = [...new Set((userIds || []).filter(validId))];
  if (!ids.length) return new Map();
  try {
    const { data, error } = await supabaseAdmin.from('profiles')
      .select('id,name').in('id', ids);
    if (error) throw error;
    return new Map((data || []).map((row) => [row.id, row.name]));
  } catch (error) {
    console.error('[live] comment display name lookup failed:', error?.message || error);
    return new Map();
  }
}

async function getStream(streamId) {
  const { data, error } = await supabaseAdmin.from('live_streams')
    .select('id,creator_id,title,description,room_name,visibility,status,allow_comments,allow_guests,viewer_limit,started_at')
    .eq('id', streamId).maybeSingle();
  if (error) throw error;
  return data;
}

async function canViewLiveReplay(stream, userId) {
  if (stream.creator_id === userId) return true;
  if (await hasBlockBetween(stream.creator_id, userId)) return false;
  if (stream.visibility === 'public') return true;
  if (await canModerateLive(stream, userId)) return true;

  const { data: participant, error: participantError } = await supabaseAdmin.from('live_stream_participants')
    .select('id').eq('stream_id', stream.id).eq('user_id', userId).maybeSingle();
  if (participantError) throw participantError;
  if (participant) return true;
  if (stream.visibility === 'followers') {
    const { data, error } = await supabaseAdmin.from('live_creator_follows')
      .select('creator_id').eq('creator_id', stream.creator_id).eq('follower_id', userId).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
  if (stream.visibility === 'private') {
    const { data, error } = await supabaseAdmin.from('live_stream_invites')
      .select('id').eq('stream_id', stream.id).eq('user_id', userId)
      .in('status', ['accepted', 'approved']).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
  return false;
}

async function stopActiveLiveReplayForStream(streamId) {
  const egressConfig = getLiveKitEgressConfig();
  if (!egressConfig) return;
  const { data, error } = await supabaseAdmin.from('live_stream_replays')
    .select('id,egress_id,status,room_name')
    .eq('stream_id', streamId)
    .in('status', ['starting', 'recording'])
    .limit(1);
  if (error) throw error;
  const replay = data?.[0];
  if (!replay) return;
  let egressId = replay.egress_id;
  if (!egressId) {
    const listed = await listEgress(replay.room_name, egressConfig);
    const found = (listed?.items || []).find((item) => item?.egress_id || item?.egressId);
    egressId = found?.egress_id || found?.egressId || null;
  }
  if (!egressId) {
    // Give the signed completion webhook time to reconcile a just-finished Egress.
    return;
  }
  await supabaseAdmin.from('live_stream_replays')
    .update({ egress_id: egressId, status: 'recording' })
    .eq('id', replay.id);
  try {
    await stopEgress(egressId, egressConfig);
  } catch (error) {
    if (!error.message.includes('HTTP 404')) throw error;
  }
  await supabaseAdmin.from('live_stream_replays')
    .update({ status: 'processing' })
    .eq('id', replay.id)
    .in('status', ['starting', 'recording']);
  clearLiveReplayStop(replay.id);
}

async function requireJoined(streamId, userId) {
  const { data, error } = await supabaseAdmin.from('live_stream_participants')
    .select('id,role,status').eq('stream_id', streamId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.status === 'joined' ? data : null;
}

async function canModerateLive(stream, userId) {
  if (stream.creator_id === userId) return true;
  const { data, error } = await supabaseAdmin.from('live_stream_moderators')
    .select('user_id').eq('stream_id', stream.id).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

router.get('/replays/config', async (req, res) => {
  res.json({
    enabled: isLiveReplayEnabled(),
    maxDurationSeconds: MAX_REPLAY_SECONDS,
    maxFileBytes: MAX_REPLAY_BYTES,
    retentionDays: 7,
  });
});

router.post('/:streamId/replays/start', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream' });
  if (!isLiveReplayEnabled()) return res.status(503).json({ error: 'Creator replay is not enabled on this server yet' });
  const replayConfig = getLiveReplayConfig();
  if (!replayConfig) return res.status(503).json({ error: 'Creator replay storage is not configured' });

  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the LIVE creator can record a replay' });
    if (stream.status !== 'live' || !stream.room_name) return res.status(409).json({ error: 'The LIVE stream is not active' });

    const { data: storageBytes, error: storageError } = await supabaseAdmin.rpc('get_live_replay_storage_bytes');
    if (storageError) throw storageError;
    const currentStorageBytes = Number(storageBytes || 0);
    const storageCapBytes = 700_000_000;
    if (!Number.isFinite(currentStorageBytes) || currentStorageBytes + MAX_REPLAY_BYTES > storageCapBytes) {
      return res.status(507).json({ error: 'Replay storage is at its safe free-tier limit' });
    }

    const replayId = randomUUID();
    const filePath = req.user.id + '/' + streamId + '/' + replayId + '.mp4';
    const now = new Date().toISOString();
    const { error: insertError } = await supabaseAdmin.from('live_stream_replays').insert({
      id: replayId,
      stream_id: streamId,
      creator_id: req.user.id,
      room_name: stream.room_name,
      file_path: filePath,
      status: 'starting',
      started_at: now,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (insertError) {
      if (insertError.code === '23505') return res.status(409).json({ error: 'A replay already exists or is being recorded for this stream' });
      throw insertError;
    }

    const { data: reserved, error: quotaError } = await supabaseAdmin.rpc('reserve_live_replay_quota', { p_replay_id: replayId });
    if (quotaError) {
      await supabaseAdmin.rpc('finalize_live_replay_quota', {
        p_replay_id: replayId, p_actual_seconds: 0, p_success: false,
      }).catch(() => {});
      await supabaseAdmin.from('live_stream_replays').delete().eq('id', replayId);
      throw quotaError;
    }
    if (reserved !== true) {
      await supabaseAdmin.from('live_stream_replays').delete().eq('id', replayId);
      return res.status(429).json({ error: 'The monthly replay allowance is exhausted or another replay is active' });
    }

    let egressId = null;
    try {
      const egress = await startRoomCompositeEgress({
        roomName: stream.room_name,
        filePath,
        replayConfig,
      });
      egressId = egress?.egress_id || egress?.egressId || null;
      if (!egressId) {
        const listed = await listEgress(stream.room_name, replayConfig.egressConfig);
        const found = (listed?.items || []).find((item) => item?.egress_id || item?.egressId);
        egressId = found?.egress_id || found?.egressId || null;
        if (!egressId) {
          return res.status(503).json({ error: 'Replay start is being reconciled; quota remains reserved safely' });
        }
      }
      const { error: updateError } = await supabaseAdmin.from('live_stream_replays')
        .update({ egress_id: egressId, status: 'recording' })
        .eq('id', replayId);
      if (updateError) throw updateError;
      scheduleLiveReplayStop(replayId, egressId, now);
      return res.status(201).json({
        replay: { id: replayId, status: 'recording', startedAt: now, maxDurationSeconds: MAX_REPLAY_SECONDS },
      });
    } catch (error) {
      const definitiveFailure = /HTTP (400|401|403|404|409|422|429)\b/.test(String(error.message || ''));
      if (!egressId && definitiveFailure) {
        await supabaseAdmin.from('live_stream_replays')
          .update({
            status: 'failed',
            error_code: 'EGRESS_START_FAILED',
            completed_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          })
          .eq('id', replayId);
        const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
          p_replay_id: replayId, p_actual_seconds: 0, p_success: false,
        });
        if (quotaError) console.error('[live-replay] failed-start quota release deferred', { replayId, message: quotaError.message });
        return res.status(502).json({ error: 'Could not start the replay recording' });
      }
      if (!egressId) {
        try {
          const listed = await listEgress(stream.room_name, replayConfig.egressConfig);
          const found = (listed?.items || []).find((item) => item?.egress_id || item?.egressId);
          egressId = found?.egress_id || found?.egressId || null;
        } catch (lookupError) {
          console.error('[live-replay] ambiguous Egress start; recovery lookup failed', { streamId, message: lookupError.message });
          return res.status(503).json({ error: 'Replay start is being reconciled; quota remains reserved safely' });
        }
      }

      if (egressId) {
        let stopConfirmed = false;
        try {
          await stopEgress(egressId, replayConfig.egressConfig);
          stopConfirmed = true;
        } catch (stopError) {
          if (stopError.message.includes('HTTP 404')) stopConfirmed = true;
          else console.error('[live-replay] Egress recovery stop deferred', { replayId, message: stopError.message });
        }
        const recoveryStatus = stopConfirmed ? 'processing' : 'recording';
        const { error: recoveryError } = await supabaseAdmin.from('live_stream_replays')
          .update({ egress_id: egressId, status: recoveryStatus })
          .eq('id', replayId);
        if (recoveryError) {
          console.error('[live-replay] Egress id could not be persisted; room recovery will retry', { replayId, message: recoveryError.message });
          return res.status(503).json({ error: 'Replay start is being reconciled; quota remains reserved safely' });
        }
        if (stopConfirmed) {
          clearLiveReplayStop(replayId);
          return res.status(202).json({ replay: { id: replayId, status: 'processing' } });
        }
        scheduleLiveReplayStop(replayId, egressId, now);
        return res.status(201).json({
          replay: { id: replayId, status: 'recording', startedAt: now, maxDurationSeconds: MAX_REPLAY_SECONDS },
        });
      }

      if (!egressId) {
        console.error('[live-replay] ambiguous Egress start retained for recovery', { replayId, message: error.message });
        return res.status(503).json({ error: 'Replay start is being reconciled; quota remains reserved safely' });
      }
    }
  } catch (error) {
    console.error('[live-replay] start request failed', { streamId, message: error.message });
    return res.status(500).json({ error: 'Could not start the replay recording' });
  }
});

router.post('/:streamId/replays/:replayId/stop', async (req, res) => {
  const { streamId, replayId } = req.params;
  if (!validId(streamId) || !validId(replayId)) return res.status(400).json({ error: 'Invalid replay' });
  try {
    const { data: replay, error } = await supabaseAdmin.from('live_stream_replays')
      .select('id,creator_id,egress_id,status').eq('id', replayId).eq('stream_id', streamId).maybeSingle();
    if (error) throw error;
    if (!replay) return res.status(404).json({ error: 'Replay not found' });
    if (replay.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can stop this recording' });
    if (!['starting', 'recording'].includes(replay.status)) return res.json({ replay: { id: replay.id, status: replay.status } });
    if (!replay.egress_id) return res.status(409).json({ error: 'Replay recording is still starting' });
    const egressConfig = getLiveKitEgressConfig();
    if (!egressConfig) return res.status(503).json({ error: 'Replay stop service is temporarily unavailable' });
    try {
      await stopEgress(replay.egress_id, egressConfig);
    } catch (error) {
      if (!error.message.includes('HTTP 404')) throw error;
    }
    await supabaseAdmin.from('live_stream_replays').update({ status: 'processing' }).eq('id', replay.id);
    clearLiveReplayStop(replay.id);
    return res.status(202).json({ replay: { id: replay.id, status: 'processing' } });
  } catch (error) {
    console.error('[live-replay] stop failed', { replayId, message: error.message });
    return res.status(502).json({ error: 'Could not stop the replay recording' });
  }
});

router.get('/replays', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data: readyRows, error: readyError } = await supabaseAdmin.from('live_stream_replays')
      .select('id,stream_id,creator_id,status,duration_seconds,file_size_bytes,completed_at,expires_at,stream:live_streams(id,creator_id,title,visibility,status)')
      .eq('status', 'ready').gt('expires_at', now)
      .order('completed_at', { ascending: false }).limit(20);
    if (readyError) throw readyError;
    const { data: ownerRows, error: ownerError } = await supabaseAdmin.from('live_stream_replays')
      .select('id,stream_id,creator_id,status,duration_seconds,file_size_bytes,completed_at,expires_at,stream:live_streams(id,creator_id,title,visibility,status)')
      .eq('creator_id', req.user.id).in('status', ['ready', 'starting', 'recording', 'processing', 'failed'])
      .order('created_at', { ascending: false }).limit(10);
    if (ownerError) throw ownerError;
    const byId = new Map([...(readyRows || []), ...(ownerRows || [])].map((row) => [row.id, row]));
    const visible = [];
    for (const replay of byId.values()) {
      if (replay.status === 'ready' && (!replay.expires_at || new Date(replay.expires_at).getTime() <= Date.now())) continue;
      if (replay.stream && await canViewLiveReplay(replay.stream, req.user.id)) {
        visible.push({
          id: replay.id,
          streamId: replay.stream_id,
          creatorId: replay.creator_id,
          status: replay.status,
          durationSeconds: replay.duration_seconds,
          fileSizeBytes: replay.file_size_bytes,
          completedAt: replay.completed_at,
          expiresAt: replay.expires_at,
          streamTitle: replay.stream.title,
          visibility: replay.stream.visibility,
        });
      }
    }
    return res.json({ replays: visible });
  } catch (error) {
    console.error('[live-replay] discovery failed', { message: error.message });
    return res.status(500).json({ error: 'Could not load LIVE replays' });
  }
});

router.get('/:streamId/replays', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream' });
  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (!await canViewLiveReplay(stream, req.user.id)) return res.status(403).json({ error: 'You cannot view this replay' });
    const isCreator = stream.creator_id === req.user.id;
    let query = supabaseAdmin.from('live_stream_replays')
      .select('id,stream_id,creator_id,status,duration_seconds,file_size_bytes,completed_at,expires_at,error_code')
      .eq('stream_id', streamId)
      .order('created_at', { ascending: false }).limit(10);
    query = isCreator
      ? query.in('status', ['ready', 'starting', 'recording', 'processing', 'failed'])
      : query.eq('status', 'ready').gt('expires_at', new Date().toISOString());
    const { data, error } = await query;
    if (error) throw error;
    const visible = (data || []).filter((item) => item.status !== 'ready' || (item.expires_at && new Date(item.expires_at).getTime() > Date.now()));
    return res.json({ replays: visible });
  } catch (error) {
    console.error('[live-replay] list failed', { streamId, message: error.message });
    return res.status(500).json({ error: 'Could not load replays' });
  }
});

router.get('/replays/:replayId/playback', async (req, res) => {
  const replayId = req.params.replayId;
  if (!validId(replayId)) return res.status(400).json({ error: 'Invalid replay' });
  try {
    const { data: replay, error } = await supabaseAdmin.from('live_stream_replays')
      .select('id,stream_id,creator_id,file_path,status,expires_at')
      .eq('id', replayId).maybeSingle();
    if (error) throw error;
    if (!replay || replay.status !== 'ready' || !replay.file_path || !replay.expires_at || new Date(replay.expires_at).getTime() <= Date.now()) {
      return res.status(404).json({ error: 'Replay is unavailable or has expired' });
    }
    const stream = await getStream(replay.stream_id);
    if (!stream || !await canViewLiveReplay(stream, req.user.id)) return res.status(403).json({ error: 'You cannot view this replay' });
    const { data, error: signedUrlError } = await supabaseAdmin.storage.from('live-replays').createSignedUrl(replay.file_path, 360);
    if (signedUrlError) throw signedUrlError;
    return res.json({ url: data.signedUrl, expiresInSeconds: 360 });
  } catch (error) {
    console.error('[live-replay] playback URL failed', { replayId, message: error.message });
    return res.status(500).json({ error: 'Could not create replay playback URL' });
  }
});

router.delete('/replays/:replayId', async (req, res) => {
  const replayId = req.params.replayId;
  if (!validId(replayId)) return res.status(400).json({ error: 'Invalid replay' });
  try {
    const { data: replay, error } = await supabaseAdmin.from('live_stream_replays')
      .select('id,creator_id,file_path,status').eq('id', replayId).maybeSingle();
    if (error) throw error;
    if (!replay) return res.status(404).json({ error: 'Replay not found' });
    if (replay.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can delete this replay' });
    if (['starting', 'recording', 'processing'].includes(replay.status)) return res.status(409).json({ error: 'Wait for the recording to finish before deleting it' });
    if (replay.file_path) {
      const { error: removeError } = await supabaseAdmin.storage.from('live-replays').remove([replay.file_path]);
      if (removeError) throw removeError;
    }
    const { error: updateError } = await supabaseAdmin.from('live_stream_replays')
      .update({
        status: 'deleted',
        file_path: null,
        file_size_bytes: 0,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .eq('id', replayId);
    if (updateError) throw updateError;
    return res.json({ deleted: true });
  } catch (error) {
    console.error('[live-replay] delete failed', { replayId, message: error.message });
    return res.status(500).json({ error: 'Could not delete replay' });
  }
});

router.post('/creators/:creatorId/follow', async (req, res) => {
  const creatorId = req.params.creatorId;
  if (!validId(creatorId) || creatorId === req.user.id) return res.status(400).json({ error: 'Invalid LIVE creator' });
  try {
    if (await hasBlockBetween(creatorId, req.user.id)) return res.status(403).json({ error: 'This creator is unavailable' });
    const { data: creator, error: creatorError } = await supabaseAdmin.from('profiles')
      .select('id').eq('id', creatorId).maybeSingle();
    if (creatorError) throw creatorError;
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    const { data: newFollow, error } = await supabaseAdmin.from('live_creator_follows').upsert(
      { follower_id: req.user.id, creator_id: creatorId }, { onConflict: 'follower_id,creator_id', ignoreDuplicates: true }
    ).select('follower_id').maybeSingle();
    if (error) throw error;
    if (newFollow) {
      const followerName = req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'A ZannyChat member';
      await notifyLiveUsers([creatorId], {
        title: 'New LIVE follower',
        body: followerName + ' started following your creator profile.',
        data: { type: 'live_creator_follow', creatorId, followerId: req.user.id },
      });
    }
    return res.json({ following: true, creatorId });
  } catch (error) {
    console.error('[live] follow failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not follow this creator' });
  }
});

router.delete('/creators/:creatorId/follow', async (req, res) => {
  const creatorId = req.params.creatorId;
  if (!validId(creatorId) || creatorId === req.user.id) return res.status(400).json({ error: 'Invalid LIVE creator' });
  try {
    const { error } = await supabaseAdmin.from('live_creator_follows')
      .delete().eq('follower_id', req.user.id).eq('creator_id', creatorId);
    if (error) throw error;
    return res.json({ following: false, creatorId });
  } catch (error) {
    console.error('[live] unfollow failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not unfollow this creator' });
  }
});

router.get('/following', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_follows')
      .select('creator_id,created_at').eq('follower_id', req.user.id)
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    const creatorIds = (data || []).map((row) => row.creator_id);
    const { data: profiles, error: profileError } = creatorIds.length
      ? await supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id', creatorIds)
      : { data: [], error: null };
    if (profileError) throw profileError;
    const profileById = new Map((profiles || []).map((profile) => [profile.id, profile]));
    const blockedIds = await getBlockedUserIds(req.user.id, creatorIds);
    return res.json({ following: (data || []).filter((row) => !blockedIds.has(row.creator_id)).map((row) => ({
      ...row, name: profileById.get(row.creator_id)?.name || 'ZannyChat creator',
      avatarColor: profileById.get(row.creator_id)?.avatar_color || null,
    })) });
  } catch (error) {
    console.error('[live] following list failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load followed creators' });
  }
});

router.get('/invite-candidates', async (req, res) => {
  try {
    const { data: memberships, error: membershipError } = await supabaseAdmin.from('conversation_participants')
      .select('conversation_id').eq('user_id', req.user.id).limit(500);
    if (membershipError) throw membershipError;
    const conversationIds = [...new Set((memberships || []).map((row) => row.conversation_id))];
    if (!conversationIds.length) return res.json({ candidates: [] });
    const { data: participants, error: participantError } = await supabaseAdmin.from('conversation_participants')
      .select('user_id').in('conversation_id', conversationIds).neq('user_id', req.user.id).limit(500);
    if (participantError) throw participantError;
    const candidateIds = [...new Set((participants || []).map((row) => row.user_id))];
    if (!candidateIds.length) return res.json({ candidates: [] });
    const blockedIds = await getBlockedUserIds(req.user.id, candidateIds);
    const visibleIds = candidateIds.filter((userId) => !blockedIds.has(userId));
    if (!visibleIds.length) return res.json({ candidates: [] });
    const { data: profiles, error: profileError } = await supabaseAdmin.from('profiles')
      .select('id,name,avatar_color').in('id', visibleIds).order('name', { ascending: true }).limit(100);
    if (profileError) throw profileError;
    return res.json({ candidates: profiles || [] });
  } catch (error) {
    console.error('[live] invite candidate lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load invite contacts' });
  }
});

router.get('/invitations', async (req, res) => {
  try {
    const { data: invites, error: inviteError } = await supabaseAdmin.from('live_stream_invites')
      .select('stream_id,invited_by,created_at').eq('user_id', req.user.id)
      .eq('invitation_type', 'viewer').eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(50);
    if (inviteError) throw inviteError;
    const streamIds = (invites || []).map((row) => row.stream_id);
    const { data: streams, error: streamError } = streamIds.length
      ? await supabaseAdmin.from('live_streams')
        .select('id,creator_id,title,description,allow_guests,visibility,status,started_at')
        .in('id', streamIds).eq('status', 'live')
      : { data: [], error: null };
    if (streamError) throw streamError;
    const streamById = new Map((streams || []).map((row) => [row.id, row]));
    const inviteRows = (invites || []).map((invite) => ({ ...invite, stream: streamById.get(invite.stream_id) || null }))
      .filter((invite) => invite.stream);
    const blockedIds = await getBlockedUserIds(req.user.id, inviteRows.map((invite) => invite.stream.creator_id));
    return res.json({ invitations: inviteRows.filter((invite) => !blockedIds.has(invite.stream.creator_id)) });
  } catch (error) {
    console.error('[live] invitation list failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE invitations' });
  }
});

router.get('/following/streams', async (req, res) => {
  try {
    const { data: follows, error: followError } = await supabaseAdmin.from('live_creator_follows')
      .select('creator_id').eq('follower_id', req.user.id).limit(500);
    if (followError) throw followError;
    const creatorIds = (follows || []).map((row) => row.creator_id);
    if (!creatorIds.length) return res.json({ streams: [] });
    const { data, error } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,title,description,visibility,allow_guests,started_at')
      .eq('status', 'live').in('visibility', ['public','followers'])
      .in('creator_id', creatorIds).order('started_at', { ascending: false }).limit(50);
    if (error) throw error;
    const blockedIds = await getBlockedUserIds(req.user.id, (data || []).map((stream) => stream.creator_id));
    const visible = (data || []).filter((stream) => !blockedIds.has(stream.creator_id))
      .map((stream) => ({ ...stream, is_creator: stream.creator_id === req.user.id }));
    return res.json({ streams: visible });
  } catch (error) {
    console.error('[live] followed stream discovery failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load followed creators' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,title,description,started_at,viewer_limit')
      .eq('status', 'live').eq('visibility', 'public')
      .order('started_at', { ascending: false }).limit(50);
    if (error) throw error;
    const blockedIds = await getBlockedUserIds(req.user.id, (data || []).map((stream) => stream.creator_id));
    const visible = (data || []).filter((stream) => !blockedIds.has(stream.creator_id))
      .map((stream) => ({ ...stream, is_creator: stream.creator_id === req.user.id }));
    return res.json({ streams: visible });
  } catch (error) {
    console.error('[live] discover failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE discovery is temporarily unavailable' });
  }
});

router.post('/', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const visibility = req.body?.visibility || 'public';
  const inviteeIds = Array.isArray(req.body?.inviteeIds) ? req.body.inviteeIds : [];
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'LIVE is not configured on this server. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the backend service.' });
  if (!title || title.length > 80 || description.length > 500) return res.status(400).json({ error: 'LIVE title or description is invalid' });
  if (!['public','followers','private'].includes(visibility)) return res.status(400).json({ error: 'Invalid LIVE visibility' });
  if (inviteeIds.length > 100 || inviteeIds.some((id) => !validId(id)) || new Set(inviteeIds).size !== inviteeIds.length) return res.status(400).json({ error: 'Invalid private LIVE invitees' });
  if (visibility === 'private' && inviteeIds.length === 0) return res.status(400).json({ error: 'Private LIVE requires at least one invitee' });
  if (visibility !== 'private' && inviteeIds.length > 0) return res.status(400).json({ error: 'Invitees are only valid for private LIVE' });
  const allowGuests = req.body?.allowGuests === true;
  try {
    const id = randomUUID();
    const roomName = 'zlive_' + id.replace(/-/g, '');
    const token = issueToken(req.user, roomName, config, true);
    const { data: stream, error } = await supabaseAdmin.rpc('create_live_stream', {
      p_stream_id: id,
      p_creator_id: req.user.id,
      p_title: title,
      p_description: description,
      p_room_name: roomName,
      p_visibility: visibility,
      p_allow_guests: allowGuests,
      p_invited_user_ids: inviteeIds,
    });
    if (error) throw error;
    const creatorName = req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'A ZannyChat creator';
    if (visibility === 'private') {
      await notifyLiveUsers(inviteeIds, {
        title: 'Private LIVE invitation',
        body: creatorName + ' invited you to join ' + title + '.',
        data: { type: 'live_invitation', streamId: id, creatorId: req.user.id },
      });
    } else {
      await notifyCreatorFollowers(req.user.id, {
        title: creatorName + ' is LIVE',
        body: title,
        data: { type: 'live_stream_started', streamId: id, creatorId: req.user.id },
      });
    }
    return res.status(201).json({
      stream, livekitUrl: config.url,
      token, role: 'creator', canModerate: true,
    });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'You already have an active LIVE stream' });
    if (error?.code === '42501') return res.status(403).json({ error: 'A blocked account cannot be invited to this LIVE stream' });
    if (error?.code === '22023' || error?.code === '23503') return res.status(400).json({ error: 'LIVE details or invitees are invalid' });
    console.error('[live] create failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not start LIVE right now' });
  }
});

router.post('/:streamId/join', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'LIVE streaming is not enabled on this server yet' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) {
      return res.status(403).json({ error: 'This LIVE stream is unavailable' });
    }
    const { data: role, error: joinError } = await supabaseAdmin.rpc('join_live_stream', {
      p_stream_id: streamId, p_user_id: req.user.id,
    });
    if (joinError) {
      if (joinError.code === 'P0001' && /full/i.test(joinError.message || '')) return res.status(409).json({ error: 'This LIVE audience is full' });
      if (joinError.code === '42501') return res.status(403).json({ error: 'This LIVE stream is not publicly available' });
      if (joinError.code === 'P0001') return res.status(404).json({ error: 'LIVE stream has ended' });
      throw joinError;
    }
    const canPublish = role === 'creator' || role === 'guest';
    const token = issueToken(req.user, stream.room_name, config, canPublish);
    const canModerate = await canModerateLive(stream, req.user.id);
    return res.json({
      stream, livekitUrl: config.url,
      token, role, canPublish, canModerate,
    });
  } catch (error) {
    console.error('[live] join failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not join this LIVE stream' });
  }
});

router.post('/:streamId/invites', async (req, res) => {
  const streamId = req.params.streamId;
  const userIds = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.filter(validId))] : [];
  if (!validId(streamId) || userIds.length < 1 || userIds.length > 100) {
    return res.status(400).json({ error: 'Provide between 1 and 100 valid invitees' });
  }
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can invite viewers' });
    if (stream.visibility !== 'private') return res.status(409).json({ error: 'Invitations are only required for private LIVE streams' });
    const invitees = userIds.filter((id) => id !== req.user.id);
    if (!invitees.length) return res.status(400).json({ error: 'At least one invitee other than the creator is required' });
    const blockedInvitees = await getBlockedUserIds(stream.creator_id, invitees);
    if (blockedInvitees.size) return res.status(403).json({ error: 'A blocked account cannot be invited' });
    const { data: profiles, error: profileError } = await supabaseAdmin.from('profiles')
      .select('id').in('id', invitees);
    if (profileError) throw profileError;
    const existing = new Set((profiles || []).map((row) => row.id));
    if (invitees.some((id) => !existing.has(id))) return res.status(404).json({ error: 'One or more invitees do not exist' });
    const rows = invitees.map((userId) => ({
      stream_id: streamId, user_id: userId, invited_by: req.user.id,
      invitation_type: 'viewer', status: 'pending', requested_by: null,
    }));
    const { error } = await supabaseAdmin.from('live_stream_invites').upsert(rows, { onConflict: 'stream_id,user_id,invitation_type' });
    if (error) throw error;
    const creatorName = req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'A ZannyChat creator';
    await notifyLiveUsers(invitees, {
      title: 'Private LIVE invitation',
      body: creatorName + ' invited you to join ' + stream.title + '.',
      data: { type: 'live_invitation', streamId, creatorId: req.user.id },
    });
    return res.json({ invited: invitees.length });
  } catch (error) {
    console.error('[live] invite creation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not invite viewers to this LIVE stream' });
  }
});

router.get('/:streamId/guest-status', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const { data, error } = await supabaseAdmin.from('live_stream_invites')
      .select('status').eq('stream_id', streamId).eq('user_id', req.user.id)
      .eq('invitation_type', 'guest').maybeSingle();
    if (error) throw error;
    return res.json({ status: data?.status || 'none' });
  } catch (error) {
    console.error('[live] guest status fetch failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not check guest request status' });
  }
});

router.post('/:streamId/guest-requests', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (!stream.allow_guests) return res.status(409).json({ error: 'Guest participation is disabled for this LIVE stream' });
    const participant = await requireJoined(streamId, req.user.id);
    if (!participant || participant.role !== 'viewer') return res.status(403).json({ error: 'Only a joined viewer can request guest access' });
    if (stream.creator_id === req.user.id) return res.status(400).json({ error: 'The creator is already a publisher' });
    if (await hasBlockBetween(stream.creator_id, req.user.id)) return res.status(403).json({ error: 'Guest access is unavailable' });
    const { error } = await supabaseAdmin.from('live_stream_invites').upsert({
      stream_id: streamId, user_id: req.user.id, invited_by: stream.creator_id,
      requested_by: req.user.id, invitation_type: 'guest', status: 'requested',
    }, { onConflict: 'stream_id,user_id,invitation_type' });
    if (error) throw error;
    const requesterName = req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'A LIVE viewer';
    await notifyLiveUsers([stream.creator_id], {
      title: 'LIVE guest request',
      body: requesterName + ' requested to join your LIVE as a guest.',
      data: { type: 'live_guest_request', streamId, requesterId: req.user.id },
    });
    return res.status(202).json({ requested: true });
  } catch (error) {
    console.error('[live] guest request failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not request guest access' });
  }
});

router.get('/:streamId/guest-requests', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can review guest requests' });
    const { data, error } = await supabaseAdmin.from('live_stream_invites')
      .select('user_id,requested_by,status,created_at')
      .eq('stream_id', streamId).eq('invitation_type', 'guest').eq('status', 'requested')
      .order('created_at', { ascending: true }).limit(100);
    if (error) throw error;
    const userIds = (data || []).map((row) => row.user_id);
    const { data: profiles, error: profileError } = userIds.length
      ? await supabaseAdmin.from('profiles').select('id,name').in('id', userIds)
      : { data: [], error: null };
    if (profileError) throw profileError;
    const names = new Map((profiles || []).map((row) => [row.id, row.name]));
    return res.json({ requests: (data || []).map((row) => ({ ...row, name: names.get(row.user_id) || 'ZannyChat user' })) });
  } catch (error) {
    console.error('[live] guest request list failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load guest requests' });
  }
});

router.patch('/:streamId/guest-requests/:userId', async (req, res) => {
  const { streamId, userId } = req.params;
  const status = req.body?.status;
  if (!validId(streamId) || !validId(userId) || !['accepted','declined'].includes(status)) {
    return res.status(400).json({ error: 'Invalid guest request decision' });
  }
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can approve guest requests' });
    if (!stream.allow_guests) return res.status(409).json({ error: 'Guest participation is disabled' });
    if (await hasBlockBetween(stream.creator_id, userId)) return res.status(403).json({ error: 'Guest access is unavailable' });
    const participant = await requireJoined(streamId, userId);
    if (!participant || participant.role !== 'viewer') return res.status(409).json({ error: 'The requester is no longer a joined viewer' });
    const { data, error } = await supabaseAdmin.from('live_stream_invites')
      .update({ status, invited_by: req.user.id, updated_at: new Date().toISOString() })
      .eq('stream_id', streamId).eq('user_id', userId)
      .eq('invitation_type', 'guest').eq('status', 'requested')
      .select('user_id,status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pending guest request not found' });
    await notifyLiveUsers([userId], {
      title: status === 'accepted' ? 'You can join as a LIVE guest' : 'LIVE guest request update',
      body: status === 'accepted'
        ? 'The creator approved your guest request. You can now join the LIVE as a guest.'
        : 'The creator declined your request to join the LIVE as a guest.',
      data: { type: 'live_guest_decision', streamId, creatorId: req.user.id, status },
    });
    return res.json({ request: data });
  } catch (error) {
    console.error('[live] guest request decision failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not update guest request' });
  }
});

router.post('/:streamId/leave', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const { data: left, error } = await supabaseAdmin.rpc('leave_live_stream', {
      p_stream_id: streamId, p_user_id: req.user.id,
    });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: 'The creator must end this LIVE stream' });
      throw error;
    }
    return res.json({ left: left === true });
  } catch (error) {
    console.error('[live] leave failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not leave LIVE stream' });
  }
});

router.get('/:streamId/comments', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (!await requireJoined(streamId, req.user.id)) return res.status(403).json({ error: 'Join this LIVE stream before reading comments' });
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) {
      return res.status(403).json({ error: 'This LIVE stream is unavailable' });
    }
    const { data, error } = await supabaseAdmin.from('live_stream_comments')
      .select('id,stream_id,user_id,body,moderation_status,created_at')
      .eq('stream_id', streamId).eq('moderation_status', 'visible')
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    const ordered = (data || []).reverse();
    const names = await getProfileNames(ordered.map((comment) => comment.user_id));
    const comments = ordered.map((row) => {
      const { user_id: _userId, ...comment } = row;
      return { ...comment, user_name: names.get(_userId) || 'ZannyChat user' };
    });
    const reactionSince = new Date(Date.now() - 12 * 1000).toISOString();
    const { data: recentReactions, error: reactionError } = await supabaseAdmin.from('live_stream_reactions')
      .select('id,reaction,created_at')
      .eq('stream_id', streamId)
      .gt('created_at', reactionSince)
      .order('created_at', { ascending: true })
      .limit(100);
    if (reactionError) throw reactionError;
    return res.json({ comments, reactions: recentReactions || [] });
  } catch (error) {
    console.error('[live] comments fetch failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE comments' });
  }
});

router.post('/:streamId/comment', makeLimiter({ windowMs: 10 * 1000, max: 5, error: 'Please slow down before posting another LIVE comment.' }), async (req, res) => {
  const streamId = req.params.streamId;
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  if (!body || body.length > 500) return res.status(400).json({ error: 'Comment must contain 1 to 500 characters' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (!stream.allow_comments) return res.status(403).json({ error: 'Comments are disabled for this LIVE stream' });
    if (!await requireJoined(streamId, req.user.id)) return res.status(403).json({ error: 'Join this LIVE stream before commenting' });
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) return res.status(403).json({ error: 'Comments are unavailable' });
    const { data, error } = await supabaseAdmin.from('live_stream_comments').insert({
      stream_id: streamId, user_id: req.user.id, body,
    }).select('id,stream_id,user_id,body,moderation_status,created_at').single();
    if (error) throw error;
    const names = await getProfileNames([req.user.id]);
    const { user_id: _userId, ...comment } = data;
    return res.status(201).json({
      comment: { ...comment, user_name: names.get(_userId) || 'ZannyChat user' },
    });
  } catch (error) {
    console.error('[live] comment failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not post LIVE comment' });
  }
});

router.post('/:streamId/comments/:commentId/hide', async (req, res) => {
  const { streamId, commentId } = req.params;
  if (!validId(streamId) || !validId(commentId)) return res.status(400).json({ error: 'Invalid LIVE comment reference' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (!await canModerateLive(stream, req.user.id)) return res.status(403).json({ error: 'Only the creator or an appointed LIVE moderator can moderate comments' });
    const { data, error } = await supabaseAdmin.from('live_stream_comments')
      .update({ moderation_status: 'hidden' })
      .eq('id', commentId).eq('stream_id', streamId)
      .select('id,moderation_status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'LIVE comment not found' });
    return res.json({ hidden: true, comment: data });
  } catch (error) {
    console.error('[live] comment moderation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not moderate LIVE comment' });
  }
});

router.get('/creators/:creatorId/impact', async (req, res) => {
  const creatorId = req.params.creatorId;
  if (!validId(creatorId)) return res.status(400).json({ error: 'Invalid creator id' });
  try {
    if (!await canViewCreatorImpact(req.user.id, creatorId)) {
      return res.status(404).json({ error: 'Creator impact is unavailable' });
    }
    const { data, error } = await supabaseAdmin.from('live_creator_impact')
      .select('impact_score,total_reactions,unique_supporters,updated_at')
      .eq('creator_id', creatorId).maybeSingle();
    if (error) throw error;
    const impactScore = Number(data?.impact_score || 0);
    const badges = [
      { threshold: 10, id: 'first-spark', label: 'First Spark' },
      { threshold: 50, id: 'community-favorite', label: 'Community Favorite' },
      { threshold: 250, id: 'stage-star', label: 'Stage Star' },
      { threshold: 1000, id: 'iconic-voice', label: 'Iconic Voice' },
    ].filter((badge) => impactScore >= badge.threshold).map(({ id, label }) => ({ id, label }));
    return res.json({
      impact: {
        impactScore,
        totalReactions: Number(data?.total_reactions || 0),
        uniqueSupporters: Number(data?.unique_supporters || 0),
        badges,
        updatedAt: data?.updated_at || null,
      },
    });
  } catch (error) {
    console.error('[live] creator impact lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'Creator impact is temporarily unavailable' });
  }
});

router.post('/:streamId/react', makeLimiter({ windowMs: 10 * 1000, max: 8, error: 'Please slow down before sending another LIVE reaction.' }), async (req, res) => {
  const streamId = req.params.streamId;
  const reaction = req.body?.reaction;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  if (!REACTIONS.has(reaction)) return res.status(400).json({ error: 'Unsupported LIVE reaction' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id && await hasBlockBetween(stream.creator_id, req.user.id)) {
      return res.status(403).json({ error: 'Reactions are unavailable' });
    }
    if (!await requireJoined(streamId, req.user.id)) return res.status(403).json({ error: 'Join this LIVE stream before reacting' });
    const { data: impactRows, error } = await supabaseAdmin.rpc('record_live_creator_impact', {
      p_stream_id: streamId,
      p_user_id: req.user.id,
      p_reaction: reaction,
    });
    if (error) throw error;
    const impact = Array.isArray(impactRows) ? impactRows[0] : null;
    return res.status(201).json({ accepted: true, impact });
  } catch (error) {
    console.error('[live] reaction failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not send LIVE reaction' });
  }
});


router.get('/:streamId/participants', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can manage LIVE participants' });
    const { data: joined, error: joinedError } = await supabaseAdmin.from('live_stream_participants')
      .select('user_id,joined_at').eq('stream_id', streamId).eq('role', 'viewer').eq('status', 'joined')
      .order('joined_at', { ascending: true }).limit(500);
    if (joinedError) throw joinedError;
    const { data: moderators, error: moderatorsError } = await supabaseAdmin.from('live_stream_moderators')
      .select('user_id').eq('stream_id', streamId);
    if (moderatorsError) throw moderatorsError;
    const joinedById = new Map((joined || []).map((row) => [row.user_id, row]));
    const moderatorIds = new Set((moderators || []).map((row) => row.user_id));
    const userIds = [...new Set([...joinedById.keys(), ...moderatorIds])];
    const { data: profiles, error: profilesError } = userIds.length
      ? await supabaseAdmin.from('profiles').select('id,name').in('id', userIds)
      : { data: [], error: null };
    if (profilesError) throw profilesError;
    const names = new Map((profiles || []).map((row) => [row.id, row.name]));
    return res.json({ participants: userIds.map((userId) => ({
      userId, name: names.get(userId) || 'ZannyChat user',
      joinedAt: joinedById.get(userId)?.joined_at || null,
      joined: joinedById.has(userId), moderator: moderatorIds.has(userId),
    })) });
  } catch (error) {
    console.error('[live] participants fetch failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE participants' });
  }
});

router.post('/:streamId/moderators', async (req, res) => {
  const streamId = req.params.streamId;
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!validId(streamId) || !validId(userId)) return res.status(400).json({ error: 'Invalid LIVE moderator reference' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can appoint LIVE moderators' });
    if (userId === stream.creator_id) return res.status(400).json({ error: 'The creator is already the stream administrator' });
    const participant = await requireJoined(streamId, userId);
    if (!participant || participant.role !== 'viewer') return res.status(400).json({ error: 'Only a joined viewer can be appointed as a LIVE moderator' });
    const { error } = await supabaseAdmin.from('live_stream_moderators').upsert({
      stream_id: streamId, user_id: userId, appointed_by: req.user.id,
    }, { onConflict: 'stream_id,user_id', ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ userId, moderator: true });
  } catch (error) {
    console.error('[live] moderator appointment failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not appoint LIVE moderator' });
  }
});

router.delete('/:streamId/moderators/:userId', async (req, res) => {
  const { streamId, userId } = req.params;
  if (!validId(streamId) || !validId(userId)) return res.status(400).json({ error: 'Invalid LIVE moderator reference' });
  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can remove LIVE moderators' });
    const { error } = await supabaseAdmin.from('live_stream_moderators')
      .delete().eq('stream_id', streamId).eq('user_id', userId);
    if (error) throw error;
    return res.json({ userId, moderator: false });
  } catch (error) {
    console.error('[live] moderator removal failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not remove LIVE moderator' });
  }
});

router.get('/:streamId/reports', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (!await canModerateLive(stream, req.user.id)) return res.status(403).json({ error: 'Only the creator or appointed LIVE moderators can review reports' });
    const { data, error } = await supabaseAdmin.from('live_stream_reports')
      .select('id,stream_id,reporter_id,reason,details,status,created_at,reviewed_by,reviewed_at')
      .eq('stream_id', streamId)
      .order('created_at', { ascending: true }).limit(100);
    if (error) throw error;
    return res.json({ reports: data || [] });
  } catch (error) {
    console.error('[live] report queue failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE reports' });
  }
});

router.patch('/:streamId/reports/:reportId', async (req, res) => {
  const { streamId, reportId } = req.params;
  const status = req.body?.status;
  if (!validId(streamId) || !validId(reportId)) return res.status(400).json({ error: 'Invalid LIVE report reference' });
  if (!['reviewing','resolved','dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid LIVE report status' });
  try {
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (!await canModerateLive(stream, req.user.id)) return res.status(403).json({ error: 'Only the creator or appointed LIVE moderators can review reports' });
    const reviewedAt = status === 'reviewing' ? null : new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('live_stream_reports').update({
      status, reviewed_by: req.user.id, reviewed_at: reviewedAt,
    }).eq('stream_id', streamId).eq('id', reportId).in('status', ['open','reviewing'])
      .select('id,status,reviewed_by,reviewed_at').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Open or reviewing LIVE report not found' });
    return res.json({ report: data });
  } catch (error) {
    console.error('[live] report review failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not update LIVE report' });
  }
});

router.post('/:streamId/report', async (req, res) => {
  const streamId = req.params.streamId;
  const reason = req.body?.reason;
  const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  if (!REASONS.has(reason) || details.length > 1000) return res.status(400).json({ error: 'Invalid LIVE report' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id === req.user.id) return res.status(400).json({ error: 'Creators cannot report their own LIVE stream' });
    const { error } = await supabaseAdmin.from('live_stream_reports').upsert({
      stream_id: streamId, reporter_id: req.user.id, reason, details,
    }, { onConflict: 'stream_id,reporter_id' });
    if (error) throw error;
    return res.status(201).json({ reported: true });
  } catch (error) {
    console.error('[live] report failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not submit LIVE report' });
  }
});

router.post('/:streamId/end', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    await stopActiveLiveReplayForStream(streamId).catch((error) => {
      console.error('[live-replay] stop on stream end failed', { streamId, message: error.message });
    });
    const { data: ended, error } = await supabaseAdmin.rpc('end_live_stream', {
      p_stream_id: streamId, p_creator_id: req.user.id,
    });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: 'Only the creator can end this LIVE stream' });
      throw error;
    }
    if (!ended) return res.status(404).json({ error: 'LIVE stream has ended' });
    return res.json({ ended: true });
  } catch (error) {
    console.error('[live] end failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not end LIVE stream' });
  }
});

module.exports = router;
