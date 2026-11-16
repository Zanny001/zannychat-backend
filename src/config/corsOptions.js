const DEFAULT_PRODUCTION_ORIGIN = 'https://zannychat.netlify.app';
const LEGACY_PRODUCTION_ORIGINS = ['https://zannychat-app.netlify.app'];
const VERCEL_PRODUCTION_ORIGIN = 'https://zannychat.vercel.app';

function parseAllowedOrigins(value = process.env.CORS_ORIGINS) {
  const configured = typeof value === 'string' ? value.split(',') : [];
  const origins = [...configured, DEFAULT_PRODUCTION_ORIGIN, ...LEGACY_PRODUCTION_ORIGINS, VERCEL_PRODUCTION_ORIGIN]
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV !== 'production') {
    origins.push('http://localhost:19006', 'http://localhost:8081', 'http://127.0.0.1:19006', 'http://127.0.0.1:8081');
  }
  return new Set(origins);
}

function createCorsOptions(allowedOrigins = parseAllowedOrigins()) {
  return {
    origin(origin, callback) {
      // Native clients and server-to-server requests do not send Origin.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      const error = new Error('Origin not allowed by CORS');
      error.status = 403;
      // Record only the browser Origin header (not path, query, cookies or
      // request body) so rejected preview/custom domains can be diagnosed.
      error.corsOrigin = String(origin).replace(/[\r\n\t\x00-\x1f\x7f]/g, '').slice(0, 255);
      return callback(error);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
    optionsSuccessStatus: 204,
    maxAge: 600,
  };
}

module.exports = {
  DEFAULT_PRODUCTION_ORIGIN,
  LEGACY_PRODUCTION_ORIGINS,
  VERCEL_PRODUCTION_ORIGIN,
  parseAllowedOrigins,
  createCorsOptions,
};
