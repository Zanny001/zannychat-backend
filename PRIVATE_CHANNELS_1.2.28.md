# Private Channels and Invitations — v1.2.28

- Channels now have an `is_private` flag defaulting to `false`, preserving existing public channels.
- Private channels are omitted from discovery unless the signed-in user owns or subscribes to them.
- The authenticated API checks private-channel membership before returning posts, reactions, comments, or accepting report actions. Direct subscription to a private channel is denied; invitation acceptance creates membership.
- Owners can create time-limited invitation tokens with a bounded number of uses and revoke outstanding tokens. The raw token is returned only when created; the database stores only its SHA-256 hash.
- Invite acceptance uses a `SECURITY DEFINER` PostgreSQL function with a row lock so invite-use counts and membership insertion are atomic. Execution is revoked from public/anonymous/authenticated roles and granted only to `service_role`.
- Migration: `0038_private_channels_and_invites.sql`. Apply after migrations 0001–0037.

## Verification and limitations

Frontend unit tests and release audit pass locally; backend static regression tests cover directory filtering, membership guards, token hashing, and atomic consumption. The migration has not been applied to hosted Supabase, and invitation expiry, concurrent use limits, and access denial still require integration tests against a disposable database before production deployment.
