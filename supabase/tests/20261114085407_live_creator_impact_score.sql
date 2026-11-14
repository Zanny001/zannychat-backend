DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.live_stream_reactions'::regclass
      AND conname = 'live_stream_reactions_reaction_check'
      AND pg_get_constraintdef(oid) LIKE '%idea%'
      AND pg_get_constraintdef(oid) LIKE '%support%'
  ) THEN
    RAISE EXCEPTION 'LIVE reaction vocabulary constraint is missing';
  END IF;
  IF to_regclass('public.live_creator_impact') IS NULL
     OR to_regclass('public.live_creator_impact_supporters') IS NULL
     OR to_regclass('public.live_creator_impact_daily') IS NULL THEN
    RAISE EXCEPTION 'LIVE creator impact tables are missing';
  END IF;
  IF has_table_privilege('authenticated', 'public.live_creator_impact', 'SELECT')
     OR has_table_privilege('authenticated', 'public.live_creator_impact_daily', 'SELECT') THEN
    RAISE EXCEPTION 'Authenticated users must not read impact tables directly';
  END IF;
  IF has_function_privilege('authenticated', 'public.record_live_creator_impact(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_live_creator_impact(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'LIVE impact write RPC grants are incorrect';
  END IF;
END $$;
