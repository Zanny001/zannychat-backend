-- ZannyChat 1.2.233: client roles must not be able to create objects in the
-- exposed public schema. This reduces the attack surface for legacy
-- SECURITY DEFINER routines that pin search_path to public.
-- Existing objects and ordinary table privileges are unchanged.
revoke create on schema public from public, anon, authenticated;

comment on schema public is
  'Client roles have no CREATE privilege; schema changes must run through trusted migrations.';
