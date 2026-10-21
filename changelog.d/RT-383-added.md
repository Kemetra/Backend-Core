### Added
- RT-383 `[GATED]`, pending owner approval: OpenAPI contract
  `shift-closes.openapi.yaml` (1.0.0-draft, contract-only). It defines the
  admin-facing read of recorded RT-17 shift closes for Admin-Console RT-18:
  `GET /api/v1/shift-closes` (filtered, keyset-paginated list) and
  `GET /api/v1/shift-closes/{shiftId}` (one close with its movements). No
  runtime change; the POS shift operations are unchanged.
