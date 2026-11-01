# ZannyChat Backend 1.2.54

- Added authenticated channel comment reaction toggle endpoint.
- Comment pages include per-emoji reaction counts and the current user's reaction.
- Added service-role-only reaction storage with a unique user/comment constraint and cascading cleanup.
- Apply Supabase migration `0055_channel_comment_reactions.sql` before deployment.
