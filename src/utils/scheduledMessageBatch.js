const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

function getScheduledMessageBatchSize(value = process.env.SCHEDULED_MESSAGES_BATCH_SIZE) {
  if (value == null || String(value).trim() === '') return DEFAULT_BATCH_SIZE;
  const normalized = String(value).trim();
  // Accept plain decimal digits only; Number() alone also accepts exponent and hex syntax.
  if (!/^\d+$/.test(normalized)) return DEFAULT_BATCH_SIZE;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) return DEFAULT_BATCH_SIZE;
  return parsed;
}

module.exports = { getScheduledMessageBatchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE };
