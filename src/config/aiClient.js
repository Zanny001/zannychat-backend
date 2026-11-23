// Thin wrapper around Anthropic's Messages API. Deliberately plain
// fetch (Node 18+ has it natively) rather than pulling in the SDK —
// one call site, doesn't need the extra dependency weight.
//
// Every AI route checks isAiConfigured() before calling this, so a
// missing key produces a clean 501 from the route, not a confusing
// crash in here.

const { isAiQuotaUnavailable } = require('../utils/aiProviderFailure.cjs');
const { markAiQuotaUnavailable, isAiQuotaCooldownActive } = require('../utils/aiQuotaCooldown.cjs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const DEFAULT_TIMEOUT_MS = 15000;

function isAiConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

async function askClaude({
  system,
  messages,
  maxTokens = 400,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  fetchImpl = fetch,
}) {
  if (!isAiConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  if (isAiQuotaCooldownActive()) {
    const error = new Error('AI provider quota is temporarily unavailable');
    error.code = 'AI_TEMPORARILY_UNAVAILABLE';
    throw error;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new TypeError('AI provider timeout must be between 1 and 120000 milliseconds');
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response;
  try {
    response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system,
        messages,
      }),
      signal: requestSignal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`Anthropic API error (${response.status}): ${body.slice(0, 300)}`);
      if (isAiQuotaUnavailable(error)) markAiQuotaUnavailable();
      throw error;
    }

    const data = await response.json();
    return data.content?.[0]?.text ?? '';
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      const timeoutError = new Error('AI provider request timed out');
      timeoutError.name = 'TimeoutError';
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  }
}

module.exports = { askClaude, isAiConfigured, ANTHROPIC_MODEL, DEFAULT_TIMEOUT_MS };
