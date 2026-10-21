### Added
- RT-410 `[GATED]` OpenAPI contract, owner authorization 2026-10-21 (RT-410
  comments 13208 and 13278; AD-POSTING-001 D-1 to D-5), step 1 only:
  `erpnext-reconciliation/reconciliation.yaml` 1.3.0-draft. Additive.
  `PostingBacklogItem.reason` (017 `listPostingBacklog`) is the Connector's
  scrubbed rejection message: nullable, at most 1000 characters, plain text,
  business data that is PII-suspect free text, not a money field, kept only
  while the row is `permanently_rejected`, never logged, audited, used as a
  metric label or sent to Sentry or Datadog, and rendered as plain text only.
  `rejectionCategory` documents `other`. No migration, no runtime change: until
  the RT-410 storage migration and write path ship, `reason` still carries the
  category text. `posting-feed.yaml` is unchanged.
