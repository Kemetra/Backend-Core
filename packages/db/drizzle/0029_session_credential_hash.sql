-- 0029_session_credential_hash.sql
--
-- #608 — the dashboard cookie must not be the sessions primary key.
--
-- Rollout: every still-live session is revoked. A pre-0029 cookie IS the
-- row id, so it cannot be turned into a non-reversible secret while that
-- id remains replayable. Deploy forces re-login. Historical rows keep
-- their id (other records may cite it) but receive a random credential
-- hash that matches no cookie, and revoked_at is set when it was null.
-- New sessions store only SHA-256 of a CSPRNG cookie, distinct from id.
--
-- No pgcrypto: the placeholder hash is 32 bytes from two md5 digests.
BEGIN;

ALTER TABLE sessions ADD COLUMN credential_hash BYTEA;

UPDATE sessions
SET revoked_at = COALESCE(revoked_at, now()),
    credential_hash = decode(md5(id::text), 'hex') || decode(md5(id::text || ':retired'), 'hex')
WHERE credential_hash IS NULL;

ALTER TABLE sessions ALTER COLUMN credential_hash SET NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_credential_hash_key UNIQUE (credential_hash);

COMMIT;
