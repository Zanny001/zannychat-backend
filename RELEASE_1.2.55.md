# ZannyChat backend 1.2.55

- Hardened channel comment reaction authorization: non-owner users must be subscribed before adding, changing, or removing reactions.
- Added static regression tests for subscriber gating and safe permission-error disclosure.
- No database migration required.
