const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { aiLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../config/supabaseAdmin');
const { askClaude, isAiConfigured } = require('../config/aiClient');

const router = express.Router();

// Every route in this router spends real Anthropic tokens, so the
// per-user throttle (auth first, so it keys on the user id) is part of
// the route definition itself — the Oct 2026 audit found unlimited AI
// calls were the most exploitable gap in the app.
router.use(requireAuth, aiLimiter);

// Every route here spends real API tokens on someone's behalf, so
// before doing anything else each one confirms the caller is actually
// a participant in the conversation they're asking about — the same
// membership check RLS would apply on the client, done explicitly here
// since this uses the service-role client (which bypasses RLS).
async function assertParticipant(conversationId, userId) {
  const { data, error } = await supabaseAdmin
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[ai] conversation membership lookup failed:', error.message);
    throw new Error('AI conversation lookup failed');
  }
  return Boolean(data);
}

async function fetchRecentMessages(conversationId, limit = 20) {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('sender_id, text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[ai] message lookup failed:', error.message);
    throw new Error('AI message lookup failed');
  }
  return data.reverse(); // chronological order for the model
}

function transcriptFor(messages, userId) {
  return messages
    .map((m) => `${m.sender_id === userId ? 'Me' : 'Them'}: ${m.text}`)
    .join('\n');
}

// POST /ai/smart-replies { conversationId }
// Returns up to 3 short suggested replies to the most recent message —
// only useful (and only called by the frontend) when that message
// isn't the user's own.
router.post('/smart-replies', async (req, res) => {
  if (!isAiConfigured()) return res.status(501).json({ error: 'AI features are not configured on this backend yet' });

  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  try {
    if (!(await assertParticipant(conversationId, req.user.id))) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const messages = await fetchRecentMessages(conversationId, 12);
    if (messages.length === 0) return res.json({ suggestions: [] });

    const transcript = transcriptFor(messages, req.user.id);
    const raw = await askClaude({
      system:
        'You suggest quick replies for a chat app called ZannyChat. Given the tail of a conversation, ' +
        'suggest exactly 3 short, natural replies "Me" could send next. Reply with ONLY a JSON array of ' +
        '3 short strings — no markdown, no explanation, no code fences.',
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 200,
    });

    let suggestions;
    try {
      suggestions = JSON.parse(raw.trim());
    } catch (parseErr) {
      console.warn('[ai/smart-replies] provider returned invalid JSON');
      return res.status(502).json({ error: "AI response wasn't valid JSON" });
    }

    res.json({ suggestions: Array.isArray(suggestions) ? suggestions.slice(0, 3) : [] });
  } catch (err) {
    console.error('[ai] request failed:', err.message);
    res.status(500).json({ error: 'Unable to complete AI request' });
  }
});

// POST /ai/summarize { conversationId }
// Returns a short bullet-point summary of the conversation so far.
router.post('/summarize', async (req, res) => {
  if (!isAiConfigured()) return res.status(501).json({ error: 'AI features are not configured on this backend yet' });

  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  try {
    if (!(await assertParticipant(conversationId, req.user.id))) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const messages = await fetchRecentMessages(conversationId, 50);
    if (messages.length === 0) return res.json({ summary: 'Nothing to summarize yet.' });

    const transcript = transcriptFor(messages, req.user.id);
    const summary = await askClaude({
      system:
        'Summarize this chat conversation into 3-5 short bullet points covering the key topics and any ' +
        'decisions made. Reply with ONLY the bullet points, one per line, each starting with "- ". No ' +
        'preamble, no closing remarks.',
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 250,
    });

    res.json({ summary: summary.trim() });
  } catch (err) {
    console.error('[ai] request failed:', err.message);
    res.status(500).json({ error: 'Unable to complete AI request' });
  }
});

// POST /ai/translate { text, targetLanguage }
// Standalone — doesn't need a conversationId, just the text to
// translate, so the frontend can use it on any single message.
router.post('/translate', async (req, res) => {
  if (!isAiConfigured()) return res.status(501).json({ error: 'AI features are not configured on this backend yet' });

  const { text, targetLanguage } = req.body || {};
  if (!text || !targetLanguage) return res.status(400).json({ error: 'text and targetLanguage are required' });

  try {
    const translated = await askClaude({
      system: `Translate the user's message into ${targetLanguage}. Reply with ONLY the translated text — no notes, no quotation marks, no explanation.`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 200,
    });
    res.json({ translated: translated.trim() });
  } catch (err) {
    console.error('[ai] request failed:', err.message);
    res.status(500).json({ error: 'Unable to complete AI request' });
  }
});

module.exports = router;
