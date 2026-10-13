# Contract surface (PROSE) — Spec 039 tenant logo branding

**PLANNING ONLY. No OpenAPI YAML in this folder.** This README fixes the intended contract in prose. RT-473 slice S1 authors the real YAML under `packages/contracts/openapi/branding/` as a GATED contract PR. The owner approved the decisions this surface depends on (`spec.md` §5) on 2026-10-13. This README stays the prose record; once S1 lands, the YAML is the contract of record.

Every operation, once authored, MUST carry:

- a stable `operationId`;
- an explicit `security` section;
- the canonical error envelope `{ error: { code, message, request_id, details? } }`, with `additionalProperties: false`;
- the canonical status mapping;
- no raw DB entities (Constitution IV and the API Conventions).

The YAML file is self-contained, with its own `securitySchemes` and Error schema, like `catalog/read-down.yaml`. `apps/api/src/openapi/loader.ts` reads only the top level of `packages/contracts/openapi/`. Sub-folder contracts such as `catalog/read-down.yaml` are pinned by their own ajv contract test instead (`apps/api/test/catalog/read-down/contract/`). S1 follows that convention: it adds a contract test for the new file and keeps it inside the oasdiff breaking-change check.

## 1. Shared shapes

### `TenantBranding` (response body; used by the POS and Console reads)

| Field | Type | Rule |
|---|---|---|
| `tenant_display_name` | string, 1..∞ | `tenants.name` (OD-10). Always present, so the POS fallback text always exists. |
| `revision` | integer ≥ 0 | The per-tenant monotonic write counter (spec FR-14a). `0` = never written. The Console echoes it as `expected_revision`. |
| `logo` | `TenantLogo` \| `null` | `null` = no logo stored. That is a normal state, not an error. |

### `TenantLogo`

| Field | Type | Rule |
|---|---|---|
| `version` | string, `^[0-9a-f]{64}$` | SHA-256 per spec FR-13. It is the cache key. |
| `presentation.card` | boolean | `true` → show on a white rounded card (opaque background or `low_contrast`). |
| `warnings` | array of `LogoWarning`, unique, possibly empty | Closed set, §6. |
| `screen` | array of `ScreenRendition`, exactly one per (`slot`, `scale`) | 4 slots × 2 scales = 8 items. |
| `receipt` | `ReceiptRendition` | Always present when `logo` is present. |
| `updated_at` | string, `date-time` | When this version was saved. |

### `ScreenRendition`

| Field | Type | Rule |
|---|---|---|
| `slot` | enum `boot` \| `pairing` \| `sign_in` \| `lock` | The pixel box per slot is server config from the approved references (OD-7). |
| `scale` | enum `1` \| `2` | Integer. |
| `width_px`, `height_px` | integer ≥ 1 | Fitted with `contain` inside the slot box × scale, never above the master's native size. |
| `png_base64` | string, `format: byte` | 8-bit RGBA PNG, sRGB, no metadata chunks. |

### `ReceiptRendition`

| Field | Type | Rule |
|---|---|---|
| `width_px`, `height_px` | integer ≥ 1 | At most `RECEIPT_MAX_W_PX × RECEIPT_MAX_H_PX` (48 × 15 mm at `dpi`). |
| `dpi` | integer | The bench-measured printer dpi (OD-8). The POS sets the CSS size to `px / dpi × 25.4` mm. |
| `png_base64` | string, `format: byte` | **1-bit grayscale** PNG, black on white, no alpha, no metadata. |

### `LogoPreview` (Console preview response)

`TenantLogo` minus `updated_at`. It includes `version`, which the save call must echo.

## 2. Surface 1 — POS: read tenant branding

- **Operation:** `GET /api/pos/v1/tenant/branding`, operationId `posGetTenantBranding`, tag `branding-pos`.
- **Security:** `device` (opaque bearer device token, same scheme as `posGetCatalogSnapshot`).
- **Tenant:** taken **only** from the device row. There are no query or path parameters. Unknown query keys get a `400 validation_error` (strict).
- **Request header:** optional `If-None-Match: "<etag>"`.
- **Responses:**
  - **`200`** `TenantBranding` with `ETag: "<etag>"`. The etag is the quoted lowercase hex SHA-256 of `UTF8(tenant_display_name) 0x00 ASCII(decimal revision)` (spec FR-18). The revision changes on every write and re-render, so this covers the whole representation; the POS recomputes it.
  - **`304`** No body, when `If-None-Match` matches.
  - **`400`** `validation_error`: an unknown query key, or a malformed `If-None-Match`.
  - **`401`** The generic, non-disclosing device refusal.
  - **`5xx`** `system_failure`.
- **Not used:** `404`. "No logo" is `200` with `logo: null` (spec FR-17).
- **Cache headers:** `Cache-Control: no-cache, private`. The POS revalidates every time.

## 3. Surface 2 — Console: read the current logo

- **Operation:** `GET /api/v1/tenants/{tenant_id}/logo`, operationId `consoleGetTenantLogo`, tag `branding-console`.
- **Security:** `cookieAuth` (`dp2_session`) **only**. A request authenticated only by a bearer token (`dashboard_api` included, no session cookie) gets `401` (`SessionOnlyAdminGuard` admits only a session principal, as in `shift-closes`). The same applies to Surfaces 3–5.
- **Roles:** `owner` or `tenant_admin` of `{tenant_id}`. A wrong role, an unknown tenant or another tenant gets `404` (safe 404, XII).
- **Responses:**
  - `200 TenantBranding` (the same shape as Surface 1, so the preview is the POS truth);
  - `401` (no session; a bearer-only request);
  - `404`;
  - `5xx system_failure`.

## 4. Surfaces 3–5 — Console: preview, save, remove

The request body for preview and save is the **raw file bytes**, accepted under any `Content-Type` (declared as `*/*` in the YAML) and read as bytes (spec OD-14: no multipart parser). Admin-Console sends `application/octet-stream`; a client sending `image/png` or `image/svg+xml` is treated the same, so there is no `415`. The body limit is 1 MiB. Anything larger gets `413 file_too_large` before parsing. The declared content type and any file name are ignored for type detection (FR-03).

### Surface 3 — Preview

- **Operation:** `POST /api/v1/tenants/{tenant_id}/logo/preview`, operationId `consolePreviewTenantLogo`.
- **Behaviour:** validate, normalize and render. It **stores nothing** and writes no audit event.
- **Responses:**
  - `200 LogoPreview`;
  - `400 validation_error` (an unknown query key or an empty body);
  - `401`;
  - `403 origin_rejected`;
  - `404`;
  - `413 file_too_large`;
  - `422` with a §5 code;
  - `5xx system_failure`.

### Surface 4 — Save or replace

- **Operation:** `PUT /api/v1/tenants/{tenant_id}/logo?preview_version=<64-hex>&expected_revision=<integer ≥ 0>`, operationId `consolePutTenantLogo`.
- **`preview_version`** is **required**.
- **Order of checks**, each stopping the call:
  1. Re-run the full pipeline on the body. A validation failure returns `422`.
  2. Compare the computed version with `preview_version`. A difference returns `409 logo_preview_mismatch` and stores nothing.
  3. Idempotent replay: the stored version already equals the computed version → `200`, no audit.
  4. `expected_revision` mismatch → `409 logo_changed_concurrently`.
  5. Write.

  The replay therefore never skips body validation.
- **`expected_revision`** is **required** (spec OD-15, FR-14a). It is the `revision` the admin saw. It is checked after the idempotent replay (step 4 above). The check, the write and the revision increment run in one transaction under `SELECT … FOR UPDATE` on the tenant's `tenants` row, which always exists. Two concurrent writes, including two first uploads at revision `0`, therefore cannot both succeed, and a separately stored revision row can be created lazily under that lock.
- **Behaviour:** upsert the single tenant record, master and renditions together in one transaction, increment `revision`, and write the audit event `tenant.logo.replaced`.
- **Idempotent replay (step 3):** a valid body whose version equals `preview_version` and the stored version returns `200` and writes **no** audit event, whatever `expected_revision` says. A retried save therefore never fails on its own earlier success.
- **Responses:**
  - `200 TenantBranding`;
  - `400 validation_error` (a missing or malformed query parameter, an unknown key, or an empty body);
  - `401`;
  - `403 origin_rejected`;
  - `404`;
  - `409 logo_preview_mismatch` or `409 logo_changed_concurrently`;
  - `413 file_too_large`;
  - `422` with a §5 code;
  - `5xx system_failure`.

### Surface 5 — Remove

- **Operation:** `DELETE /api/v1/tenants/{tenant_id}/logo?expected_revision=<integer ≥ 0>`, operationId `consoleDeleteTenantLogo`.
- **`expected_revision`** is **required**. The no-logo replay below is checked **first**; only when a logo is stored does a mismatch return `409 logo_changed_concurrently`, deleting nothing.
- **Behaviour:** under the same `tenants` row lock as Surface 4, delete the record and its renditions, increment `revision`, write the audit event `tenant.logo.removed`, and return `200 TenantBranding` (`logo: null`, the new `revision`) so the Console can chain its next write.
- **Idempotent:** with no logo stored it returns `200 TenantBranding` (`logo: null`, the current `revision`, unchanged) and writes no audit event, whatever `expected_revision` says.
- **Responses:**
  - `200 TenantBranding`;
  - `400 validation_error` (a missing or malformed `expected_revision`, or an unknown key);
  - `401`;
  - `403 origin_rejected`;
  - `404`;
  - `409 logo_changed_concurrently`;
  - `5xx system_failure`.

## 5. Refusal codes (`422`, closed set, `error.code` enum)

| `error.code` | When |
|---|---|
| `file_type_not_allowed` | The magic bytes are neither PNG nor SVG. |
| `image_malformed` | The PNG fails CRC or decode, is truncated, or has bytes after `IEND`; or the SVG is not well-formed XML. |
| `image_dimensions_too_large` | Either side is above 4000 px, or the pixel count is above 16 000 000 (checked from `IHDR` before decode). |
| `image_too_small` | The trimmed content is below 512 × 512 (square-ish) or below 256 px tall (horizontal). |
| `aspect_ratio_out_of_range` | The trimmed content aspect is below 1:1 (taller than wide) or above 4:1. |
| `image_empty` | Nothing is left after trimming (fully transparent or a single colour). |
| `svg_unsafe_content` | One of the FR-07 constructs is present. `details.construct` names the category (`script`, `event_handler`, `external_reference`, `foreign_object`, `entity`, `image_element`, `css_import`); no excerpt is echoed back. |
| `svg_unsupported` | There is no usable `viewBox` or width and height, or the rasterizer limits are exceeded (element count or nesting depth). |

These are **outside** the `422` set:

- `413 file_too_large` (transport);
- `400 validation_error` (a missing or extra query key, or an empty body);
- `409 logo_preview_mismatch` and `409 logo_changed_concurrently`;
- `403 origin_rejected`;
- `401`;
- `404 not_found`;
- `5xx system_failure`.

## 6. Warnings (closed set, never blocking)

| Value | Rule (proposed; thresholds are server config) |
|---|---|
| `low_contrast` | See §6.1. It also forces `presentation.card = true`. |
| `receipt_high_black_coverage` | Black pixels make up more than 35% of the receipt rendition area. |
| `receipt_thin_strokes` | See §6.2. |

### 6.1 `low_contrast`

1. Take the master's ink pixels (alpha ≥ 128).
2. For each, compute the WCAG contrast ratio of its sRGB colour against `#ffffff`.
3. `low_contrast` applies when **fewer than 50%** of the ink pixels reach ≥ 3:1.

### 6.2 `receipt_thin_strokes`

1. On the 1-bit receipt rendition, a black pixel is **thin** when no fully black 2 × 2 block contains it (that is, a stroke under 2 dots).
2. `receipt_thin_strokes` applies when thin pixels are **more than 10%** of all black pixels.

## 7. Audit events (Constitution XIII)

| Event | Payload | Actor / tenant |
|---|---|---|
| `tenant.logo.replaced` | `{from_version: string \| null, to_version}` | From the request context |
| `tenant.logo.removed` | `{from_version}` | From the request context |
| `tenant.logo.rerendered` | `{from_version, to_version}` | System actor (OD-8 re-render job), tenant from the job |

Image bytes, base64 and file names are never logged or audited (XIV).

## 8. Explicitly out of scope (do NOT author)

- Any per-store or per-branch branding field (D-1).
- Any receipt-upload or light-variant operation (11846).
- Serving the SVG or any URL to an asset.
- Any change to `pos-terminal-pairing` (OD-9 keeps branding off the pairing response).
- Any change to `TenantUpdate` (OD-10 keeps `tenants.name` as is).
- The legacy `/api/v1/branding/*` shapes found in POS's DataPulse snapshot.
