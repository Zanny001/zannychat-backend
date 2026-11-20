const {
  DEFAULT_PRODUCTION_ORIGIN,
  LEGACY_PRODUCTION_ORIGINS,
  parseAllowedOrigins,
  createCorsOptions,
} = require('../src/config/corsOptions');

describe('CORS production origins', () => {
  const previousNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  test('allows the canonical Vercel production site by default', () => {
    expect(DEFAULT_PRODUCTION_ORIGIN).toBe('https://zannychat.vercel.app');
    expect(parseAllowedOrigins()).toContain('https://zannychat.vercel.app');
  });

  test('continues allowing both previous Netlify sites as legacy origins', () => {
    expect(LEGACY_PRODUCTION_ORIGINS).toContain('https://zannychat.netlify.app');
    expect(LEGACY_PRODUCTION_ORIGINS).toContain('https://zannychat-app.netlify.app');
    expect(parseAllowedOrigins()).toContain('https://zannychat.netlify.app');
    expect(parseAllowedOrigins()).toContain('https://zannychat-app.netlify.app');
  });

  test('retains explicitly configured origins', () => {
    expect(parseAllowedOrigins('https://custom.example')).toContain('https://custom.example');
  });

  test('rejects unrelated browser origins', (done) => {
    createCorsOptions().origin('https://untrusted.example', (error, allowed) => {
      expect(error).toBeInstanceOf(Error);
      expect(error.status).toBe(403);
      expect(allowed).toBeUndefined();
      done();
    });
  });

  test('allows native and server-to-server requests without an Origin header', (done) => {
    createCorsOptions().origin(undefined, (error, allowed) => {
      expect(error).toBeNull();
      expect(allowed).toBe(true);
      done();
    });
  });
});


test('rejected CORS origins are attached to the error in a bounded, control-character-safe form', (done) => {
  createCorsOptions().origin('https://untrusted.example\nforged', (error, allowed) => {
    expect(allowed).toBeUndefined();
    expect(error.status).toBe(403);
    expect(error.corsOrigin).toBe('https://untrusted.exampleforged');
    expect(error.corsOrigin.length).toBeLessThanOrEqual(255);
    done();
  });
});
