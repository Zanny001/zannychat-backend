BEGIN;

-- The status reaction client uses upsert (INSERT ... ON CONFLICT DO UPDATE).
-- PostgreSQL requires table-level UPDATE privilege for the conflict-update
-- branch. The existing UPDATE RLS policy continues to restrict writes to the
-- authenticated viewer's own eligible reaction on a visible active status.
GRANT UPDATE ON TABLE public.status_reactions TO authenticated;

COMMIT;
