const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { makeLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { sendPushToUser } = require('../config/pushClient');

const router = express.Router();
router.use(requireAuth, makeLimiter({ windowMs: 60 * 1000, max: 45, error: 'LIVE Events are rate-limited.' }));

const CATEGORIES = new Set(['entertainment','social','politics','science','education','finance','technology','sports','business','health','other']);
const VISIBILITIES = new Set(['public','followers','private']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_KEYS = new Set(['title','description','category','visibility','startsAt','durationMinutes','maxAttendees']);
const UPDATE_KEYS = new Set(['title','description','category','visibility','startsAt','durationMinutes','maxAttendees']);

function isUuid(value) { return UUID.test(String(value || '')); }
function parseSchedule(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  const timestamp = Date.parse(value);
  const delta = timestamp - Date.now();
  if (delta < 10 * 60 * 1000 || delta > 90 * 24 * 60 * 60 * 1000) return null;
  return new Date(timestamp).toISOString();
}
function validPayload(body, keys) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && !Object.keys(body).some((key) => !keys.has(key));
}
function validateFields(body, partial = false) {
  const out = {};
  if (!partial || Object.hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || body.title.trim().length < 3 || body.title.trim().length > 80) return null;
    out.title = body.title.trim();
  }
  if (!partial || Object.hasOwn(body, 'description')) {
    if (body.description !== undefined && typeof body.description !== 'string') return null;
    const description = String(body.description ?? '').trim();
    if (description.length > 1000) return null;
    out.description = description;
  }
  if (!partial || Object.hasOwn(body, 'category')) {
    if (!CATEGORIES.has(body.category)) return null;
    out.category = body.category;
  }
  if (!partial || Object.hasOwn(body, 'visibility')) {
    if (!VISIBILITIES.has(body.visibility)) return null;
    out.visibility = body.visibility;
  }
  if (!partial || Object.hasOwn(body, 'startsAt')) {
    const startsAt = parseSchedule(body.startsAt);
    if (!startsAt) return null;
    out.starts_at = startsAt;
  }
  if (!partial || Object.hasOwn(body, 'durationMinutes')) {
    const duration = body.durationMinutes ?? 60;
    if (!Number.isInteger(duration) || duration < 15 || duration > 240) return null;
    out.duration_minutes = duration;
  }
  if (!partial || Object.hasOwn(body, 'maxAttendees')) {
    const capacity = body.maxAttendees ?? 500;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) return null;
    out.max_attendees = capacity;
  }
  return Object.keys(out).length ? out : null;
}

async function blockedBetween(a, b) {
  const [one,two] = await Promise.all([
    supabaseAdmin.from('blocked_users').select('blocker_id').eq('blocker_id',a).eq('blocked_id',b).maybeSingle(),
    supabaseAdmin.from('blocked_users').select('blocker_id').eq('blocker_id',b).eq('blocked_id',a).maybeSingle(),
  ]);
  if (one.error || two.error) throw one.error || two.error;
  return Boolean(one.data || two.data);
}
async function canView(event, viewerId) {
  if (event.creator_id === viewerId) return true;
  if (await blockedBetween(event.creator_id, viewerId)) return false;
  if (event.visibility === 'public') return true;
  if (event.visibility === 'followers') {
    const { data,error } = await supabaseAdmin.from('live_creator_follows')
      .select('creator_id').eq('creator_id',event.creator_id).eq('follower_id',viewerId).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
  if (event.visibility === 'private') {
    const { data,error } = await supabaseAdmin.from('live_event_invites')
      .select('event_id').eq('event_id',event.id).eq('invited_user_id',viewerId).in('status',['pending','accepted']).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
  return false;
}
function shapeEvent(row, attendeeCount = 0, rsvpStatus = null) {
  return {
    id: row.id, creatorId: row.creator_id, title: row.title, description: row.description,
    category: row.category, visibility: row.visibility, startsAt: row.starts_at,
    durationMinutes: row.duration_minutes, status: row.status, streamId: row.stream_id || null,
    attendeeCount, maxAttendees: row.max_attendees, rsvpStatus,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

router.get('/events', async (req,res) => {
  const limitValue = Number(req.query.limit || 30);
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue,1),50) : 30;
  const category = req.query.category ? String(req.query.category) : null;
  if (category && !CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid LIVE Event category' });
  try {
    let query = supabaseAdmin.from('live_events')
      .select('id,creator_id,title,description,category,visibility,starts_at,duration_minutes,status,stream_id,max_attendees,created_at,updated_at')
      .eq('status','scheduled').gt('starts_at',new Date().toISOString())
      .order('starts_at',{ascending:true}).limit(200);
    if (category) query = query.eq('category',category);
    if (req.query.creatorId) {
      if (!isUuid(req.query.creatorId)) return res.status(400).json({ error: 'Invalid LIVE creator' });
      query = query.eq('creator_id',req.query.creatorId);
    }
    const { data,error } = await query;
    if (error) throw error;
    const visible = [];
    for (const event of data || []) {
      if (await canView(event,req.user.id)) visible.push(event);
      if (visible.length >= limit) break;
    }
    const ids = visible.map((event) => event.id);
    const [attendees,ownRsvps,profiles] = await Promise.all([
      ids.length ? supabaseAdmin.from('live_event_attendees').select('event_id').in('event_id',ids).eq('status','going') : Promise.resolve({data:[],error:null}),
      ids.length ? supabaseAdmin.from('live_event_attendees').select('event_id,status').in('event_id',ids).eq('user_id',req.user.id) : Promise.resolve({data:[],error:null}),
      visible.length ? supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id',[...new Set(visible.map((e)=>e.creator_id))]) : Promise.resolve({data:[],error:null}),
    ]);
    for (const result of [attendees,ownRsvps,profiles]) if (result.error) throw result.error;
    const counts = new Map();
    for (const row of attendees.data || []) counts.set(row.event_id,(counts.get(row.event_id)||0)+1);
    const rsvps = new Map((ownRsvps.data||[]).map((row)=>[row.event_id,row.status]));
    const creators = new Map((profiles.data||[]).map((row)=>[row.id,row]));
    return res.json({ events: visible.map((row)=>({
      ...shapeEvent(row,counts.get(row.id)||0,rsvps.get(row.id)||null),
      creator: { id: row.creator_id, name: creators.get(row.creator_id)?.name || 'LIVE Creator', avatarColor: creators.get(row.creator_id)?.avatar_color || null },
    })), generatedAt:new Date().toISOString() });
  } catch(error) {
    console.error('[live-events] list failed:',error?.message||error);
    return res.status(503).json({ error:'Could not load LIVE Events' });
  }
});

router.post('/events', makeLimiter({ windowMs: 60 * 60 * 1000, max: 5, error: 'Event creation is limited to five per hour.' }), async (req,res) => {
  if (!validPayload(req.body,CREATE_KEYS)) return res.status(400).json({error:'Invalid LIVE Event details'});
  const values = validateFields(req.body);
  if (!values) return res.status(400).json({error:'Check the title, category, audience, schedule and capacity'});
  try {
    const { count,error:countError } = await supabaseAdmin.from('live_events')
      .select('id',{count:'exact',head:true}).eq('creator_id',req.user.id).eq('status','scheduled')
      .gt('starts_at',new Date().toISOString());
    if (countError) throw countError;
    if ((count||0)>=5) return res.status(429).json({error:'You can have up to five upcoming LIVE Events'});
    const { data,error } = await supabaseAdmin.from('live_events')
      .insert({creator_id:req.user.id,...values}).select('*').single();
    if (error) throw error;
    return res.status(201).json({event:shapeEvent(data)});
  } catch(error) {
    console.error('[live-events] create failed:',error?.message||error);
    return res.status(503).json({error:'Could not schedule this LIVE Event'});
  }
});

router.patch('/events/:eventId', async (req,res) => {
  const {eventId}=req.params;
  if (!isUuid(eventId) || !validPayload(req.body,UPDATE_KEYS)) return res.status(400).json({error:'Invalid LIVE Event update'});
  const values=validateFields(req.body,true);
  if (!values) return res.status(400).json({error:'No valid LIVE Event changes were supplied'});
  try {
    const {data:current,error:readError}=await supabaseAdmin.from('live_events')
      .select('*').eq('id',eventId).maybeSingle();
    if (readError) throw readError;
    if (!current) return res.status(404).json({error:'LIVE Event not found'});
    if (current.creator_id!==req.user.id) return res.status(403).json({error:'Only the creator can edit this Event'});
    if (current.status!=='scheduled' || Date.parse(current.starts_at)<=Date.now()) return res.status(409).json({error:'This Event can no longer be edited'});
    const {data,error}=await supabaseAdmin.from('live_events').update({...values,updated_at:new Date().toISOString()})
      .eq('id',eventId).eq('creator_id',req.user.id).eq('status','scheduled').select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({error:'Event changed while you were editing it'});
    return res.json({event:shapeEvent(data)});
  } catch(error) {
    console.error('[live-events] update failed:',error?.message||error);
    return res.status(503).json({error:'Could not update LIVE Event'});
  }
});

router.post('/events/:eventId/cancel', async (req,res) => {
  const {eventId}=req.params;
  if (!isUuid(eventId)) return res.status(400).json({error:'Invalid LIVE Event'});
  try {
    const {data,error}=await supabaseAdmin.from('live_events').update({status:'cancelled',updated_at:new Date().toISOString()})
      .eq('id',eventId).eq('creator_id',req.user.id).eq('status','scheduled')
      .gt('starts_at',new Date().toISOString()).select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({error:'Upcoming LIVE Event not found'});
    return res.json({cancelled:true,eventId});
  } catch(error) {
    console.error('[live-events] cancel failed:',error?.message||error);
    return res.status(503).json({error:'Could not cancel LIVE Event'});
  }
});


router.post('/events/:eventId/invites', async (req,res) => {
  const {eventId}=req.params;
  const userIds=Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds)] : [];
  if (!isUuid(eventId) || !userIds.length || userIds.length>25 || userIds.some((id)=>!isUuid(id))) {
    return res.status(400).json({error:'Choose between one and 25 valid invitees'});
  }
  try {
    const {data:event,error:readError}=await supabaseAdmin.from('live_events').select('id,creator_id,visibility,status,starts_at,title')
      .eq('id',eventId).maybeSingle();
    if (readError) throw readError;
    if (!event) return res.status(404).json({error:'LIVE Event not found'});
    if (event.creator_id!==req.user.id) return res.status(403).json({error:'Only the creator can invite guests'});
    if (event.visibility!=='private') return res.status(409).json({error:'Invitations are only used for private LIVE Events'});
    if (event.status!=='scheduled' || Date.parse(event.starts_at)<=Date.now()) return res.status(409).json({error:'This Event is no longer accepting invitations'});
    const invitees=userIds.filter((id)=>id!==req.user.id);
    for (const id of invitees) {
      if (await blockedBetween(req.user.id,id)) return res.status(409).json({error:'An invitee cannot be invited because of a block relationship'});
    }
    const rows=invitees.map((invited_user_id)=>({event_id:eventId,invited_user_id,invited_by:req.user.id,status:'pending',updated_at:new Date().toISOString()}));
    if (!rows.length) return res.status(400).json({error:'Choose at least one other account'});
    const {error}=await supabaseAdmin.from('live_event_invites').upsert(rows,{onConflict:'event_id,invited_user_id'});
    if (error) throw error;
    await Promise.allSettled(invitees.map((userId)=>sendPushToUser(userId,{
      title:'Private LIVE Event invitation',body:'You have been invited to '+event.title,
      data:{type:'live_event_invitation',eventId,creatorId:req.user.id},
    })));
    return res.status(200).json({invitedCount:invitees.length});
  } catch(error) {
    console.error('[live-events] invite failed:',error?.message||error);
    return res.status(503).json({error:'Could not send LIVE Event invitations'});
  }
});

router.get('/events/invitations', async (req,res) => {
  try {
    const {data:invites,error}=await supabaseAdmin.from('live_event_invites')
      .select('event_id,invited_by,status,created_at').eq('invited_user_id',req.user.id).eq('status','pending')
      .order('created_at',{ascending:false}).limit(50);
    if (error) throw error;
    const ids=(invites||[]).map((row)=>row.event_id);
    const {data:events,error:eventError}=ids.length ? await supabaseAdmin.from('live_events')
      .select('id,creator_id,title,description,category,visibility,starts_at,duration_minutes,status,max_attendees')
      .in('id',ids).eq('status','scheduled').gt('starts_at',new Date().toISOString()) : {data:[],error:null};
    if (eventError) throw eventError;
    const byId=new Map((events||[]).map((row)=>[row.id,row]));
    const creatorIds=[...new Set((events||[]).map((row)=>row.creator_id))];
    const {data:profiles,error:profileError}=creatorIds.length ? await supabaseAdmin.from('profiles').select('id,name,avatar_color').in('id',creatorIds) : {data:[],error:null};
    if (profileError) throw profileError;
    const profileById=new Map((profiles||[]).map((row)=>[row.id,row]));
    return res.json({invitations:(invites||[]).filter((row)=>byId.has(row.event_id)).map((invite)=>{
      const event=byId.get(invite.event_id), creator=profileById.get(event.creator_id);
      return {...shapeEvent(event,0,'invited'),invitedAt:invite.created_at,creator:{id:event.creator_id,name:creator?.name||'LIVE Creator',avatarColor:creator?.avatar_color||null}};
    })});
  } catch(error) {
    console.error('[live-events] invitations load failed:',error?.message||error);
    return res.status(503).json({error:'Could not load LIVE Event invitations'});
  }
});

router.patch('/events/:eventId/invitation', async (req,res) => {
  const {eventId}=req.params, status=req.body?.status;
  if (!isUuid(eventId) || !['accepted','declined'].includes(status) || Object.keys(req.body||{}).some((key)=>key!=='status')) {
    return res.status(400).json({error:'Invalid LIVE Event invitation response'});
  }
  try {
    const {data,error}=await supabaseAdmin.from('live_event_invites').update({status,updated_at:new Date().toISOString()})
      .eq('event_id',eventId).eq('invited_user_id',req.user.id).eq('status','pending')
      .select('event_id,status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({error:'Pending LIVE Event invitation not found'});
    return res.json({eventId,status:data.status});
  } catch(error) {
    console.error('[live-events] invitation response failed:',error?.message||error);
    return res.status(503).json({error:'Could not respond to LIVE Event invitation'});
  }
});

router.post('/events/:eventId/rsvp', async (req,res) => {
  const {eventId}=req.params;
  if (!isUuid(eventId)) return res.status(400).json({error:'Invalid LIVE Event'});
  try {
    const {data:event,error:readError}=await supabaseAdmin.from('live_events').select('*').eq('id',eventId).maybeSingle();
    if (readError) throw readError;
    if (!event || !await canView(event,req.user.id)) return res.status(404).json({error:'LIVE Event not found'});
    const {data,error}=await supabaseAdmin.rpc('rsvp_live_event',{p_event_id:eventId,p_user_id:req.user.id});
    if (error) throw error;
    const result=data?.result;
    if (result==='not_found') return res.status(404).json({error:'LIVE Event not found'});
    if (result==='closed') return res.status(409).json({error:'RSVP is closed for this Event'});
    if (result==='creator') return res.status(400).json({error:'Creators do not RSVP to their own Event'});
    if (result==='full') return res.status(409).json({error:'This LIVE Event is full'});
    return res.json({rsvpStatus:'going',attendeeCount:data.attendee_count,alreadyGoing:result==='already_going'});
  } catch(error) {
    console.error('[live-events] RSVP failed:',error?.message||error);
    return res.status(503).json({error:'Could not RSVP to this LIVE Event'});
  }
});

router.delete('/events/:eventId/rsvp', async (req,res) => {
  const {eventId}=req.params;
  if (!isUuid(eventId)) return res.status(400).json({error:'Invalid LIVE Event'});
  try {
    const {data,error}=await supabaseAdmin.from('live_event_attendees').update({status:'cancelled',updated_at:new Date().toISOString()})
      .eq('event_id',eventId).eq('user_id',req.user.id).eq('status','going').select('event_id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({error:'Active RSVP not found'});
    return res.json({rsvpStatus:'cancelled',eventId});
  } catch(error) {
    console.error('[live-events] RSVP cancellation failed:',error?.message||error);
    return res.status(503).json({error:'Could not cancel LIVE Event RSVP'});
  }
});

module.exports = router;
