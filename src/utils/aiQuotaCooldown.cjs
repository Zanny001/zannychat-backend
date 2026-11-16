const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
let quotaUnavailableUntil = 0;

function markAiQuotaUnavailable(now = Date.now(), cooldownMs = DEFAULT_QUOTA_COOLDOWN_MS) {
  const duration = Number.isFinite(cooldownMs) ? Math.max(0, Math.min(cooldownMs, 60 * 60 * 1000)) : DEFAULT_QUOTA_COOLDOWN_MS;
  quotaUnavailableUntil = Math.max(quotaUnavailableUntil, now + duration);
  return quotaUnavailableUntil;
}

function isAiQuotaCooldownActive(now = Date.now()) {
  return now < quotaUnavailableUntil;
}

function clearAiQuotaCooldown() {
  quotaUnavailableUntil = 0;
}

module.exports = {
  DEFAULT_QUOTA_COOLDOWN_MS,
  markAiQuotaUnavailable,
  isAiQuotaCooldownActive,
  clearAiQuotaCooldown,
};
