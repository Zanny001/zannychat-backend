BEGIN;
CREATE TABLE IF NOT EXISTS public.live_spark_purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL UNIQUE REFERENCES public.live_spark_purchases(id) ON DELETE CASCADE,
  receipt_number text NOT NULL UNIQUE,
  storage_path text NOT NULL UNIQUE,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL DEFAULT 'application/pdf' CHECK (mime_type = 'application/pdf'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.live_spark_purchase_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_spark_purchase_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_spark_purchase_receipts TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('live-purchase-receipts', 'live-purchase-receipts', false, 2097152, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 2097152,
    allowed_mime_types = ARRAY['application/pdf'];

COMMENT ON TABLE public.live_spark_purchase_receipts IS
  'Private, server-generated PDF receipts for verified LIVE Sparks purchases; client access is via owner-checked signed URLs only.';
COMMIT;
