-- 0029_session_credential_hash.down.sql
-- Down does not restore revoked sessions. The pre-0029 cookie was the row
-- id; those live credentials were retired on purpose.
BEGIN;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_credential_hash_key;
ALTER TABLE sessions DROP COLUMN IF EXISTS credential_hash;

COMMIT;
