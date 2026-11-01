# Backend compatibility note — ZannyChat 1.2.198

No backend API or database schema changes are introduced in this frontend-focused release. The frontend now clears stale channel-scoped UI state when a selected channel disappears or is deleted. Existing backend tests pass; no live deployment or database migration was performed.
