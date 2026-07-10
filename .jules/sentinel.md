# Sentinel's Journal

## 2026-07-10 - Wildcard Key Listing Vulnerability in Storage API
**Vulnerability:** The `/api/storage` endpoint exposed an unused `prefix` query parameter which executed a wildcard `redis.keys()` search. This allowed unauthenticated enumeration of all case keys in the Upstash Redis database, defeating the security of using unpredictable 7-character case IDs.
**Learning:** Legacy or boilerplate code templates often include general-purpose API actions (like list/delete) that are not needed by the application but significantly increase the attack surface.
**Prevention:** Always prune unused endpoints and implement strict whitelist-based key format validation for any public database proxy.
