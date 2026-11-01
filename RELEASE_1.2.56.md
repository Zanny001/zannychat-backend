# ZannyChat Backend 1.2.56

## Channel comment participation enforcement

- Editing a channel comment now requires the author to remain subscribed to the channel, unless the caller is the channel owner.
- Public channel read access no longer implicitly authorizes comment edits after a user unsubscribes.
- Subscription lookup failures fail closed with a generic error response.
- Added static regression coverage for the edit authorization boundary and error handling.

## Migration and deployment

- No SQL migration is required.
- Production services were not deployed or changed in this source release.
