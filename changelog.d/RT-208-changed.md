### Changed
- RT-208 `[GATED]`: `pos-operators.openapi.yaml` 1.2.0-draft declares the
  roster `branch_id` query parameter `required: true`, matching the runtime's
  `branch_id_required` refusal (still the generic 401). Acknowledged oasdiff
  ERR `request-parameter-became-required`. No runtime change.
