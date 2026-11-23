const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
const { askClaude, DEFAULT_TIMEOUT_MS } = require('../src/config/aiClient');

test('Anthropic requests have a bounded default lifetime', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);
});

test('askClaude passes a timeout signal and returns provider translation text', async () => {
  let received;
  const result = await askClaude({
    system: 'Translate faithfully',
    messages: [{ role: 'user', content: 'Hello' }],
    fetchImpl: async (_url, options) => {
      received = options;
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'Bonjour' }] }),
      };
    },
  });
  assert.equal(result, 'Bonjour');
  assert.equal(received.method, 'POST');
  assert.equal(received.signal instanceof AbortSignal, true);
  assert.equal(received.headers['x-api-key'], 'test-anthropic-key');
});

test('askClaude aborts a provider request that exceeds its deadline', async () => {
  await assert.rejects(
    askClaude({
      system: 'Translate faithfully',
      messages: [{ role: 'user', content: 'Hello' }],
      timeoutMs: 10,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    }),
    (error) => error.name === 'TimeoutError' && error.code === 'ETIMEDOUT',
  );
});

test('askClaude propagates caller cancellation instead of reporting a provider timeout', async () => {
  const controller = new AbortController();
  const request = askClaude({
    system: 'Translate faithfully',
    messages: [{ role: 'user', content: 'Hello' }],
    timeoutMs: 1000,
    signal: controller.signal,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  controller.abort(new DOMException('Cancelled by caller', 'AbortError'));
  await assert.rejects(request, (error) => error.name === 'AbortError');
});
