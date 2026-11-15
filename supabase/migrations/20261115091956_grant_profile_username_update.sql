-- Username edits use a column-scoped UPDATE with an owner-only RLS policy.
-- The existing profile UPDATE policy remains the row-level authorization boundary.
BEGIN;

GRANT UPDATE (username) ON TABLE public.profiles TO authenticated;

COMMIT;
