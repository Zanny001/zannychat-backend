-- Make profile/photo visibility changes server-verified so older clients cannot
-- bypass the private-avatar cutover by writing profile_details directly.
BEGIN;

CREATE OR REPLACE FUNCTION private.guard_profile_visibility_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role'
     OR COALESCE(current_setting('app.profile_visibility_update', true), '') = 'allowed' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.profile_visibility, 'everyone') <> 'everyone'
       OR COALESCE(NEW.photo_visibility, 'everyone') <> 'everyone' THEN
      RAISE EXCEPTION 'Use update_my_profile_visibility to change profile visibility'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.profile_visibility IS DISTINCT FROM OLD.profile_visibility
     OR NEW.photo_visibility IS DISTINCT FROM OLD.photo_visibility THEN
    RAISE EXCEPTION 'Use update_my_profile_visibility to change profile visibility'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_profile_visibility_changes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profile_details_visibility_guard ON public.profile_details;
CREATE TRIGGER profile_details_visibility_guard
BEFORE INSERT OR UPDATE OF profile_visibility, photo_visibility
ON public.profile_details
FOR EACH ROW
EXECUTE FUNCTION private.guard_profile_visibility_changes();

CREATE OR REPLACE FUNCTION private.guard_public_avatar_pointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.avatar_url IS NOT NULL
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND COALESCE(current_setting('app.profile_visibility_update', true), '') <> 'allowed'
     AND EXISTS (
       SELECT 1
       FROM public.profile_details AS d
       WHERE d.user_id = NEW.id
         AND (
           COALESCE(d.profile_visibility, 'everyone') <> 'everyone'
           OR COALESCE(d.photo_visibility, 'everyone') <> 'everyone'
         )
     ) THEN
    RAISE EXCEPTION 'Public avatar URLs are not allowed for restricted profiles'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_public_avatar_pointer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_public_avatar_visibility_guard ON public.profiles;
CREATE TRIGGER profiles_public_avatar_visibility_guard
BEFORE INSERT OR UPDATE OF avatar_url
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION private.guard_public_avatar_pointer();

CREATE OR REPLACE FUNCTION private.can_upload_public_avatar(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND (storage.foldername(p_object_name))[1] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1
      FROM public.profile_details AS d
      WHERE d.user_id = auth.uid()
        AND (
          COALESCE(d.profile_visibility, 'everyone') <> 'everyone'
          OR COALESCE(d.photo_visibility, 'everyone') <> 'everyone'
        )
    );
$function$;

REVOKE ALL ON FUNCTION private.can_upload_public_avatar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_upload_public_avatar(text) TO authenticated;

DROP POLICY IF EXISTS "Users can upload their own avatars" ON storage.objects;
CREATE POLICY "Users can upload their own avatars"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND private.can_upload_public_avatar(name)
);

DROP POLICY IF EXISTS "Users can update their own avatars" ON storage.objects;
CREATE POLICY "Users can update their own avatars"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'avatars'
  AND private.can_upload_public_avatar(name)
)
WITH CHECK (
  bucket_id = 'avatars'
  AND private.can_upload_public_avatar(name)
);

CREATE OR REPLACE FUNCTION public.update_my_profile_visibility(
  p_profile_visibility text,
  p_photo_visibility text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_avatar_path text;
  v_avatar_url text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_profile_visibility IS NULL OR p_photo_visibility IS NULL
     OR p_profile_visibility NOT IN ('everyone', 'contacts', 'nobody')
     OR p_photo_visibility NOT IN ('everyone', 'contacts', 'nobody') THEN
    RAISE EXCEPTION 'Invalid profile visibility setting' USING ERRCODE = '22023';
  END IF;

  SELECT d.avatar_path
  INTO v_avatar_path
  FROM public.profile_details AS d
  WHERE d.user_id = v_user_id;

  SELECT p.avatar_url
  INTO v_avatar_url
  FROM public.profiles AS p
  WHERE p.id = v_user_id;

  IF p_profile_visibility <> 'everyone' OR p_photo_visibility <> 'everyone' THEN
    IF v_avatar_url IS NOT NULL THEN
      RAISE EXCEPTION 'Remove the public avatar URL before restricting visibility'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM storage.objects AS o
      WHERE o.bucket_id = 'avatars'
        AND (storage.foldername(o.name))[1] = v_user_id::text
    ) THEN
      RAISE EXCEPTION 'Remove all public avatar objects before restricting visibility'
        USING ERRCODE = '42501';
    END IF;

    IF v_avatar_path IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM storage.objects AS o
      WHERE o.bucket_id = 'private-avatars'
        AND o.name = v_avatar_path
        AND (storage.foldername(o.name))[1] = v_user_id::text
    ) THEN
      RAISE EXCEPTION 'A private avatar copy is required before restricting visibility'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('app.profile_visibility_update', 'allowed', true);

  INSERT INTO public.profile_details (user_id, profile_visibility, photo_visibility)
  VALUES (v_user_id, p_profile_visibility, p_photo_visibility)
  ON CONFLICT (user_id) DO UPDATE
  SET profile_visibility = EXCLUDED.profile_visibility,
      photo_visibility = EXCLUDED.photo_visibility;

  IF p_profile_visibility <> 'everyone' OR p_photo_visibility <> 'everyone' THEN
    UPDATE public.profiles SET avatar_url = NULL WHERE id = v_user_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'profile_visibility', p_profile_visibility,
    'photo_visibility', p_photo_visibility
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_my_profile_visibility(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_profile_visibility(text, text) TO authenticated;

COMMENT ON FUNCTION public.update_my_profile_visibility(text, text) IS
  'Changes the caller profile/photo visibility only after public avatar pointers and objects are removed and any existing avatar has a private copy.';

COMMIT;
