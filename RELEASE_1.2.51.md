# ZannyChat backend 1.2.51

- Added forward-only Supabase migration `0053_multi_select_polls.sql` for optional multi-select polls.
- Vote RPC atomically replaces a voter's selections and validates membership, poll state, option ownership, duplicate IDs, and selection bounds.
- Vote-count RPC returns aggregate option counts, unique voter totals, and only the caller's own selected-option flags.
- Migration is source-only; apply it to Supabase before enabling this frontend feature in production.
