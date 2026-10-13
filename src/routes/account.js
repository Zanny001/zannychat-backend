const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/requireAuth');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();
const deletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many deletion attempts. Please wait and try again.' }),
});

router.use(requireAuth, deletionLimiter);

// POST /account/delete { confirmation: "DELETE" }
// The client must first re-authenticate with the account password. We also
// enforce a fresh auth_time server-side, so a stolen old session alone is not
// enough to destroy an account. A pending migration makes replies to deleted
// messages nullable, allowing account cleanup to complete without broken refs.
router.post('/delete', async (req, res) => {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Backend is not configured' });
  if (req.body?.confirmation !== 'DELETE') {
    return res.status(400).json({ error: 'Explicit DELETE confirmation is required' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (!req.authTime || req.authTime > now + 60 || now - req.authTime > 5 * 60) {
    return res.status(403).json({ error: 'For your security, verify your password again before deleting your account.' });
  }

  try {
    // The 0013 migration installs a database trigger that removes empty
    // direct conversations transactionally as participant rows cascade. This
    // avoids deleting chats before knowing that Auth deletion will succeed.
    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (deleteUserError) return res.status(500).json({ error: 'Account deletion failed. Please contact support if this continues.' });
    return res.status(200).json({ deleted: true });
  } catch (_) {
    return res.status(500).json({ error: 'Account deletion failed. Please try again or contact support.' });
  }
});

module.exports = router;
