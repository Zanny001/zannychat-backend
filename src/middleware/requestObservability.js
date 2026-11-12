const { randomUUID } = require('node:crypto');

function requestObservability(req, res, next) {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();

  res.setHeader('X-Request-Id', requestId);
  res.once('finish', () => {
    // Use Express's matched route template, never req.url/originalUrl, because
    // URLs may contain message IDs, invite tokens, search terms, or other data.
    const route = req.route?.path;
    const routeLabel = route
      ? `${req.baseUrl || ''}${route}`
      : (req.path === '/' ? '/' : 'unmatched');
    const statusCode = res.statusCode;
    const event = {
      timestamp: new Date().toISOString(),
      level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
      event: 'http_request',
      requestId,
      method: req.method,
      route: routeLabel,
      statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    };
    console.log(JSON.stringify(event));
  });

  next();
}

module.exports = { requestObservability };
