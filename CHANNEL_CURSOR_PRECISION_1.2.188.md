# Channel cursor precision — 1.2.188

## Change
Channel post pagination now validates cursor timestamps as strict RFC 3339/ISO timestamps, checks Gregorian calendar days and timezone offsets, and passes the validated timestamp to PostgreSQL without converting it through JavaScript `Date`.

## Why
JavaScript `Date` stores millisecond precision. PostgreSQL timestamps may carry microseconds. Converting a cursor such as `2026-10-23T12:00:00.123456Z` to `2026-10-23T12:00:00.123Z` can move the pagination boundary and cause duplicate or skipped posts when timestamps tie closely.

## Validation
Regression tests cover valid UTC/offset timestamps, microsecond preservation, impossible dates, invalid time fields, invalid timezone offsets, malformed input, and Gregorian century leap-year behavior.

## Deployment
Source-only change. Deploy the backend after tests pass; no database migration is required. Production behavior still needs staging verification against real Postgres timestamp precision.
