const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/** Parse only explicit ISO-8601 timestamps and reject normalized impossible dates. */
function parseScheduledMessageDate(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return NaN;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysByMonth[month - 1]) return NaN;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetMinutes > 59 || offsetHours > 14 || (offsetHours === 14 && offsetMinutes !== 0)) return NaN;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function isScheduledMessageTimeAllowed(value, now = Date.now()) {
  const timestamp = parseScheduledMessageDate(value);
  return Number.isFinite(timestamp) && timestamp >= now + MIN_DELAY_MS && timestamp <= now + MAX_DELAY_MS;
}

module.exports = { parseScheduledMessageDate, isScheduledMessageTimeAllowed, MIN_DELAY_MS, MAX_DELAY_MS };
