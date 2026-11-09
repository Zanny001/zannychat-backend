-- Add indexes for public foreign-key columns that currently lack a
-- left-prefix covering index. The catalog check makes this safe to rerun
-- and avoids duplicating indexes added by another migration.
DO $migration$
DECLARE
  fk record;
  index_name text;
BEGIN
  FOR fk IN
    SELECT
      c.conrelid AS table_oid,
      c.conrelid::regclass AS table_name,
      c.conname,
      string_agg(format('%I', a.attname), ', ' ORDER BY key_col.ordinality) AS column_list,
      array_agg(key_col.attnum ORDER BY key_col.ordinality) AS fk_attnums
    FROM pg_catalog.pg_constraint AS c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key_col(attnum, ordinality)
      ON true
    JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = c.conrelid
     AND a.attnum = key_col.attnum
    JOIN pg_catalog.pg_namespace AS ns
      ON ns.oid = c.connamespace
    WHERE c.contype = 'f'
      AND ns.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index AS i
        WHERE i.indrelid = c.conrelid
          AND i.indisvalid
          AND i.indisready
          AND (
            SELECT array_agg(index_col.attnum ORDER BY index_col.ordinality)
            FROM unnest(i.indkey) WITH ORDINALITY AS index_col(attnum, ordinality)
            WHERE index_col.ordinality <= i.indnkeyatts
          )[1:cardinality(c.conkey)] = c.conkey
      )
    GROUP BY c.conrelid, c.conname
  LOOP
    index_name := left(
      'fk_' || (fk.table_name::text)::name || '_' || substr(md5(fk.conname), 1, 8),
      63
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %s (%s)',
      index_name,
      fk.table_name,
      fk.column_list
    );
  END LOOP;
END;
$migration$;
