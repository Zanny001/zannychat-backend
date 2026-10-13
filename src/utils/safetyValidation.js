'use strict';

// Validate identifiers at the API boundary before the service-role Supabase
// client (which bypasses RLS) is allowed to use them in a write.
// Accept UUID versions 1–8 and the RFC 4122 variant; do not coerce arbitrary
// strings into database filters or foreign-key writes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

module.exports = { isUuid };
