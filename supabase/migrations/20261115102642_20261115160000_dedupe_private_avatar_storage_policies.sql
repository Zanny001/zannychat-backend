-- Remove duplicate private-avatar Storage policies. The retained
-- "Private profile media" policies already cover owners and permitted viewers.
BEGIN;

DROP POLICY IF EXISTS "Private avatar owner delete" ON storage.objects;
DROP POLICY IF EXISTS "Private avatar owner update" ON storage.objects;
DROP POLICY IF EXISTS "Private avatar owner upload" ON storage.objects;
DROP POLICY IF EXISTS "Private avatar visible by profile preference" ON storage.objects;

COMMIT;
