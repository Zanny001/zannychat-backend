# ZannyChat backend 1.2.53

- Added authenticated channel-comment editing with strict 1–1000 character validation.
- Editing is limited to the original comment author; channel access is rechecked and the update is scoped to the author to avoid cross-user writes.
- Added a regression test for validation, ownership enforcement, and edit timestamps.
