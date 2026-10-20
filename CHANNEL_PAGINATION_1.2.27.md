# Channel feed pagination — backend v1.2.27

The authenticated channel posts endpoint supports bounded cursor pagination with `beforeCreatedAt` and `beforeId`. It returns up to 100 posts, plus `hasMore` and `nextCursor`, validates cursor inputs, and uses timestamp + UUID ordering to reduce page-boundary ambiguity. No schema migration is required.

Local verification: route syntax check passed; targeted channel regression tests 11/11 passed. Hosted PostgREST behavior and production deployment remain unverified.
