const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/requireAuth');
const { conversationsLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
router.use(requireAuth, conversationsLimiter);

function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function unavailable(res) { return res.status(500).json({ error: 'Channel service is not configured' }); }
function hashInvite(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
async function canAccessChannel(channel, userId) {
  if (!channel) return false;
  if (!channel.is_private || channel.owner_id === userId) return true;
  const { data, error } = await supabaseAdmin.from('channel_subscriptions').select('channel_id').eq('channel_id', channel.id).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
async function requireChannelAccess(res, channel, userId) {
  try { if (await canAccessChannel(channel, userId)) return true; } catch (_) { res.status(500).json({ error: 'Unable to check channel access' }); return false; }
  res.status(404).json({ error: 'Channel not found' }); return false;
}

async function isChannelModerator(channelId, userId) {
  const [{ data: role, error: roleError }, { data: subscription, error: subscriptionError }] = await Promise.all([
    supabaseAdmin.from('channel_moderators').select('channel_id').eq('channel_id', channelId).eq('user_id', userId).maybeSingle(),
    supabaseAdmin.from('channel_subscriptions').select('channel_id').eq('channel_id', channelId).eq('user_id', userId).maybeSingle(),
  ]);
  if (roleError || subscriptionError) throw roleError || subscriptionError;
  return Boolean(role && subscription);
}

async function canModerateChannel(channel, userId) {
  if (channel.owner_id === userId) return true;
  return isChannelModerator(channel.id, userId);
}

// Channel directory returns public channels plus private channels the signed-in user owns or has joined.
router.get('/', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  // Restrict search syntax to plain words/punctuation so PostgREST filter
  // operators cannot be injected through the user-provided search string.
  const search = typeof req.query.q === 'string'
    ? req.query.q.trim().slice(0, 80).replace(/[^a-zA-Z0-9 .-]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  const applySearch = (query) => search
    ? query.or(`title.ilike.%${search}%,description.ilike.%${search}%`)
    : query;
  const publicQuery = applySearch(supabaseAdmin.from('channels').select('id, owner_id, title, description, is_private, created_at, updated_at').eq('is_private', false)).order('created_at', { ascending: false }).limit(100);
  const ownedQuery = applySearch(supabaseAdmin.from('channels').select('id, owner_id, title, description, is_private, created_at, updated_at').eq('is_private', true).eq('owner_id', req.user.id)).order('created_at', { ascending: false }).limit(100);
  const [{ data: publicChannels, error: publicError }, { data: myRows, error: mineError }, { data: ownedPrivate, error: ownedError }] = await Promise.all([
    publicQuery,
    supabaseAdmin.from('channel_subscriptions').select('channel_id').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(500),
    ownedQuery,
  ]);
  if (publicError || mineError || ownedError) return res.status(500).json({ error: 'Unable to load channels' });
  const myIds = [...new Set((myRows || []).map((row) => row.channel_id))];
  const subscribedPrivateQuery = applySearch(supabaseAdmin.from('channels').select('id, owner_id, title, description, is_private, created_at, updated_at').eq('is_private', true).in('id', myIds));
  const { data: subscribedPrivate, error: privateError } = myIds.length
    ? await subscribedPrivateQuery.order('created_at', { ascending: false }).limit(500)
    : { data: [], error: null };
  if (privateError) return res.status(500).json({ error: 'Unable to load private channel memberships' });
  const channelMap = new Map();
  for (const channel of [...(publicChannels || []), ...(ownedPrivate || []), ...(subscribedPrivate || [])]) channelMap.set(channel.id, channel);
  const channels = [...channelMap.values()].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const ids = channels.map((item) => item.id);
  if (!ids.length) return res.json({ channels: [] });
  const { data: subscriptions, error: subError } = await supabaseAdmin.from('channel_subscriptions').select('channel_id').in('channel_id', ids);
  if (subError) return res.status(500).json({ error: 'Unable to load channel subscriptions' });
  const counts = new Map();
  for (const row of subscriptions || []) counts.set(row.channel_id, (counts.get(row.channel_id) || 0) + 1);
  const mine = new Set(myIds);
  return res.json({ channels: channels.map((item) => ({ ...item, subscriberCount: counts.get(item.id) || 0, subscribed: mine.has(item.id) })) });
});

router.post('/', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const title = text(req.body?.title, 60);
  const description = text(req.body?.description, 500);
  if (req.body?.isPrivate !== undefined && typeof req.body.isPrivate !== 'boolean') return res.status(400).json({ error: 'isPrivate must be true or false' });
  const isPrivate = req.body?.isPrivate === true;
  if (title.length < 2) return res.status(400).json({ error: 'Channel name must be 2–60 characters' });
  if (typeof req.body?.title !== 'string' || req.body.title.trim().length > 60) return res.status(400).json({ error: 'Channel name must be 2–60 characters' });
  if (typeof req.body?.description === 'string' && req.body.description.trim().length > 500) return res.status(400).json({ error: 'Description must be 500 characters or fewer' });
  const { data: channel, error } = await supabaseAdmin.from('channels').insert({ owner_id: req.user.id, title, description, is_private: isPrivate }).select('id, owner_id, title, description, is_private, created_at, updated_at').single();
  if (error) return res.status(500).json({ error: 'Unable to create channel' });
  const { error: subError } = await supabaseAdmin.from('channel_subscriptions').insert({ channel_id: channel.id, user_id: req.user.id });
  if (subError) {
    await supabaseAdmin.from('channels').delete().eq('id', channel.id).eq('owner_id', req.user.id);
    return res.status(500).json({ error: 'Unable to initialize channel subscription' });
  }
  return res.status(201).json({ channel: { ...channel, subscriberCount: 1, subscribed: true } });
});

router.post('/:channelId/subscribe', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.is_private && channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Private channels require an invitation' });
  const { error } = await supabaseAdmin.from('channel_subscriptions').upsert({ channel_id: channel.id, user_id: req.user.id }, { onConflict: 'channel_id,user_id', ignoreDuplicates: true });
  if (error) return res.status(500).json({ error: 'Unable to subscribe to channel' });
  return res.json({ subscribed: true });
});

router.delete('/:channelId/subscribe', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id === req.user.id) return res.status(400).json({ error: 'The channel owner cannot unsubscribe from their own channel' });
  const { error: moderatorError } = await supabaseAdmin.from('channel_moderators').delete().eq('channel_id', channel.id).eq('user_id', req.user.id);
  if (moderatorError) return res.status(500).json({ error: 'Unable to remove channel moderator role' });
  const { error } = await supabaseAdmin.from('channel_subscriptions').delete().eq('channel_id', channel.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: 'Unable to unsubscribe from channel' });
  return res.json({ subscribed: false });
});

router.patch('/:channelId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const title = text(req.body?.title, 60);
  const description = text(req.body?.description, 500);
  if (req.body?.isPrivate !== undefined && typeof req.body.isPrivate !== 'boolean') return res.status(400).json({ error: 'isPrivate must be true or false' });
  if (typeof req.body?.title !== 'string' || title.length < 2 || req.body.title.trim().length > 60) {
    return res.status(400).json({ error: 'Channel name must be 2–60 characters' });
  }
  if (typeof req.body?.description !== 'string' || req.body.description.trim().length > 500) {
    return res.status(400).json({ error: 'Description must be 500 characters or fewer' });
  }
  const { data: channel, error: lookupError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (lookupError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can edit channel details' });
  const { data: updated, error } = await supabaseAdmin.from('channels').update({ title, description, ...(req.body?.isPrivate === undefined ? {} : { is_private: req.body.isPrivate }), updated_at: new Date().toISOString() })
    .eq('id', channel.id).eq('owner_id', req.user.id).select('id, owner_id, title, description, is_private, created_at, updated_at').maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to update channel details' });
  if (!updated) return res.status(404).json({ error: 'Channel not found' });
  return res.json({ channel: updated });
});

router.patch('/:channelId/posts/:postId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const body = text(req.body?.body, 4000);
  if (!body || typeof req.body?.body !== 'string' || req.body.body.trim().length > 4000) {
    return res.status(400).json({ error: 'Post must be 1–4000 characters' });
  }
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels')
    .select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!(await requireChannelAccess(res, channel, req.user.id))) return;
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can edit posts' });
  const { data: post, error } = await supabaseAdmin.from('channel_posts')
    .update({ body, edited_at: new Date().toISOString() })
    .eq('id', req.params.postId).eq('channel_id', channel.id)
    .select('id, channel_id, author_id, body, created_at, edited_at, is_pinned').maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to edit channel post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  return res.json({ post });
});

// Only the channel owner can appoint moderators. Every moderator must already subscribe.
router.get('/:channelId/moderators', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can manage moderators' });
  const [{ data: subs, error: subError }, { data: mods, error: modError }] = await Promise.all([
    supabaseAdmin.from('channel_subscriptions').select('user_id, created_at').eq('channel_id', channel.id).order('created_at', { ascending: true }).limit(500),
    supabaseAdmin.from('channel_moderators').select('user_id, created_at').eq('channel_id', channel.id),
  ]);
  if (subError || modError) return res.status(500).json({ error: 'Unable to load channel members' });
  const userIds = [...new Set((subs || []).map((row) => row.user_id).filter((id) => id !== channel.owner_id))];
  let profiles = [];
  if (userIds.length) {
    const { data, error } = await supabaseAdmin.from('profiles').select('id, name').in('id', userIds);
    if (error) return res.status(500).json({ error: 'Unable to load member profiles' });
    profiles = data || [];
  }
  const names = new Map(profiles.map((row) => [row.id, row.name]));
  const modIds = new Set((mods || []).map((row) => row.user_id));
  return res.json({ members: userIds.map((userId) => ({ userId, name: names.get(userId) || 'ZannyChat user', moderator: modIds.has(userId) })) });
});

router.post('/:channelId/moderators', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!userId || userId.length > 100) return res.status(400).json({ error: 'A valid subscribed user is required' });
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can appoint moderators' });
  if (userId === channel.owner_id) return res.status(400).json({ error: 'The channel owner is already an administrator' });
  const { data: subscription, error: subError } = await supabaseAdmin.from('channel_subscriptions').select('user_id').eq('channel_id', channel.id).eq('user_id', userId).maybeSingle();
  if (subError) return res.status(500).json({ error: 'Unable to check channel membership' });
  if (!subscription) return res.status(400).json({ error: 'Only channel subscribers can be moderators' });
  const { error } = await supabaseAdmin.from('channel_moderators').upsert({ channel_id: channel.id, user_id: userId }, { onConflict: 'channel_id,user_id', ignoreDuplicates: true });
  if (error) return res.status(500).json({ error: 'Unable to appoint moderator' });
  return res.json({ userId, moderator: true });
});

router.delete('/:channelId/moderators/:userId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can remove moderators' });
  const { error } = await supabaseAdmin.from('channel_moderators').delete().eq('channel_id', channel.id).eq('user_id', req.params.userId);
  if (error) return res.status(500).json({ error: 'Unable to remove moderator' });
  return res.json({ userId: req.params.userId, moderator: false });
});

router.put('/:channelId/posts/:postId/pin', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  if (typeof req.body?.pinned !== 'boolean') return res.status(400).json({ error: 'Pinned must be true or false' });
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels')
    .select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!(await requireChannelAccess(res, channel, req.user.id))) return;
  let canModerate = false;
  try { canModerate = await canModerateChannel(channel, req.user.id); } catch (_) { return res.status(500).json({ error: 'Unable to check channel permissions' }); }
  if (!canModerate) return res.status(403).json({ error: 'Only the channel owner or a channel moderator can pin posts' });
  const { data: post, error } = await supabaseAdmin.from('channel_posts')
    .update({ is_pinned: req.body.pinned })
    .eq('id', req.params.postId).eq('channel_id', channel.id)
    .select('id, channel_id, author_id, body, created_at, edited_at, is_pinned').maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to update pinned post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  return res.json({ post });
});

router.delete('/:channelId/posts/:postId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels')
    .select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!(await requireChannelAccess(res, channel, req.user.id))) return;
  let canModerate = false;
  try { canModerate = await canModerateChannel(channel, req.user.id); } catch (_) { return res.status(500).json({ error: 'Unable to check channel permissions' }); }
  if (!canModerate) return res.status(403).json({ error: 'Only the channel owner or a channel moderator can delete posts' });
  const { data: post, error } = await supabaseAdmin.from('channel_posts').delete()
    .eq('id', req.params.postId).eq('channel_id', channel.id)
    .select('id').maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to delete channel post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  return res.json({ deleted: true });
});

router.get('/:channelId/posts', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channelRow, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, title, description, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to load channel' });
  if (!channelRow) return res.status(404).json({ error: 'Channel not found' });
  if (!(await requireChannelAccess(res, channelRow, req.user.id))) return;
  const [{ data: subscription, error: subscriptionError }, { data: moderator, error: moderatorError }] = await Promise.all([
    supabaseAdmin.from('channel_subscriptions').select('channel_id').eq('channel_id', channelRow.id).eq('user_id', req.user.id).maybeSingle(),
    supabaseAdmin.from('channel_moderators').select('channel_id').eq('channel_id', channelRow.id).eq('user_id', req.user.id).maybeSingle(),
  ]);
  if (subscriptionError || moderatorError) return res.status(500).json({ error: 'Unable to load channel permissions' });
  const channel = { ...channelRow, subscribed: Boolean(subscription), isModerator: Boolean(subscription && moderator) };
  const pageSize = 100;
  let query = supabaseAdmin.from('channel_posts').select('id, channel_id, author_id, body, created_at, edited_at, is_pinned').eq('channel_id', channel.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(pageSize + 1);
  const beforeCreatedAt = typeof req.query.beforeCreatedAt === 'string' ? req.query.beforeCreatedAt : '';
  const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : '';
  if (beforeCreatedAt || beforeId) {
    const parsedCursorDate = new Date(beforeCreatedAt);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(beforeId);
    if (!beforeCreatedAt || Number.isNaN(parsedCursorDate.getTime()) || !isUuid) return res.status(400).json({ error: 'Invalid channel post cursor' });
    query = query.or(`created_at.lt.${parsedCursorDate.toISOString()},and(created_at.eq.${parsedCursorDate.toISOString()},id.lt.${beforeId})`);
  }
  const { data: fetchedPosts, error } = await query;
  if (error) return res.status(500).json({ error: 'Unable to load channel posts' });
  const hasMore = (fetchedPosts || []).length > pageSize;
  const posts = (fetchedPosts || []).slice(0, pageSize).sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || String(b.id).localeCompare(String(a.id)));
  const lastFetchedPost = hasMore ? (fetchedPosts || [])[pageSize - 1] : null;
  const nextCursor = lastFetchedPost ? { created_at: lastFetchedPost.created_at, id: lastFetchedPost.id } : null;
  const postIds = (posts || []).map((post) => post.id);
  if (!postIds.length) return res.json({ channel, posts: [], nextCursor: null, hasMore: false });
  // Count distinct authenticated viewers per post. The composite key makes repeated
  // pagination/refreshes idempotent; this is not a count of every impression.
  const { error: viewWriteError } = await supabaseAdmin.from('channel_post_views')
    .upsert(postIds.map((postId) => ({ post_id: postId, user_id: req.user.id })), { onConflict: 'post_id,user_id', ignoreDuplicates: true });
  if (viewWriteError) return res.status(500).json({ error: 'Unable to record channel post views' });
  const [{ data: reactions, error: reactionError }, { data: commentRows, error: commentsError }, { data: viewRows, error: viewsError }] = await Promise.all([
    supabaseAdmin.from('channel_post_reactions').select('post_id, user_id, emoji').in('post_id', postIds),
    supabaseAdmin.from('channel_post_comments').select('post_id').in('post_id', postIds),
    supabaseAdmin.from('channel_post_views').select('post_id').in('post_id', postIds),
  ]);
  if (reactionError) return res.status(500).json({ error: 'Unable to load channel reactions' });
  if (commentsError) return res.status(500).json({ error: 'Unable to load channel comment counts' });
  if (viewsError) return res.status(500).json({ error: 'Unable to load channel post views' });
  const grouped = new Map();
  for (const row of reactions || []) {
    if (!grouped.has(row.post_id)) grouped.set(row.post_id, []);
    grouped.get(row.post_id).push(row);
  }
  const commentCounts = new Map();
  for (const row of commentRows || []) commentCounts.set(row.post_id, (commentCounts.get(row.post_id) || 0) + 1);
  const viewCounts = new Map();
  for (const row of viewRows || []) viewCounts.set(row.post_id, (viewCounts.get(row.post_id) || 0) + 1);
  return res.json({ channel, nextCursor, hasMore, posts: (posts || []).map((post) => {
    const rows = grouped.get(post.id) || [];
    const counts = {};
    for (const row of rows) counts[row.emoji] = (counts[row.emoji] || 0) + 1;
    return { ...post, reactionCounts: counts, myReaction: rows.find((row) => row.user_id === req.user.id)?.emoji || null, commentCount: commentCounts.get(post.id) || 0, viewCount: viewCounts.get(post.id) || 0 };
  }) });
});

const CHANNEL_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '👏']);
router.put('/:channelId/posts/:postId/reaction', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const emoji = req.body?.emoji;
  if (emoji !== null && !CHANNEL_REACTION_EMOJIS.has(emoji)) return res.status(400).json({ error: 'Choose a supported reaction or clear your reaction' });
  const { data: post, error: postError } = await supabaseAdmin.from('channel_posts').select('id, channel_id').eq('id', req.params.postId).eq('channel_id', req.params.channelId).maybeSingle();
  if (postError) return res.status(500).json({ error: 'Unable to check channel post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  const { data: accessChannel, error: accessError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', post.channel_id).maybeSingle();
  if (accessError) return res.status(500).json({ error: 'Unable to check channel access' });
  if (!(await requireChannelAccess(res, accessChannel, req.user.id))) return;
  if (emoji === null) {
    const { error } = await supabaseAdmin.from('channel_post_reactions').delete().eq('post_id', post.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Unable to clear reaction' });
    return res.json({ postId: post.id, myReaction: null });
  }
  const { error } = await supabaseAdmin.from('channel_post_reactions').upsert({ post_id: post.id, user_id: req.user.id, emoji, updated_at: new Date().toISOString() }, { onConflict: 'post_id,user_id' });
  if (error) return res.status(500).json({ error: 'Unable to save reaction' });
  return res.json({ postId: post.id, myReaction: emoji });
});

router.post('/:channelId/posts', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const body = text(req.body?.body, 4000);
  if (!body) return res.status(400).json({ error: 'Post text is required' });
  if (typeof req.body?.body !== 'string' || req.body.body.trim().length > 4000) return res.status(400).json({ error: 'Post must be 1–4000 characters' });
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!(await requireChannelAccess(res, channel, req.user.id))) return;
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can publish posts' });
  const requestId = typeof req.body?.clientRequestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.body.clientRequestId)
    ? req.body.clientRequestId.toLowerCase() : null;
  const selectedColumns = 'id, channel_id, author_id, body, created_at, edited_at, is_pinned';
  if (requestId) {
    const { data: existing, error: lookupError } = await supabaseAdmin.from('channel_posts')
      .select(selectedColumns).eq('channel_id', channel.id).eq('author_id', req.user.id)
      .eq('client_request_id', requestId).maybeSingle();
    if (lookupError) return res.status(500).json({ error: 'Unable to verify channel post retry' });
    if (existing) {
      if (existing.body !== body) return res.status(409).json({ error: 'This publish request ID was already used for different content' });
      return res.status(200).json({ post: existing, deduplicated: true });
    }
  }
  const payload = { channel_id: channel.id, author_id: req.user.id, body };
  if (requestId) payload.client_request_id = requestId;
  const { data: post, error } = await supabaseAdmin.from('channel_posts').insert(payload).select(selectedColumns).single();
  if (error) {
    // A concurrent retry may win the unique-index race after the lookup above.
    if (requestId && error.code === '23505') {
      const { data: existing, error: lookupError } = await supabaseAdmin.from('channel_posts')
        .select(selectedColumns).eq('channel_id', channel.id).eq('author_id', req.user.id)
        .eq('client_request_id', requestId).maybeSingle();
      if (!lookupError && existing) {
        if (existing.body !== body) return res.status(409).json({ error: 'This publish request ID was already used for different content' });
        return res.status(200).json({ post: existing, deduplicated: true });
      }
    }
    return res.status(500).json({ error: 'Unable to publish channel post' });
  }
  return res.status(201).json({ post });
});

router.get('/:channelId/posts/:postId/comments', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: post, error: postError } = await supabaseAdmin.from('channel_posts').select('id, channel_id').eq('id', req.params.postId).eq('channel_id', req.params.channelId).maybeSingle();
  if (postError) return res.status(500).json({ error: 'Unable to check channel post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  const { data: accessChannel, error: accessError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', post.channel_id).maybeSingle();
  if (accessError) return res.status(500).json({ error: 'Unable to check channel access' });
  if (!(await requireChannelAccess(res, accessChannel, req.user.id))) return;
  const { data: rows, error } = await supabaseAdmin.from('channel_post_comments').select('id, post_id, user_id, body, created_at, updated_at').eq('post_id', post.id).order('created_at', { ascending: true }).limit(100);
  if (error) return res.status(500).json({ error: 'Unable to load channel comments' });
  const userIds = [...new Set((rows || []).map((row) => row.user_id))];
  let profiles = [];
  if (userIds.length) {
    const { data, error: profileError } = await supabaseAdmin.from('profiles').select('id, name').in('id', userIds);
    if (profileError) return res.status(500).json({ error: 'Unable to load comment authors' });
    profiles = data || [];
  }
  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  return res.json({ comments: (rows || []).map((row) => ({ ...row, authorName: names.get(row.user_id) || 'ZannyChat user', mine: row.user_id === req.user.id })) });
});

router.post('/:channelId/posts/:postId/comments', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const body = text(req.body?.body, 1000);
  if (!body || typeof req.body?.body !== 'string' || req.body.body.trim().length > 1000) return res.status(400).json({ error: 'Comment must be 1–1000 characters' });
  const { data: post, error: postError } = await supabaseAdmin.from('channel_posts').select('id, channel_id').eq('id', req.params.postId).eq('channel_id', req.params.channelId).maybeSingle();
  if (postError) return res.status(500).json({ error: 'Unable to check channel post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  const { data: accessChannel, error: accessError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', post.channel_id).maybeSingle();
  if (accessError) return res.status(500).json({ error: 'Unable to check channel access' });
  if (!(await requireChannelAccess(res, accessChannel, req.user.id))) return;
  const [{ data: channel, error: channelError }, { data: subscription, error: subscriptionError }] = await Promise.all([
    supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', post.channel_id).maybeSingle(),
    supabaseAdmin.from('channel_subscriptions').select('channel_id').eq('channel_id', post.channel_id).eq('user_id', req.user.id).maybeSingle(),
  ]);
  if (channelError || subscriptionError) return res.status(500).json({ error: 'Unable to check comment permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id && !subscription) return res.status(403).json({ error: 'Subscribe to the channel before commenting' });
  const { data: comment, error } = await supabaseAdmin.from('channel_post_comments').insert({ post_id: post.id, user_id: req.user.id, body }).select('id, post_id, user_id, body, created_at, updated_at').single();
  if (error) return res.status(500).json({ error: 'Unable to publish comment' });
  return res.status(201).json({ comment: { ...comment, authorName: 'You', mine: true } });
});

router.delete('/:channelId/posts/:postId/comments/:commentId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: post, error: postError } = await supabaseAdmin.from('channel_posts').select('id, channel_id').eq('id', req.params.postId).eq('channel_id', req.params.channelId).maybeSingle();
  if (postError) return res.status(500).json({ error: 'Unable to check channel post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  const { data: comment, error: commentError } = await supabaseAdmin.from('channel_post_comments').select('id, user_id').eq('id', req.params.commentId).eq('post_id', post.id).maybeSingle();
  if (commentError) return res.status(500).json({ error: 'Unable to check comment permissions' });
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', post.channel_id).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!(await requireChannelAccess(res, channel, req.user.id))) return;
  let canModerate = false;
  try { canModerate = channel ? await canModerateChannel(channel, req.user.id) : false; } catch (_) { return res.status(500).json({ error: 'Unable to check channel permissions' }); }
  if (comment.user_id !== req.user.id && !canModerate) return res.status(403).json({ error: 'Only the comment author, channel owner, or moderator can delete this comment' });
  const { error } = await supabaseAdmin.from('channel_post_comments').delete().eq('id', comment.id);
  if (error) return res.status(500).json({ error: 'Unable to delete comment' });
  return res.json({ deleted: true });
});

const CHANNEL_REPORT_REASONS = new Set(['spam', 'harassment', 'hate', 'misinformation', 'other']);
router.post('/:channelId/posts/:postId/reports', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const reason = req.body?.reason;
  const details = text(req.body?.details, 500);
  if (!CHANNEL_REPORT_REASONS.has(reason)) return res.status(400).json({ error: 'Choose a supported report reason' });
  if (typeof req.body?.details === 'string' && req.body.details.trim().length > 500) return res.status(400).json({ error: 'Report details must be 500 characters or fewer' });
  const { data: post, error: postError } = await supabaseAdmin.from('channel_posts').select('id, channel_id, author_id').eq('id', req.params.postId).eq('channel_id', req.params.channelId).maybeSingle();
  if (postError) return res.status(500).json({ error: 'Unable to check channel post' });
  if (!post) return res.status(404).json({ error: 'Channel post not found' });
  const { data: accessChannel, error: accessError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', post.channel_id).maybeSingle();
  if (accessError) return res.status(500).json({ error: 'Unable to check channel access' });
  if (!(await requireChannelAccess(res, accessChannel, req.user.id))) return;
  if (post.author_id === req.user.id) return res.status(400).json({ error: 'You cannot report your own post' });
  const { data: existing, error: existingError } = await supabaseAdmin.from('channel_post_reports').select('id, status').eq('post_id', post.id).eq('reporter_id', req.user.id).maybeSingle();
  if (existingError) return res.status(500).json({ error: 'Unable to check previous report' });
  if (existing) return res.status(409).json({ error: 'You have already reported this post' });
  const { data: report, error } = await supabaseAdmin.from('channel_post_reports').insert({ post_id: post.id, channel_id: post.channel_id, reporter_id: req.user.id, reason, details: details || null }).select('id, post_id, reason, details, status, created_at').single();
  if (error) return res.status(500).json({ error: 'Unable to submit report' });
  return res.status(201).json({ report });
});

router.get('/:channelId/reports', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  let canModerate = false;
  try { canModerate = await canModerateChannel(channel, req.user.id); } catch (_) { return res.status(500).json({ error: 'Unable to check channel permissions' }); }
  if (!canModerate) return res.status(403).json({ error: 'Only channel owners and moderators can review reports' });
  const { data: rows, error } = await supabaseAdmin.from('channel_post_reports').select('id, post_id, reporter_id, reason, details, status, created_at, reviewed_at').eq('channel_id', channel.id).eq('status', 'open').order('created_at', { ascending: true }).limit(100);
  if (error) return res.status(500).json({ error: 'Unable to load channel reports' });
  const postIds = [...new Set((rows || []).map((row) => row.post_id))];
  const userIds = [...new Set((rows || []).map((row) => row.reporter_id))];
  const [{ data: posts, error: postsError }, { data: profiles, error: profilesError }] = await Promise.all([
    postIds.length ? supabaseAdmin.from('channel_posts').select('id, body, author_id').in('id', postIds) : Promise.resolve({ data: [], error: null }),
    userIds.length ? supabaseAdmin.from('profiles').select('id, name').in('id', userIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (postsError || profilesError) return res.status(500).json({ error: 'Unable to load report context' });
  const postMap = new Map((posts || []).map((row) => [row.id, row]));
  const names = new Map((profiles || []).map((row) => [row.id, row.name]));
  return res.json({ reports: (rows || []).map((row) => ({ ...row, postBody: postMap.get(row.post_id)?.body || '[Post deleted]', reporterName: names.get(row.reporter_id) || 'ZannyChat user' })) });
});

router.patch('/:channelId/reports/:reportId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const status = req.body?.status;
  if (!['reviewed', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Report status must be reviewed or dismissed' });
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  let canModerate = false;
  try { canModerate = await canModerateChannel(channel, req.user.id); } catch (_) { return res.status(500).json({ error: 'Unable to check channel permissions' }); }
  if (!canModerate) return res.status(403).json({ error: 'Only channel owners and moderators can review reports' });
  const { data: report, error } = await supabaseAdmin.from('channel_post_reports').update({ status, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() }).eq('id', req.params.reportId).eq('channel_id', channel.id).eq('status', 'open').select('id, status, reviewed_at').maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to update report status' });
  if (!report) return res.status(404).json({ error: 'Open report not found' });
  return res.json({ report });
});

// Owner-created invitation tokens are stored only as SHA-256 hashes; the raw token is returned once.
router.post('/:channelId/invites', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can create invitations' });
  const token = crypto.randomBytes(24).toString('base64url');
  const maxUses = Number.isInteger(req.body?.maxUses) ? Math.max(1, Math.min(500, req.body.maxUses)) : 50;
  const expiresInDays = Number.isInteger(req.body?.expiresInDays) ? Math.max(1, Math.min(90, req.body.expiresInDays)) : 7;
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const { data: invite, error } = await supabaseAdmin.from('channel_invites').insert({ channel_id: channel.id, created_by: req.user.id, token_hash: hashInvite(token), max_uses: maxUses, expires_at: expiresAt }).select('id, channel_id, max_uses, use_count, expires_at, created_at').single();
  if (error) return res.status(500).json({ error: 'Unable to create channel invitation' });
  return res.status(201).json({ invite: { ...invite, token } });
});

router.post('/invites/accept', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(token)) return res.status(400).json({ error: 'Enter a valid channel invitation token' });
  const { data: rows, error } = await supabaseAdmin.rpc('accept_channel_invite', { p_token_hash: hashInvite(token), p_user_id: req.user.id });
  if (error) return res.status(500).json({ error: 'Unable to accept channel invitation' });
  const channel = Array.isArray(rows) ? rows[0] : rows;
  if (!channel) return res.status(404).json({ error: 'Invitation is invalid, expired, or fully used' });
  return res.json({ channel: { ...channel, subscribed: true }, subscribed: true });
});

router.get('/:channelId/invites', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can manage invitations' });
  const { data, error } = await supabaseAdmin.from('channel_invites').select('id, max_uses, use_count, expires_at, revoked_at, created_at').eq('channel_id', channel.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'Unable to load channel invitations' });
  return res.json({ invites: data || [] });
});

router.delete('/:channelId/invites/:inviteId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: channelError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (channelError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can revoke invitations' });
  const { data, error } = await supabaseAdmin.from('channel_invites').update({ revoked_at: new Date().toISOString() }).eq('channel_id', channel.id).eq('id', req.params.inviteId).is('revoked_at', null).select('id').maybeSingle();
  if (error) return res.status(500).json({ error: 'Unable to revoke invitation' });
  if (!data) return res.status(404).json({ error: 'Active invitation not found' });
  return res.json({ revoked: true });
});

router.delete('/:channelId', async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data: channel, error: lookupError } = await supabaseAdmin.from('channels').select('id, owner_id, is_private').eq('id', req.params.channelId).maybeSingle();
  if (lookupError) return res.status(500).json({ error: 'Unable to check channel permissions' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the channel owner can delete it' });
  const { error } = await supabaseAdmin.from('channels').delete().eq('id', channel.id).eq('owner_id', req.user.id);
  if (error) return res.status(500).json({ error: 'Unable to delete channel' });
  return res.json({ deleted: true });
});

module.exports = router;
