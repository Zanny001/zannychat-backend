-- Store native APNs VoIP and Android FCM call tokens separately from
-- Expo notification tokens. The client can register only through the
-- authenticated backend; service_role is the only database reader.
BEGIN;

CREATE TABLE IF NOT EXISTS public.call_voip_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  token_type text NOT NULL CHECK (token_type IN ('APNS_VOIP', 'FCM')),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_voip_tokens_user_type_idx
  ON public.call_voip_tokens(user_id, token_type);

ALTER TABLE public.call_voip_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.call_voip_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.call_voip_tokens TO service_role;

COMMENT ON TABLE public.call_voip_tokens IS
  'Private native call delivery tokens. Never expose token values to clients.';

COMMIT;
