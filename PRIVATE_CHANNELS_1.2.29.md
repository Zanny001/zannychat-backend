# Private Channels and Invitations — v1.2.29

- Private channel visibility and membership checks are enforced by the authenticated API.
- Invitation tokens are hashed at rest, have bounded uses and expiration, and can be revoked by the channel owner.
- The invite acceptance SQL function uses a row lock and inserts membership atomically. Re-accepting an invitation as an existing member is idempotent and does not consume an additional use slot.
- Migration: `0038_private_channels_and_invites.sql`. Apply after migrations 0001–0037.

Local static regression tests cover route guards, hash storage, atomic consumption, and invitation management UI. Hosted Supabase integration, concurrent invitation use, and two-account testing remain required.
