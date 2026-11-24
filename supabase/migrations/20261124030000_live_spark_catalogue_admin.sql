-- Restricted operator workflow for the provider-specific LIVE Sparks catalogue.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_spark_package_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('draft_created', 'activated', 'deactivated')),
  provider text NOT NULL CHECK (provider IN ('paystack', 'google_play', 'apple_iap')),
  package_id text NOT NULL,
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  sparks bigint NOT NULL CHECK (sparks BETWEEN 1 AND 10000000),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider, package_id, currency)
    REFERENCES public.live_spark_packages(provider, package_id, currency) ON DELETE RESTRICT
);
ALTER TABLE public.live_spark_package_admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_spark_package_admin_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_spark_package_admin_audit TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_live_spark_package_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'LIVE Sparks package audit is append-only' USING ERRCODE = '55000';
END;
$function$;
DROP TRIGGER IF EXISTS live_spark_package_admin_audit_append_only ON public.live_spark_package_admin_audit;
CREATE TRIGGER live_spark_package_admin_audit_append_only
  BEFORE UPDATE OR DELETE ON public.live_spark_package_admin_audit
  FOR EACH ROW EXECUTE FUNCTION public.prevent_live_spark_package_audit_mutation();

CREATE OR REPLACE FUNCTION public.create_live_spark_package_draft(
  p_admin_id uuid, p_provider text, p_package_id text, p_sparks bigint,
  p_amount_minor bigint, p_sort_order integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_package public.live_spark_packages%ROWTYPE;
BEGIN
  IF p_admin_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('paystack', 'google_play', 'apple_iap')
     OR p_package_id IS NULL OR length(p_package_id) NOT BETWEEN 2 AND 150
     OR p_package_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
     OR p_sparks IS NULL OR p_sparks NOT BETWEEN 1 AND 10000000
     OR p_amount_minor IS NULL OR p_amount_minor NOT BETWEEN 1 AND 9007199254740991
     OR p_sort_order IS NULL OR p_sort_order NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'invalid Sparks package draft' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM auth.users WHERE id = p_admin_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin account not found' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.live_spark_packages
    (provider, package_id, sparks, amount_minor, currency, is_active, sort_order, updated_at)
  VALUES (p_provider, p_package_id, p_sparks, p_amount_minor, 'NGN', false, p_sort_order, now())
  RETURNING * INTO v_package;

  INSERT INTO public.live_spark_package_admin_audit
    (admin_id, action, provider, package_id, currency, sparks, amount_minor, sort_order)
  VALUES (p_admin_id, 'draft_created', v_package.provider, v_package.package_id,
    v_package.currency, v_package.sparks, v_package.amount_minor, v_package.sort_order);

  RETURN jsonb_build_object('provider', v_package.provider, 'packageId', v_package.package_id,
    'sparks', v_package.sparks, 'amountMinor', v_package.amount_minor,
    'currency', v_package.currency, 'sortOrder', v_package.sort_order,
    'isActive', v_package.is_active, 'updatedAt', v_package.updated_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_live_spark_package_active(
  p_admin_id uuid, p_provider text, p_package_id text, p_is_active boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_package public.live_spark_packages%ROWTYPE;
BEGIN
  IF p_admin_id IS NULL OR p_provider NOT IN ('paystack', 'google_play', 'apple_iap')
     OR p_package_id IS NULL OR length(p_package_id) NOT BETWEEN 2 AND 150
     OR p_is_active IS NULL THEN
    RAISE EXCEPTION 'invalid Sparks package activation request' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM auth.users WHERE id = p_admin_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin account not found' USING ERRCODE = 'P0002'; END IF;

  UPDATE public.live_spark_packages
    SET is_active = p_is_active, updated_at = now()
    WHERE provider = p_provider AND package_id = p_package_id AND currency = 'NGN'
    RETURNING * INTO v_package;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sparks package not found' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.live_spark_package_admin_audit
    (admin_id, action, provider, package_id, currency, sparks, amount_minor, sort_order)
  VALUES (p_admin_id, CASE WHEN p_is_active THEN 'activated' ELSE 'deactivated' END,
    v_package.provider, v_package.package_id, v_package.currency,
    v_package.sparks, v_package.amount_minor, v_package.sort_order);

  RETURN jsonb_build_object('provider', v_package.provider, 'packageId', v_package.package_id,
    'sparks', v_package.sparks, 'amountMinor', v_package.amount_minor,
    'currency', v_package.currency, 'sortOrder', v_package.sort_order,
    'isActive', v_package.is_active, 'updatedAt', v_package.updated_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.prevent_live_spark_package_audit_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_live_spark_package_draft(uuid, text, text, bigint, bigint, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_live_spark_package_active(uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_live_spark_package_draft(uuid, text, text, bigint, bigint, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_live_spark_package_active(uuid, text, text, boolean)
  TO service_role;

COMMIT;
