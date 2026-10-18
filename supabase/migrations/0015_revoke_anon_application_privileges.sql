-- Remove unnecessary anonymous privileges from application tables.
-- Does not change authenticated privileges or RLS policies.

DO $$
DECLARE
    v_table text;
    v_column text;
    v_privilege text;
    v_tables text[] := ARRAY[
        'blocked_users',
        'conversation_participants',
        'conversations',
        'ledger_entries',
        'message_reactions',
        'messages',
        'profiles',
        'push_tokens',
        'reports',
        'wallets'
    ];
BEGIN
    FOREACH v_table IN ARRAY v_tables
    LOOP
        IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon',
                v_table
            );

            FOR v_column IN
                SELECT a.attname
                FROM pg_attribute a
                WHERE a.attrelid = to_regclass(format('public.%I', v_table))
                  AND a.attnum > 0
                  AND NOT a.attisdropped
            LOOP
                FOREACH v_privilege IN ARRAY
                    ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']
                LOOP
                    EXECUTE format(
                        'REVOKE %s (%I) ON TABLE public.%I FROM anon',
                        v_privilege,
                        v_column,
                        v_table
                    );
                END LOOP;
            END LOOP;
        END IF;
    END LOOP;
END;
$$;
