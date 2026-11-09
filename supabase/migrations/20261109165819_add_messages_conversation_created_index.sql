-- Record the production index that was applied as migration 20261109165819.
-- IF NOT EXISTS makes this safe when reconciling an already-provisioned database.
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON public.messages USING btree (conversation_id, created_at DESC);
