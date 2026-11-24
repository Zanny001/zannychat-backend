-- Audited, fail-closed manual review workflow for creator payout identity.
-- Admin identities are allowlisted by LIVE_PAYOUT_ADMIN_USER_IDS in the API;
-- this service-role-only RPC records the reviewer and evidence reference.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_creator_payout_review_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  previous_status text CHECK (previous_status IS NULL OR previous_status IN ('unverified', 'pending', 'verified', 'rejected')),
  new_status text NOT NULL CHECK (new_status IN ('pending', 'verified', 'rejected')),
  verification_provider text,
  verification_reference text,
  payout_hold boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (new_status <> 'verified' OR
    (length(trim(COALESCE(verification_provider, ''))) BETWEEN 2 AND 80
     AND length(trim(COALESCE(verification_reference, ''))) BETWEEN 3 AND 200))
);

ALTER TABLE public.live_creator_payout_review_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_creator_payout_review_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_creator_payout_review_audit TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_live_creator_payout_review_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'creator payout review audit is append-only' USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS live_creator_payout_review_audit_append_only
  ON public.live_creator_payout_review_audit;
CREATE TRIGGER live_creator_payout_review_audit_append_only
  BEFORE UPDATE OR DELETE ON public.live_creator_payout_review_audit
  FOR EACH ROW EXECUTE FUNCTION public.prevent_live_creator_payout_review_audit_mutation();

CREATE OR REPLACE FUNCTION public.review_live_creator_payout_profile(
  p_admin_id uuid,
  p_creator_id uuid,
  p_verification_status text,
  p_verification_provider text DEFAULT NULL,
  p_verification_reference text DEFAULT NULL,
  p_payout_hold boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_previous_status text;
  v_profile public.live_creator_payout_profiles%ROWTYPE;
BEGIN
  IF p_admin_id IS NULL OR p_creator_id IS NULL
     OR p_verification_status NOT IN ('pending', 'verified', 'rejected')
     OR p_payout_hold IS NULL
     OR (p_verification_status = 'verified' AND
       (length(trim(COALESCE(p_verification_provider, ''))) NOT BETWEEN 2 AND 80
        OR length(trim(COALESCE(p_verification_reference, ''))) NOT BETWEEN 3 AND 200)) THEN
    RAISE EXCEPTION 'invalid payout review decision' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM auth.users WHERE id = p_creator_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'creator account not found' USING ERRCODE = 'P0002'; END IF;

  SELECT verification_status INTO v_previous_status
    FROM public.live_creator_payout_profiles
    WHERE creator_id = p_creator_id FOR UPDATE;

  INSERT INTO public.live_creator_payout_profiles
    (creator_id, verification_status, verification_provider, verification_reference,
     verified_at, payout_hold, updated_at)
  VALUES
    (p_creator_id, p_verification_status,
     CASE WHEN p_verification_status = 'verified' THEN trim(p_verification_provider) ELSE NULL END,
     CASE WHEN p_verification_status = 'verified' THEN trim(p_verification_reference) ELSE NULL END,
     CASE WHEN p_verification_status = 'verified' THEN now() ELSE NULL END,
     p_payout_hold, now())
  ON CONFLICT (creator_id) DO UPDATE SET
    verification_status = EXCLUDED.verification_status,
    verification_provider = EXCLUDED.verification_provider,
    verification_reference = EXCLUDED.verification_reference,
    verified_at = EXCLUDED.verified_at,
    payout_hold = EXCLUDED.payout_hold,
    updated_at = now()
  RETURNING * INTO v_profile;

  INSERT INTO public.live_creator_payout_review_audit
    (creator_id, reviewed_by, previous_status, new_status, verification_provider,
     verification_reference, payout_hold)
  VALUES
    (p_creator_id, p_admin_id, v_previous_status, p_verification_status,
     v_profile.verification_provider, v_profile.verification_reference, p_payout_hold);

  RETURN jsonb_build_object(
    'creatorId', v_profile.creator_id,
    'verificationStatus', v_profile.verification_status,
    'verifiedAt', v_profile.verified_at,
    'payoutHold', v_profile.payout_hold,
    'updatedAt', v_profile.updated_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prevent_live_creator_payout_review_audit_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.review_live_creator_payout_profile(uuid, uuid, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_live_creator_payout_profile(uuid, uuid, text, text, text, boolean)
  TO service_role;

COMMIT;
