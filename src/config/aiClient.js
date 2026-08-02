// Thin wrapper around Anthropic's Messages API. Deliberately plain
// fetch (Node 18+ has it natively) rather than pulling in the SDK —
// one call site, doesn't need the extra dependency weight.
//
// Every AI route checks isAiConfigured() before calling this, so a
// missing key produces a clean 501 from the route, not a confusing
// crash in here.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function isAiConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

async function askClaude({ system, messages, maxTokens = 400 }) {
  if (!isAiConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API error (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text ?? '';
}

module.exports = { askClaude, isAiConfigured, ANTHROPIC_MODEL };
