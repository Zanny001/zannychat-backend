require('dotenv').config();
const express = require('express');
const cors = require('cors');

const healthRouter = require('./routes/health');
const conversationsRouter = require('./routes/conversations');
const walletRouter = require('./routes/wallet');
const webhooksRouter = require('./routes/webhooks');
const aiRouter = require('./routes/ai');

const app = express();

app.use(cors());

// Mounted before the global JSON parser — the Stripe route needs the
// raw request body to verify its signature.
app.use('/webhooks', webhooksRouter);

app.use(express.json());

app.use('/health', healthRouter);
app.use('/conversations', conversationsRouter);
app.use('/wallet', walletRouter);
app.use('/ai', aiRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ZannyChat backend listening on port ${PORT}`);
});

module.exports = app;
