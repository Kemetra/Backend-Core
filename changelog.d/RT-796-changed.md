### Changed
- RT-796 (provider-neutral identity 1/5; no OpenAPI, migration, dependency or
  deploy change): POS operator lookups resolve through the ACTIVE
  `external_identity_links` row, keyed by the verified `{providerKey, subject}`,
  through one shared helper (`auth/identity-link-lookup.ts`): sign-in, sign-out,
  roster, active-session, stuck-shifts, cashier eligibility and roster, and audit
  actor resolution. `operator.id` is the subject of the user's active link
  (byte-identical to `clerk_user_id` for users not yet cut over); rosters list
  users with an active link. A user with a `clerk_user_id` but no link row no
  longer resolves (check before deploy: no `clerk_user_id` without an active
  link). The link reads use the auth-lookup pool. Audit ingestion accepts an
  `acting_operator_id` matching ANY link (active or disabled) of the user bound
  to the event's session, with no time bound (owner decision, RT-796 comment
  13310); the session at event time stays the authorization. The operator-token
  seams are neutral (`OperatorTokenVerifier`, `OPERATOR_TOKEN_VERIFIER`,
  `operatorTokenVerifierFactory`, `identityProviderFactory`,
  `OperatorBearerGuard`); the refusal reason is `identity_token_invalid`
  (internal, in no published schema); pos-shifts no longer logs the subject of
  an unmapped user. A fence spec keeps provider names out of non-adapter code.
