-- Reconcile the production migration that removed the legacy zero-argument
-- overload. Keeping only get_contact_directory(p_user_id uuid DEFAULT NULL)
-- prevents PostgREST from seeing two equally valid RPC candidates.
DROP FUNCTION IF EXISTS public.get_contact_directory();
