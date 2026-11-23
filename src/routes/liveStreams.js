const express = require('express');
const { randomUUID } = require('node:crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { createLiveKitToken, getLiveKitConfig } = require('../services/livekitToken');
const { listRoomParticipants, removeRoomParticipant, muteRoomParticipantTrack, updateRoomParticipantAttributes, updateRoomParticipantPermissions, deleteLiveKitRoom, sendRoomData } = require('../services/livekitRoomAdmin');
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
  validateReplayCredentials,
} = require('../services/livekitEgress');
const { scheduleLiveReplayStop, clearLiveReplayStop } = require('../jobs/liveReplayWorker');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 90, error: 'LIVE actions are rate-limited.' }));

const MAX_LIVE_STAGE_GUESTS = 5;
const replayConfigValidationLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000,
  max: 3,
  error: 'Replay configuration checks are rate-limited.',
});
const REASONS = new Set(['harassment','hate','nudity','violence','spam','copyright','other']);
const REACTIONS = new Set(['heart','clap','laugh','wow','fire','idea','support']);
const LIVE_EXPERIENCE_MODES = new Set(['broadcast', 'video_chat', 'audio_room']);
const LIVE_CATEGORIES = new Set(['entertainment', 'social', 'politics', 'science', 'education', 'finance', 'technology', 'sports', 'business', 'health', 'other']);

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function issueToken(user, roomName, config, canPublish, audioOnly = false) {
  return createLiveKitToken({
    identity: user.id,
    name: user.user_metadata?.name || user.user_metadata?.full_name || 'ZannyChat viewer',
    room: roomName,
    canPublish,
    canSubscribe: true,
    canPublishData: false,
    // Five-minute LIVE tokens fit inside LiveKit Cloud's 10-minute revocation window.
    // Connected participants receive refreshed tokens and are not disconnected by expiry.
    ttlSeconds: 300,
    ...(canPublish && audioOnly ? { canPublishSources: ['microphone'] } : {}),
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
  if (visibility === 'everyone') return true;
  if (visibility !== 'contacts') return false;
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


function publishLiveFeedChanged(stream) {
  if (!stream?.room_name) return;
  // The packet is only an invalidation signal. Clients re-fetch through the
  // authenticated API, which applies per-viewer block and moderation filters.
  void sendRoomData(stream.room_name, { v: 1, type: 'feed_changed' }).catch((error) => {
    console.error('[live] room feed notification failed:', error?.message || error);
  });
}

async function getStream(streamId) {
  const { data, error } = await supabaseAdmin.from('live_streams')
    .select('id,creator_id,title,description,room_name,visibility,status,allow_comments,allow_guests,viewer_limit,started_at,experience_mode,category')
    .eq('id', streamId).maybeSingle();
  if (error) throw error;
  return data;
}

async function canViewLiveReplay(stream, userId) {
  if (stream.creator_id === userId) return true;
  if (await hasBlockBetween(stream.creator_id, userId)) return false;

  // A creator-removed participant is blocked from rejoining the room; carry
  // that same explicit revocation into replay discovery and signed playback.
  const { data: participant, error: participantError } = await supabaseAdmin.from('live_stream_participants')
    .select('id,status').eq('stream_id', stream.id).eq('user_id', userId).maybeSingle();
  if (participantError) throw participantError;
  if (participant?.status === 'blocked') return false;
  if (participant) return true;
  if (await canModerateLive(stream, userId)) return true;
  if (stream.visibility === 'public') return true;
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
    .select('id,role,status,left_at').eq('stream_id', streamId).eq('user_id', userId)
    .eq('status', 'joined').is('left_at', null).maybeSingle();
  if (error) throw error;
  return data || null;
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

// Read-only check: ListEgress + S3 ListObjectsV2. This never starts a recording,
// uploads an object, or returns secret values.
router.post('/replays/config/validate', replayConfigValidationLimiter, async (req, res) => {
  const replayConfig = getLiveReplayConfig();
  const missing = [];
  if (!getLiveKitConfig()) missing.push('LIVEKIT_URL and LiveKit API credentials');
  if (!getLiveKitEgressConfig()) missing.push('LIVEKIT_EGRESS_API_KEY and LIVEKIT_EGRESS_API_SECRET');

  let storageEndpointValid = false;
  try {
    const endpoint = new URL(String(process.env.SUPABASE_STORAGE_S3_ENDPOINT || '').trim());
    storageEndpointValid = endpoint.protocol === 'https:' &&
      endpoint.hostname.endsWith('.storage.supabase.co') &&
      endpoint.pathname.replace(/\/$/, '') === '/storage/v1/s3';
  } catch {}
  if (!storageEndpointValid) missing.push('SUPABASE_STORAGE_S3_ENDPOINT');
  if (!String(process.env.SUPABASE_STORAGE_S3_ACCESS_KEY_ID || '').trim()) missing.push('SUPABASE_STORAGE_S3_ACCESS_KEY_ID');
  if (!String(process.env.SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY || '').trim()) missing.push('SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY');
  if (!String(process.env.SUPABASE_STORAGE_S3_REGION || '').trim()) missing.push('SUPABASE_STORAGE_S3_REGION');

  let webhookValid = false;
  try {
    const webhook = new URL(String(process.env.LIVEKIT_REPLAY_WEBHOOK_URL || '').trim());
    webhookValid = webhook.protocol === 'https:' && webhook.pathname.endsWith('/webhooks/livekit/egress');
  } catch {}
  if (!webhookValid) missing.push('LIVEKIT_REPLAY_WEBHOOK_URL');
  if (!replayConfig) {
    // Avoid duplicate diagnostics when one of the individually checked values is missing.
    if (!missing.length) missing.push('Replay configuration is incomplete');
  }

  const missingFlags = [];
  if (process.env.LIVEKIT_REPLAY_ENABLED !== 'true') missingFlags.push('LIVEKIT_REPLAY_ENABLED=true');
  if (process.env.LIVEKIT_REPLAY_BUILD_PLAN_CONFIRMED !== 'true') missingFlags.push('LIVEKIT_REPLAY_BUILD_PLAN_CONFIRMED=true');

  if (missing.length) {
    return res.status(503).json({ valid: false, configured: false, replayEnabled: false, missing, missingFlags });
  }

  try {
    const validation = await validateReplayCredentials(replayConfig);
    return res.json({
      valid: true,
      configured: true,
      replayEnabled: isLiveReplayEnabled(),
      missingFlags,
      ...validation,
    });
  } catch (error) {
    return res.status(503).json({
      valid: false,
      configured: true,
      replayEnabled: false,
      missingFlags,
      error: 'Credential verification failed. Check the Render environment values; secret values are never returned.',
    });
  }
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
      try {
        await supabaseAdmin.rpc('finalize_live_replay_quota', {
          p_replay_id: replayId, p_actual_seconds: 0, p_success: false,
        });
      } catch {
        // Best-effort quota cleanup must not mask the original reservation error.
      }
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
    const { data, error: signedUrlError } = await supabaseAdmin.storage.from('live-replays').createSignedUrl(replay.file_path, MAX_REPLAY_SECONDS + 600);
    if (signedUrlError) throw signedUrlError;
    return res.json({ url: data.signedUrl, expiresInSeconds: MAX_REPLAY_SECONDS + 600 });
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
    if (['failed', 'deleted'].includes(replay.status)) {
      const { error: quotaError } = await supabaseAdmin.rpc('finalize_live_replay_quota', {
        p_replay_id: replay.id,
        p_actual_seconds: 0,
        p_success: false,
      });
      if (quotaError) throw quotaError;
    }
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

router.get('/leaderboard', async (req, res) => {
  const period = String(req.query.period || 'all_time').trim().toLowerCase();
  if (period !== 'all_time') {
    return res.status(400).json({ error: 'Only all-time LIVE rankings are currently available.' });
  }
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 20;

  try {
    const { data: impactRows, error: impactError } = await supabaseAdmin
      .from('live_creator_impact')
      .select('creator_id,impact_score,total_reactions,unique_supporters,updated_at')
      .order('impact_score', { ascending: false })
      .order('total_reactions', { ascending: false })
      .order('unique_supporters', { ascending: false })
      .order('creator_id', { ascending: true })
      .limit(200);
    if (impactError) throw impactError;

    const candidates = impactRows || [];
    const creatorIds = [...new Set(candidates.map((row) => row.creator_id).filter(validId))];
    if (!creatorIds.length) {
      return res.json({ period, entries: [], generatedAt: new Date().toISOString() });
    }

    const [profilesResult, detailsResult, blockedIds] = await Promise.all([
      supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id', creatorIds),
      supabaseAdmin.from('profile_details').select('user_id,profile_visibility').in('user_id', creatorIds),
      getBlockedUserIds(req.user.id, creatorIds),
    ]);
    if (profilesResult.error || detailsResult.error) throw profilesResult.error || detailsResult.error;

    const profilesById = new Map((profilesResult.data || []).map((profile) => [profile.id, profile]));
    const visibilityById = new Map((detailsResult.data || []).map((details) => [details.user_id, details.profile_visibility]));
    const entries = candidates
      .filter((row) => {
        const profile = profilesById.get(row.creator_id);
        const visibility = visibilityById.get(row.creator_id) || 'everyone';
        return Boolean(profile) && visibility === 'everyone' && !blockedIds.has(row.creator_id);
      })
      .slice(0, limit)
      .map((row, index) => {
        const profile = profilesById.get(row.creator_id);
        return {
          rank: index + 1,
          creatorId: row.creator_id,
          name: profile.name || 'LIVE Creator',
          avatarColor: profile.avatar_color || null,
          impactScore: Number(row.impact_score || 0),
          totalReactions: Number(row.total_reactions || 0),
          uniqueSupporters: Number(row.unique_supporters || 0),
          updatedAt: row.updated_at || null,
        };
      });

    return res.json({ period, entries, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[live-leaderboard] load failed:', error.message);
    return res.status(500).json({ error: 'Could not load the LIVE leaderboard.' });
  }
});

router.get('/creators/me/preferences', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_preferences')
      .select('experience_mode,visibility,category,allow_guests,updated_at')
      .eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    return res.json({
      preferences: data ? {
        experienceMode: data.experience_mode,
        visibility: data.visibility,
        category: data.category,
        allowGuests: data.allow_guests,
        updatedAt: data.updated_at,
      } : {
        experienceMode: 'broadcast',
        visibility: 'public',
        category: 'social',
        allowGuests: false,
        updatedAt: null,
      },
    });
  } catch (error) {
    console.error('[live] creator preferences load failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load LIVE creator preferences' });
  }
});

router.put('/creators/me/preferences', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { experienceMode, visibility, category, allowGuests } = body;
  const allowedKeys = new Set(['experienceMode', 'visibility', 'category', 'allowGuests']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))
      || !LIVE_EXPERIENCE_MODES.has(experienceMode)
      || !['public', 'followers', 'private'].includes(visibility)
      || !LIVE_CATEGORIES.has(category)
      || typeof allowGuests !== 'boolean') {
    return res.status(400).json({ error: 'Invalid LIVE creator preferences' });
  }
  try {
    const { data, error } = await supabaseAdmin.from('live_creator_preferences').upsert({
      user_id: req.user.id,
      experience_mode: experienceMode,
      visibility,
      category,
      allow_guests: allowGuests,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
      .select('experience_mode,visibility,category,allow_guests,updated_at').single();
    if (error) throw error;
    return res.json({
      preferences: {
        experienceMode: data.experience_mode,
        visibility: data.visibility,
        category: data.category,
        allowGuests: data.allow_guests,
        updatedAt: data.updated_at,
      },
    });
  } catch (error) {
    console.error('[live] creator preferences save failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not save LIVE creator preferences' });
  }
});

router.get('/creators/me/profile', async (req, res) => {
  const creatorId = req.user.id;
  try {
    const [profileResult, impactResult, followerResult, streamResult, replayResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('id,name,avatar_color').eq('id', creatorId).maybeSingle(),
      supabaseAdmin.from('live_creator_impact').select('impact_score,total_reactions,unique_supporters,updated_at').eq('creator_id', creatorId).maybeSingle(),
      supabaseAdmin.from('live_creator_follows').select('follower_id', { count: 'exact', head: true }).eq('creator_id', creatorId),
      supabaseAdmin.from('live_streams').select('id,status,started_at,title', { count: 'exact' }).eq('creator_id', creatorId).order('started_at', { ascending: false }).limit(100),
      supabaseAdmin.from('live_stream_replays').select('id,status,duration_seconds,file_size_bytes,completed_at,stream_id', { count: 'exact' }).eq('creator_id', creatorId).neq('status', 'deleted').order('created_at', { ascending: false }).limit(100),
    ]);
    for (const result of [profileResult, impactResult, followerResult, streamResult, replayResult]) {
      if (result.error) throw result.error;
    }
    const streams = streamResult.data || [];
    const replays = replayResult.data || [];
    return res.json({
      profile: profileResult.data || { id: creatorId, name: req.user.user_metadata?.name || 'LIVE Creator', avatar_color: null },
      impact: impactResult.data || { impact_score: 0, total_reactions: 0, unique_supporters: 0 },
      followers: followerResult.count || 0,
      streams: {
        total: streamResult.count ?? streams.length,
        liveNow: streams.filter((row) => row.status === 'live').length,
        recent: streams.map(({ id, title, status, started_at }) => ({ id, title, status, started_at })),
      },
      replays: {
        total: replayResult.count ?? replays.length,
        ready: replays.filter((row) => row.status === 'ready').length,
        processing: replays.filter((row) => ['starting', 'recording', 'processing'].includes(row.status)).length,
        recent: replays.map(({ id, status, duration_seconds, completed_at, stream_id }) => ({ id, status, duration_seconds, completed_at, stream_id })),
      },
    });
  } catch (error) {
    console.error('[live] creator profile summary failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load your LIVE creator profile' });
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
    const { data: rawInvites, error: inviteError } = await supabaseAdmin.from('live_stream_invites')
      .select('stream_id,invited_by,created_at,invitation_type,status').eq('user_id', req.user.id)
      .in('invitation_type', ['viewer','guest']).in('status', ['pending','accepted'])
      .order('created_at', { ascending: false }).limit(100);
    if (inviteError) throw inviteError;
    const preferredInvites = new Map();
    for (const invite of (rawInvites || []).filter((row) =>
      (row.invitation_type === 'viewer' && row.status === 'pending')
      || (row.invitation_type === 'guest' && row.status === 'accepted'))) {
      const current = preferredInvites.get(invite.stream_id);
      if (!current || invite.invitation_type === 'guest') preferredInvites.set(invite.stream_id, invite);
    }
    const invites = [...preferredInvites.values()];
    const streamIds = invites.map((row) => row.stream_id);
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
    const [blockedIds, feedbackResult] = await Promise.all([
      getBlockedUserIds(req.user.id, (data || []).map((stream) => stream.creator_id)),
      supabaseAdmin.from('live_stream_feedback')
        .select('creator_id').eq('user_id', req.user.id).eq('feedback_type', 'not_interested'),
    ]);
    if (feedbackResult.error) throw feedbackResult.error;
    const notInterestedIds = new Set((feedbackResult.data || []).map((row) => row.creator_id));
    const visible = (data || []).filter((stream) => !blockedIds.has(stream.creator_id) && !notInterestedIds.has(stream.creator_id))
      .map((stream) => ({ ...stream, is_creator: stream.creator_id === req.user.id }));
    const creatorNames = await getProfileNames(visible.map((stream) => stream.creator_id));
    return res.json({ streams: visible.map((stream) => ({
      ...stream, creator_name: creatorNames.get(stream.creator_id) || 'ZannyChat creator',
    })) });
  } catch (error) {
    console.error('[live] followed stream discovery failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not load followed creators' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('live_streams')
      .select('id,creator_id,title,description,visibility,started_at,viewer_limit')
      .eq('status', 'live').eq('visibility', 'public')
      .order('started_at', { ascending: false }).limit(50);
    if (error) throw error;
    const blockedIds = await getBlockedUserIds(req.user.id, (data || []).map((stream) => stream.creator_id));
    const visible = (data || []).filter((stream) => !blockedIds.has(stream.creator_id))
      .map((stream) => ({ ...stream, is_creator: stream.creator_id === req.user.id }));
    const creatorNames = await getProfileNames(visible.map((stream) => stream.creator_id));
    return res.json({ streams: visible.map((stream) => ({
      ...stream, creator_name: creatorNames.get(stream.creator_id) || 'ZannyChat creator',
    })) });
  } catch (error) {
    console.error('[live] discover failed:', error?.message || error);
    return res.status(503).json({ error: 'LIVE discovery is temporarily unavailable' });
  }
});

router.post('/', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const visibility = req.body?.visibility || 'public';
  const experienceMode = req.body?.experienceMode || 'broadcast';
  const category = req.body?.category || 'social';
  const inviteeIds = Array.isArray(req.body?.inviteeIds) ? req.body.inviteeIds : [];
  const config = getLiveKitConfig();
  if (!config) return res.status(503).json({ error: 'LIVE is not configured on this server. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the backend service.' });
  if (!title || title.length > 80 || description.length > 500) return res.status(400).json({ error: 'LIVE title or description is invalid' });
  if (!['public','followers','private'].includes(visibility)) return res.status(400).json({ error: 'Invalid LIVE visibility' });
  if (!LIVE_EXPERIENCE_MODES.has(experienceMode)) return res.status(400).json({ error: 'Invalid LIVE experience mode' });
  if (!LIVE_CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid LIVE discussion category' });
  if (inviteeIds.length > 100 || inviteeIds.some((id) => !validId(id)) || new Set(inviteeIds).size !== inviteeIds.length) return res.status(400).json({ error: 'Invalid private LIVE invitees' });
  if (visibility === 'private' && inviteeIds.length === 0) return res.status(400).json({ error: 'Private LIVE requires at least one invitee' });
  if (visibility !== 'private' && inviteeIds.length > 0) return res.status(400).json({ error: 'Invitees are only valid for private LIVE' });
  const allowGuests = req.body?.allowGuests === true;
  try {
    const id = randomUUID();
    const roomName = 'zlive_' + id.replace(/-/g, '');
    const token = issueToken(req.user, roomName, config, true, experienceMode === 'audio_room');
    const { data: createdStream, error } = await supabaseAdmin.rpc('create_live_stream', {
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
    let stream = createdStream;
    if (experienceMode !== 'broadcast' || category !== 'social') {
      const { data: themedStream, error: themeError } = await supabaseAdmin.from('live_streams')
        .update({ experience_mode: experienceMode, category })
        .eq('id', id).select('*').single();
      if (themeError) {
        try {
          await supabaseAdmin.rpc('end_live_stream', { p_stream_id: id, p_creator_id: req.user.id });
        } catch {
          // Best-effort rollback must not mask the original themed-stream update error.
        }
        await deleteLiveKitRoom(roomName).catch(() => {});
        throw themeError;
      }
      stream = themedStream;
    }
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

router.post('/:streamId/not-interested', makeLimiter({ windowMs: 60 * 1000, max: 10, error: 'Please wait before sending more LIVE feedback.' }), async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id === req.user.id) return res.status(400).json({ error: 'You cannot hide your own LIVE stream' });
    const participant = await requireJoined(streamId, req.user.id);
    if (!participant || participant.role === 'creator') {
      return res.status(403).json({ error: 'Join this LIVE stream before sending feedback' });
    }
    const { error } = await supabaseAdmin.from('live_stream_feedback').upsert({
      user_id: req.user.id,
      creator_id: stream.creator_id,
      feedback_type: 'not_interested',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,creator_id,feedback_type' });
    if (error) throw error;
    return res.status(201).json({ saved: true, feedback: 'not_interested' });
  } catch (error) {
    console.error('[live] not-interested feedback failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not save LIVE discovery feedback' });
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
    const { data: existingParticipant, error: existingParticipantError } = await supabaseAdmin.from('live_stream_participants')
      .select('status').eq('stream_id', streamId).eq('user_id', req.user.id).maybeSingle();
    if (existingParticipantError) throw existingParticipantError;
    if (existingParticipant?.status === 'blocked') {
      return res.status(403).json({ error: 'The creator removed you from this LIVE stream' });
    }
    const { data: role, error: joinError } = await supabaseAdmin.rpc('join_live_stream', {
      p_stream_id: streamId, p_user_id: req.user.id,
    });
    if (joinError) {
      if (joinError.code === 'P0001' && /full/i.test(joinError.message || '')) return res.status(409).json({ error: 'This LIVE audience is full' });
      if (joinError.code === '42501') return res.status(403).json({ error: 'This LIVE stream is not publicly available' });
      if (joinError.code === 'P0001' && /LIVE stage is full/i.test(joinError.message || '')) {
        return res.status(409).json({ error: 'The LIVE stage is full. Please try again when a guest leaves.' });
      }
      if (joinError.code === 'P0001') return res.status(404).json({ error: 'LIVE stream has ended' });
      throw joinError;
    }
    if (role === 'guest') {
      const { count: stageCount, error: stageCountError } = await supabaseAdmin.from('live_stream_participants')
        .select('id', { count: 'exact', head: true })
        .eq('stream_id', streamId).eq('role', 'guest').eq('status', 'joined');
      if (stageCountError) throw stageCountError;
      if (Number(stageCount || 0) > MAX_LIVE_STAGE_GUESTS) {
        const { error: leaveError } = await supabaseAdmin.rpc('leave_live_stream', {
          p_stream_id: streamId, p_user_id: req.user.id,
        });
        if (leaveError) throw leaveError;
        return res.status(409).json({ error: 'The LIVE stage is full. Please try again when a guest leaves.' });
      }
    }
    const canPublish = role === 'creator' || role === 'guest';
    const token = issueToken(req.user, stream.room_name, config, canPublish, stream.experience_mode === 'audio_room');
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

router.post('/:streamId/heartbeat', async (req, res) => {
  const streamId = req.params.streamId;
  if (!validId(streamId)) return res.status(400).json({ error: 'Invalid LIVE stream id' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    const { data: participant, error: participantError } = await supabaseAdmin.from('live_stream_participants')
      .select('role,status,last_seen_at,left_at')
      .eq('stream_id', streamId).eq('user_id', req.user.id).maybeSingle();
    if (participantError) throw participantError;
    if (!participant) return res.status(403).json({ error: 'Join this LIVE stream before sending a heartbeat' });
    if (participant.status === 'blocked') return res.status(403).json({ error: 'The creator removed you from this LIVE stream' });

    let rejoined = false;
    if (participant.status === 'left') {
      const lastSeen = Date.parse(participant.last_seen_at || '');
      const leftAt = Date.parse(participant.left_at || '');
      if (!Number.isFinite(lastSeen) || !Number.isFinite(leftAt) || lastSeen >= leftAt - 30_000) {
        return res.status(403).json({ error: 'You have left this LIVE stream' });
      }
      const { error: rejoinError } = await supabaseAdmin.rpc('join_live_stream', {
        p_stream_id: streamId, p_user_id: req.user.id,
      });
      if (rejoinError) {
        if (rejoinError.code === '42501') return res.status(403).json({ error: 'This LIVE stream is no longer available to you' });
        if (rejoinError.code === 'P0001') return res.status(404).json({ error: 'LIVE stream has ended or is full' });
        throw rejoinError;
      }
      rejoined = true;
    } else if (participant.status !== 'joined') {
      return res.status(403).json({ error: 'Join this LIVE stream before sending a heartbeat' });
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin.from('live_stream_participants')
      .update({ last_seen_at: now })
      .eq('stream_id', streamId).eq('user_id', req.user.id).eq('status', 'joined');
    if (updateError) throw updateError;
    return res.json({ ok: true, rejoined, lastSeenAt: now });
  } catch (error) {
    console.error('[live] participant heartbeat failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not renew LIVE presence' });
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

router.post('/:streamId/guests/invite', makeLimiter({ windowMs: 60 * 1000, max: 5, error: 'Please wait before sending more LIVE invitations.' }), async (req, res) => {
  const streamId = req.params.streamId;
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!validId(streamId) || !validId(userId) || userId === req.user.id) {
    return res.status(400).json({ error: 'Invalid LIVE guest invitation' });
  }
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can invite guests to the stage' });
    if (!stream.allow_guests) return res.status(409).json({ error: 'Guest participation is disabled for this LIVE stream' });
    if (await hasBlockBetween(stream.creator_id, userId)) return res.status(403).json({ error: 'Guest access is unavailable' });
    const { data: profile, error: profileError } = await supabaseAdmin.from('profiles')
      .select('id').eq('id', userId).maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return res.status(404).json({ error: 'The invited user was not found' });
    const { error: inviteError } = await supabaseAdmin.from('live_stream_invites').upsert({
      stream_id: streamId, user_id: userId, invited_by: req.user.id,
      requested_by: null, invitation_type: 'guest', status: 'accepted',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'stream_id,user_id,invitation_type' });
    if (inviteError) throw inviteError;
    const creatorName = req.user.user_metadata?.name || req.user.user_metadata?.full_name || 'The LIVE creator';
    await notifyLiveUsers([userId], {
      title: 'You are invited to the LIVE stage',
      body: creatorName + ' invited you to join the LIVE as a guest.',
      data: { type: 'live_guest_invitation', streamId, creatorId: req.user.id },
    });
    return res.status(201).json({ invited: true, userId });
  } catch (error) {
    console.error('[live] direct guest invitation failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not invite this user to the LIVE stage' });
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

router.post('/:streamId/guest-requests', makeLimiter({ windowMs: 60 * 1000, max: 3, error: 'Please wait before requesting the LIVE stage again.' }), async (req, res) => {
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
      ? await supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id', userIds)
      : { data: [], error: null };
    if (profileError) throw profileError;
    const profilesById = new Map((profiles || []).map((row) => [row.id, row]));
    return res.json({ requests: (data || []).map((row) => {
      const profile = profilesById.get(row.user_id);
      return {
        ...row,
        name: profile?.name || 'ZannyChat user',
        avatarColor: profile?.avatar_color || null,
      };
    }) });
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
    const { error: heartbeatError } = await supabaseAdmin.from('live_stream_participants')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('stream_id', streamId).eq('user_id', req.user.id).eq('status', 'left');
    if (heartbeatError) throw heartbeatError;
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
    const blockedCommenterIds = await getBlockedUserIds(req.user.id, ordered.map((comment) => comment.user_id));
    const visibleComments = ordered.filter((comment) => !blockedCommenterIds.has(comment.user_id));
    const names = await getProfileNames(visibleComments.map((comment) => comment.user_id));
    const comments = visibleComments.map((row) => {
      const { user_id: _userId, ...comment } = row;
      return { ...comment, user_name: names.get(_userId) || 'ZannyChat user' };
    });
    const reactionSince = new Date(Date.now() - 12 * 1000).toISOString();
    const { data: recentReactions, error: reactionError } = await supabaseAdmin.from('live_stream_reactions')
      .select('id,user_id,reaction,created_at')
      .eq('stream_id', streamId)
      .gt('created_at', reactionSince)
      .order('created_at', { ascending: false })
      .limit(100);
    if (reactionError) throw reactionError;
    const blockedReactionUserIds = await getBlockedUserIds(req.user.id, (recentReactions || []).map((reaction) => reaction.user_id));
    const reactions = (recentReactions || [])
      .filter((reaction) => !blockedReactionUserIds.has(reaction.user_id))
      .reverse()
      .map(({ user_id: _userId, ...reaction }) => reaction);
    return res.json({ comments, reactions });
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
    publishLiveFeedChanged(stream);
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
    publishLiveFeedChanged(stream);
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
    const { data: creatorProfile, error: profileError } = await supabaseAdmin.from('profiles')
      .select('id').eq('id', creatorId).maybeSingle();
    if (profileError) throw profileError;
    if (!creatorProfile) return res.status(404).json({ error: 'Creator impact is unavailable' });
    const { data, error } = await supabaseAdmin.from('live_creator_impact')
      .select('impact_score,total_reactions,unique_supporters,updated_at')
      .eq('creator_id', creatorId).maybeSingle();
    if (error) throw error;
    const impactScore = Number(data?.impact_score || 0);
    const milestones = [
      { threshold: 10, id: 'first-spark', label: 'First Spark' },
      { threshold: 50, id: 'community-favorite', label: 'Community Favorite' },
      { threshold: 250, id: 'stage-star', label: 'Stage Star' },
      { threshold: 1000, id: 'iconic-voice', label: 'Iconic Voice' },
      { threshold: 5000, id: 'legendary-presence', label: 'Legendary Presence' },
      { threshold: 10000, id: 'hall-of-fame', label: 'Hall of Fame' },
    ];
    const badges = milestones.filter((badge) => impactScore >= badge.threshold)
      .map(({ id, label, threshold }) => ({ id, label, threshold }));
    const nextMilestone = milestones.find((badge) => impactScore < badge.threshold) || null;
    const { data: reactionBreakdown, error: reactionBreakdownError } = await supabaseAdmin.rpc(
      'get_live_creator_reaction_breakdown', { p_creator_id: creatorId },
    );
    if (reactionBreakdownError) throw reactionBreakdownError;
    return res.json({
      impact: {
        impactScore,
        totalReactions: Number(data?.total_reactions || 0),
        uniqueSupporters: Number(data?.unique_supporters || 0),
        reactionBreakdown: Array.isArray(reactionBreakdown) ? reactionBreakdown : [],
        badges,
        nextMilestone: nextMilestone ? { id: nextMilestone.id, label: nextMilestone.label, threshold: nextMilestone.threshold } : null,
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
    // The creator is the owner of the live room and may not have a participant row.
    // Viewers and guests must still have an active joined participant record.
    if (stream.creator_id !== req.user.id && !await requireJoined(streamId, req.user.id)) {
      return res.status(403).json({ error: 'Join this LIVE stream before reacting' });
    }
    const { data: impactRows, error } = await supabaseAdmin.rpc('record_live_creator_impact', {
      p_stream_id: streamId,
      p_user_id: req.user.id,
      p_reaction: reaction,
    });
    if (error) throw error;
    const impact = Array.isArray(impactRows) ? impactRows[0] : null;
    publishLiveFeedChanged(stream);
    return res.status(201).json({ accepted: true, impact });
  } catch (error) {
    // Keep expected authorization/lifecycle rejections distinct from service failures.
    // The SQL writer independently checks joined + left_at IS NULL to close race windows.
    if (error?.code === '42501') {
      return res.status(403).json({ error: 'Join this LIVE stream before reacting' });
    }
    if (error?.code === '22023') {
      return res.status(400).json({ error: 'Unsupported LIVE reaction' });
    }
    if (error?.code === 'P0001') {
      return res.status(404).json({ error: 'LIVE stream has ended' });
    }
    console.error('[live] reaction failed:', {
      code: error?.code || null,
      message: error?.message || String(error),
      details: error?.details || null,
      hint: error?.hint || null,
    });
    return res.status(503).json({ error: 'Could not send LIVE reaction' });
  }
});


router.patch('/:streamId/guests/:userId/mute', async (req, res) => {
  const { streamId, userId } = req.params;
  const muted = req.body?.muted;
  if (!validId(streamId) || !validId(userId) || typeof muted !== 'boolean') {
    return res.status(400).json({ error: 'Invalid LIVE guest microphone action' });
  }
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can control guest microphones' });
    const participant = await requireJoined(streamId, userId);
    if (!participant || participant.role !== 'guest') return res.status(404).json({ error: 'LIVE stage guest not found' });
    const room = await listRoomParticipants(stream.room_name);
    const liveParticipant = (room?.participants || []).find((item) => item.identity === userId);
    const audioTrack = (liveParticipant?.tracks || []).find((track) =>
      track.type === 0 || String(track.type || '').toUpperCase() === 'AUDIO');
    if (!audioTrack?.sid) return res.status(409).json({ error: 'This guest has no active microphone track' });
    try {
      await muteRoomParticipantTrack(stream.room_name, userId, audioTrack.sid, muted);
    } catch (mediaError) {
      if (!muted) {
        return res.status(409).json({
          error: 'Remote unmuting is disabled in the LiveKit project. Enable “Admins can remotely unmute tracks” in LiveKit settings to allow host unmute.',
        });
      }
      throw mediaError;
    }
    return res.json({ userId, microphoneMuted: muted });
  } catch (error) {
    console.error('[live] guest microphone control failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not update the guest microphone' });
  }
});

router.patch('/:streamId/guests/:userId/spotlight', async (req, res) => {
  const { streamId, userId } = req.params;
  const spotlighted = req.body?.spotlighted;
  if (!validId(streamId) || !validId(userId) || typeof spotlighted !== 'boolean') {
    return res.status(400).json({ error: 'Invalid LIVE spotlight action' });
  }
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can manage the LIVE spotlight' });
    const participant = await requireJoined(streamId, userId);
    if (!participant || participant.role !== 'guest') return res.status(404).json({ error: 'LIVE stage guest not found' });
    const room = await listRoomParticipants(stream.room_name);
    const roomParticipants = room?.participants || [];
    if (spotlighted) {
      const currentSpotlights = roomParticipants.filter((item) =>
        item.identity !== userId && item.attributes?.zannychat_spotlight === 'true');
      for (const current of currentSpotlights) {
        await updateRoomParticipantAttributes(stream.room_name, current.identity, { zannychat_spotlight: '' });
      }
    }
    await updateRoomParticipantAttributes(stream.room_name, userId, {
      zannychat_spotlight: spotlighted ? 'true' : '',
    });
    return res.json({ userId, spotlighted });
  } catch (error) {
    console.error('[live] guest spotlight update failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not update the LIVE spotlight' });
  }
});

router.delete('/:streamId/guests/:userId', async (req, res) => {
  const { streamId, userId } = req.params;
  if (!validId(streamId) || !validId(userId)) return res.status(400).json({ error: 'Invalid LIVE stage guest' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can remove a LIVE guest' });
    const participant = await requireJoined(streamId, userId);
    if (!participant || participant.role !== 'guest') return res.status(404).json({ error: 'LIVE stage guest not found' });
    let returnedToAudience = true;
    try {
      // Remove publishing permission, not room membership: LiveKit unpublishes the guest tracks and
      // keeps the participant connected as a viewer with subscribe permission.
      await updateRoomParticipantAttributes(stream.room_name, userId, { zannychat_spotlight: '' });
      await updateRoomParticipantPermissions(stream.room_name, userId, {
        canPublish: false,
        canSubscribe: true,
        // Feed updates are server-authoritative; demoted viewers must not publish room data.
        canPublishData: false,
      });
      const { error: demoteError } = await supabaseAdmin.from('live_stream_participants')
        .update({ role: 'viewer', status: 'joined', left_at: null })
        .eq('stream_id', streamId).eq('user_id', userId).eq('role', 'guest');
      if (demoteError) throw demoteError;
    } catch (mediaError) {
      if (mediaError.status !== 404) throw mediaError;
      returnedToAudience = false;
      const { error: leaveError } = await supabaseAdmin.rpc('leave_live_stream', {
        p_stream_id: streamId, p_user_id: userId,
      });
      if (leaveError) throw leaveError;
    }
    const { error: participantHeartbeatError } = await supabaseAdmin.from('live_stream_participants')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('stream_id', streamId).eq('user_id', userId);
    if (participantHeartbeatError) throw participantHeartbeatError;
    const { error: revokeInviteError } = await supabaseAdmin.from('live_stream_invites')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('stream_id', streamId).eq('user_id', userId).eq('invitation_type', 'guest');
    if (revokeInviteError) throw revokeInviteError;
    await notifyLiveUsers([userId], {
      title: 'You were moved off the LIVE stage',
      body: returnedToAudience
        ? 'The creator moved you to the audience. You can keep watching the LIVE.'
        : 'The creator removed you from the LIVE stage after your connection had already ended.',
      data: { type: 'live_guest_removed', streamId, returnedToAudience },
    });
    return res.json({ removed: true, userId, returnedToAudience });
  } catch (error) {
    console.error('[live] guest removal failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not remove the guest from the LIVE stage' });
  }
});


router.delete('/:streamId/participants/:userId', async (req, res) => {
  const { streamId, userId } = req.params;
  if (!validId(streamId) || !validId(userId)) return res.status(400).json({ error: 'Invalid LIVE participant reference' });
  try {
    const stream = await getStream(streamId);
    if (!stream || stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });
    if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can remove LIVE participants' });
    if (userId === stream.creator_id) return res.status(400).json({ error: 'The creator cannot remove themselves from the LIVE audience' });
    const { data: participant, error: participantError } = await supabaseAdmin.from('live_stream_participants')
      .select('id,role,status').eq('stream_id', streamId).eq('user_id', userId).maybeSingle();
    if (participantError) throw participantError;
    if (!participant || !['viewer', 'guest'].includes(participant.role)
        || !['joined', 'blocked'].includes(participant.status)) {
      return res.status(404).json({ error: 'Joined LIVE participant not found' });
    }

    const now = new Date().toISOString();
    if (participant.status === 'joined') {
      const { data: blockedRow, error: blockError } = await supabaseAdmin.from('live_stream_participants')
        .update({ status: 'blocked', left_at: now, last_seen_at: now })
        .eq('stream_id', streamId).eq('user_id', userId).eq('status', 'joined')
        .select('id').maybeSingle();
      if (blockError) throw blockError;
      if (!blockedRow) {
        return res.status(409).json({ error: 'Participant state changed. Refresh Creator Studio and try again.' });
      }
    }

    // Persist the stream-scoped block before revoking the media connection.
    // A retry can finish LiveKit removal if the media service is temporarily unavailable.
    try {
      await removeRoomParticipant(stream.room_name, userId);
    } catch (mediaError) {
      if (mediaError.status !== 404) throw mediaError;
    }

    const { error: inviteError } = await supabaseAdmin.from('live_stream_invites')
      .update({ status: 'revoked', updated_at: now })
      .eq('stream_id', streamId).eq('user_id', userId).eq('invitation_type', 'guest');
    if (inviteError) throw inviteError;

    void notifyLiveUsers([userId], {
      title: 'Removed from LIVE',
      body: 'The creator removed you from this LIVE stream.',
      data: { type: 'live_participant_removed', streamId, creatorId: req.user.id },
    }).catch((notifyError) => console.warn('[live] participant removal notification failed:', notifyError?.message || notifyError));
    return res.json({ removed: true, userId, status: 'blocked' });
  } catch (error) {
    console.error('[live] participant removal failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not remove this participant from LIVE' });
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
      .select('user_id,role,joined_at,status').eq('stream_id', streamId).in('role', ['viewer','guest']).eq('status', 'joined')
      .order('joined_at', { ascending: true }).limit(500);
    if (joinedError) throw joinedError;
    const { data: moderators, error: moderatorsError } = await supabaseAdmin.from('live_stream_moderators')
      .select('user_id').eq('stream_id', streamId);
    if (moderatorsError) throw moderatorsError;
    const joinedById = new Map((joined || []).map((row) => [row.user_id, row]));
    const moderatorIds = new Set((moderators || []).map((row) => row.user_id));
    const userIds = [...new Set([stream.creator_id, ...joinedById.keys(), ...moderatorIds])];
    const { data: profiles, error: profilesError } = userIds.length
      ? await supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id', userIds)
      : { data: [], error: null };
    if (profilesError) throw profilesError;
    const profilesById = new Map((profiles || []).map((row) => [row.id, row]));
    let mediaByIdentity = new Map();
    try {
      const room = await listRoomParticipants(stream.room_name);
      mediaByIdentity = new Map((room?.participants || []).map((participant) => {
        const audio = (participant.tracks || []).find((track) =>
          track.type === 0 || String(track.type || '').toUpperCase() === 'AUDIO');
        const video = (participant.tracks || []).find((track) =>
          track.type === 1 || String(track.type || '').toUpperCase() === 'VIDEO');
        return [participant.identity, {
          microphoneMuted: typeof audio?.muted === 'boolean' ? audio.muted : null,
          cameraEnabled: typeof video?.muted === 'boolean' ? !video.muted : Boolean(video),
          spotlighted: participant.attributes?.zannychat_spotlight === 'true',
        }];
      }));
    } catch (mediaError) {
      console.error('[live] LiveKit participant media state unavailable:', mediaError?.message || mediaError);
    }
    return res.json({ participants: userIds.map((userId) => {
      const profile = profilesById.get(userId);
      const isCreator = userId === stream.creator_id;
      const participant = joinedById.get(userId);
      return {
        userId,
        name: profile?.name || (isCreator ? 'LIVE Creator' : 'ZannyChat user'),
        avatarColor: profile?.avatar_color || null,
        joinedAt: isCreator ? stream.started_at : participant?.joined_at || null,
        joined: isCreator || joinedById.has(userId),
        role: isCreator ? 'creator' : participant?.role || null,
        status: isCreator || participant ? 'joined' : 'offline',
        stage: isCreator || participant?.role === 'guest',
        microphoneMuted: mediaByIdentity.get(userId)?.microphoneMuted ?? null,
        cameraEnabled: mediaByIdentity.get(userId)?.cameraEnabled ?? null,
        spotlighted: mediaByIdentity.get(userId)?.spotlighted ?? false,
        moderator: moderatorIds.has(userId),
        connectionStatus: mediaByIdentity.has(userId) ? 'connected' : 'not_connected',
      };
    }) });
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
    const stream = await getStream(streamId);
    if (!stream) return res.status(404).json({ error: 'LIVE stream not found' });
    if (stream.creator_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the creator can end this LIVE stream' });
    }
    // An earlier end request may have committed while its HTTP response was
    // lost. Treat a creator retry as success and retry idempotent SFU/egress
    // cleanup rather than trapping the creator in a stale LIVE room.
    if (stream.status === 'ended') {
      await stopActiveLiveReplayForStream(streamId).catch((replayError) => {
        console.error('[live-replay] retry stop on ended stream failed', { streamId, message: replayError.message });
      });
      if (stream.room_name) {
        await deleteLiveKitRoom(stream.room_name).catch((roomError) => {
          console.error('[live] retry room cleanup after end failed:', roomError?.message || roomError);
        });
      }
      return res.json({ ended: true, alreadyEnded: true });
    }
    if (stream.status !== 'live') return res.status(404).json({ error: 'LIVE stream has ended' });

    // Capture the active audience before the atomic end operation marks every
    // participant as left, so guests and viewers can be notified afterwards.
    let participantIds = [];
    const { data: joinedParticipants, error: participantLookupError } = await supabaseAdmin
      .from('live_stream_participants')
      .select('user_id')
      .eq('stream_id', streamId)
      .eq('status', 'joined');
    if (participantLookupError) {
      console.error('[live] ended-session participant lookup failed:', participantLookupError.message);
    } else {
      participantIds = [...new Set((joinedParticipants || []).map((item) => item.user_id).filter(validId))];
    }
    const { data: ended, error } = await supabaseAdmin.rpc('end_live_stream', {
      p_stream_id: streamId, p_creator_id: req.user.id,
    });
    if (error) {
      if (error.code === '42501') return res.status(403).json({ error: 'Only the creator can end this LIVE stream' });
      throw error;
    }
    if (!ended) {
      // Close the small race where another creator retry ended the row after
      // getStream() but before this request reached the atomic RPC.
      const currentStream = await getStream(streamId);
      if (currentStream?.status === 'ended' && currentStream.creator_id === req.user.id) {
        await stopActiveLiveReplayForStream(streamId).catch((replayError) => {
          console.error('[live-replay] raced end cleanup failed', { streamId, message: replayError.message });
        });
        if (currentStream.room_name) {
          await deleteLiveKitRoom(currentStream.room_name).catch((roomError) => {
            console.error('[live] raced room cleanup failed:', roomError?.message || roomError);
          });
        }
        return res.json({ ended: true, alreadyEnded: true });
      }
      return res.status(404).json({ error: 'LIVE stream has ended' });
    }
    // Push delivery is best-effort and must not delay broadcast teardown.
    void notifyLiveUsers(participantIds.filter((id) => id !== stream.creator_id), {
      title: 'LIVE has ended',
      body: 'The creator has ended this LIVE broadcast.',
      data: { type: 'live_stream_ended', streamId, creatorId: stream.creator_id },
    }).catch((notificationError) => {
      console.error('[live] ended-session notification failed:', notificationError?.message || notificationError);
    });
    await stopActiveLiveReplayForStream(streamId).catch((replayError) => {
      console.error('[live-replay] stop on stream end failed', { streamId, message: replayError.message });
    });
    if (stream?.room_name) {
      await deleteLiveKitRoom(stream.room_name).catch((roomError) => {
        console.error('[live] LiveKit room cleanup after end failed:', roomError?.message || roomError);
      });
    }
    return res.json({ ended: true });
  } catch (error) {
    console.error('[live] end failed:', error?.message || error);
    return res.status(503).json({ error: 'Could not end LIVE stream' });
  }
});

module.exports = router;
