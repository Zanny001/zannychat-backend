const MAX_AI_TRANSCRIPT_CHARS = 12000;
const MAX_TRANSLATION_TEXT_CHARS = 4000;
const MAX_TARGET_LANGUAGE_CHARS = 48;

function validateTranslationInput(input = {}) {
  const rawText = input.text;
  const rawLanguage = input.targetLanguage;
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, status: 400, error: 'text must be a non-empty string' };
  }
  if (rawText.length > MAX_TRANSLATION_TEXT_CHARS) {
    return { ok: false, status: 413, error: `text must be ${MAX_TRANSLATION_TEXT_CHARS} characters or fewer` };
  }
  if (typeof rawLanguage !== 'string' || !rawLanguage.trim()) {
    return { ok: false, status: 400, error: 'targetLanguage must be a non-empty language name' };
  }
  const targetLanguage = rawLanguage.trim();
  if (targetLanguage.length > MAX_TARGET_LANGUAGE_CHARS
      || !/^[\p{L}\p{M}][\p{L}\p{M} .()_-]*$/u.test(targetLanguage)) {
    return { ok: false, status: 400, error: 'targetLanguage must be a language name of 48 characters or fewer' };
  }
  return { ok: true, text: rawText.trim(), targetLanguage };
}

function buildBoundedTranscript(messages, userId, maxChars = MAX_AI_TRANSCRIPT_CHARS) {
  const rows = Array.isArray(messages) ? messages : [];
  const selected = [];
  let remaining = Math.max(0, Math.floor(Number(maxChars) || MAX_AI_TRANSCRIPT_CHARS));
  for (let index = rows.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const row = rows[index] || {};
    const line = `${row.sender_id === userId ? 'Me' : 'Them'}: ${String(row.text || '')}`;
    const separatorCost = selected.length ? 1 : 0;
    if (line.length + separatorCost <= remaining) {
      selected.unshift(line);
      remaining -= line.length + separatorCost;
    } else {
      const available = Math.max(0, remaining - separatorCost);
      if (available) selected.unshift(line.slice(-available));
      break;
    }
  }
  return selected.join('\n');
}

module.exports = {
  MAX_AI_TRANSCRIPT_CHARS,
  MAX_TRANSLATION_TEXT_CHARS,
  MAX_TARGET_LANGUAGE_CHARS,
  validateTranslationInput,
  buildBoundedTranscript,
};
