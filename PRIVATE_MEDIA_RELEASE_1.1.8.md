# ZannyChat coordinated private-media patch 1.1.8

This patch builds on the v1.1.7 private-media candidate. The backend and database migration are unchanged; the frontend version is 1.1.2.

## Change

The frontend now accepts legacy public/signed Storage URLs for conversion only when the URL origin exactly matches the configured Supabase project. It also rejects malformed object paths (absolute paths, empty path segments, dot segments, and backslashes) before requesting a signed URL. Internal `storage://chat-media/...` markers remain supported, subject to the same object-path validation.

## Validation status

- Node syntax checks are run on the changed frontend service and Supabase client.
- ZIP integrity is checked after packaging.
- Full Jest, Expo build, and live Supabase integration tests are not run in this environment.
- No production deployment or database migration is performed.

## Release notes

Continue to follow the v1.1.7 private-media rollout order: distribute the compatible client or use a maintenance window, then apply migration `0009_private_chat_media.sql`, and verify access using two conversation members, a nonmember, and an anonymous client.


## Follow-up hardening for release candidate 1.1.9

Migration `0009_private_chat_media.sql` now converts a legacy public URL only when its object path begins with a UUID-shaped conversation folder matching the message's `conversation_id`. URLs with query strings, fragments, malformed paths, or mismatched conversation IDs are intentionally left unchanged for manual review instead of being silently rewritten. This change has static review only; verify against a disposable database before production.
