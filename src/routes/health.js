const express = require('express');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'zannychat-backend',
    supabaseConfigured: Boolean(supabaseAdmin),
    time: new Date().toISOString(),
  });
});

module.exports = router;
