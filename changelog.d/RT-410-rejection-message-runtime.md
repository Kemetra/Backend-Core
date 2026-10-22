### Added
- RT-410 `[GATED]` step 2, migration 0071 and runtime (owner authorization
  RT-410 comments 13357 and 13396, PR + CI only; number 0071 by the wave
  coordinator 2026-10-22; AD-POSTING-001 D-1 to D-5): the Connector's
  rejection message is kept on the dead-lettered `erpnext_posting_status` row
  and served as `PostingBacklogItem.reason` in the 017 backlog
  (`reconciliation.yaml` 1.3.0-draft, contract #891), so operators can tell an
  RT-378 representation mismatch, an RT-78 settlement drift, a
  `frappe.ValidationError` and an unclassified exception apart. A
  `permanently_rejected` or `reconciliation_required` ack stores the message
  after sanitising it (C0/C1 control characters removed and trimmed;
  `Bearer …` and values after keys ending an identifier, such as `dp2_token`,
  `password`, `secret`, `api_key` and `authorization`, redacted; cut to 1000
  characters after redaction; nothing left is null). Sanitising never rejects
  an ack. A re-ack of the same outcome is an O-3 echo and keeps the first
  message; a superseded-version ack changes nothing; a dead-letter Backend-Core
  raises itself stores none; a repair re-offer clears it. The backlog `reason`
  is the stored message or null, never the category text. The message is never
  logged, audited or used as a metric label. Migration
  `0071_erpnext_posting_rejection_message` adds the nullable column with two
  CHECKs (1..1000 characters; set only on a `permanently_rejected` row), added
  NOT VALID and validated, and re-reviews the 0019 data classification:
  PII-suspect business text, kept only while the row is dead-lettered. The rt9
  runtime evidence (G9, with RT-409) is not part of this change.
