# @data-pulse-2/auth

Shared authentication primitives used by Backend-Core apps.

## Exports

- `./passwords` - argon2id password hashing and verification helpers.
- `./tokens` - SHA-256 token hashing helpers for opaque bearer tokens.
- `./types` - session and auth token shapes shared with API repositories.
- `.` - package barrel export.

## Commands

```bash
pnpm --filter @data-pulse-2/auth build
pnpm --filter @data-pulse-2/auth test
```

## Security Notes

- Password verification should stay inside the helper API so cost parameters
  remain centralized.
- Wire tokens should never be persisted or logged in plaintext; store hashes.
- Concrete repositories and HTTP controllers live in `apps/api/src/auth`.
