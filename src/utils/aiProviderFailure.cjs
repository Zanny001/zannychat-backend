function isAiQuotaUnavailable(error) {
  const message = String(error?.message || error || '');
  return /credit balance is too low|insufficient[_ ]quota|out of credits|billing.{0,40}credits?/i.test(message);
}

function respondToAiFailure(res, error) {
  if (isAiQuotaUnavailable(error)) {
    // Billing/quota exhaustion is an expected temporary feature outage,
    // not an application crash. Never expose provider billing details.
    console.warn('[ai] provider quota unavailable; AI request skipped');
    return res.status(503).json({
      error: 'AI features are temporarily unavailable. You can continue chatting normally.',
      code: 'AI_TEMPORARILY_UNAVAILABLE',
    });
  }

  // Provider payloads can contain internal request metadata. Keep public
  // responses and operational logs generic.
  console.error('[ai] request failed');
  return res.status(500).json({ error: 'Unable to complete AI request' });
}

module.exports = { isAiQuotaUnavailable, respondToAiFailure };
