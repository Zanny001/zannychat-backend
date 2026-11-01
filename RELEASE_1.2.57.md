# ZannyChat backend 1.2.57

- Added authenticated channel comment reporting with channel access enforcement, own-comment rejection, supported reason validation, and duplicate-report prevention.
- Extended the existing moderation queue to include comment body context and distinguish comment vs post reports.
- Added forward-only Supabase migration `0056_channel_comment_reports.sql` extending the existing report table with mutually exclusive post/comment targets and target-specific uniqueness.
- Apply migration 0056 before deploying this backend release.
