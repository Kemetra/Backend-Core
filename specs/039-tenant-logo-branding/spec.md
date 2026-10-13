# Spec 039 — Tenant logo branding (cross-repo contract plan)

| | |
|---|---|
| **Jira** | RT-472 (Planning). Follow-ups: RT-473 (Backend-Core), RT-474 (Admin-Console), RT-475 (POS screens), RT-476 (POS receipt). Overlaps RT-404, RT-405, RT-406 (see §9). |
| **Work Mode** | Planning, contract-first. This document is the Planning deliverable. It contains no production code. |
| **Repository** | `Kemetra/Backend-Core` (contract owner). Consumer sections cover `Kemetra/Admin-Console` and `Kemetra/POS`. |
| **Baseline** | Backend-Core `origin/main` @ `1558eee`; POS `origin/main` @ `9689500`; Admin-Console `origin/main` @ `8ddb067` (2026-10-13). |
| **Status** | PROPOSED. The owner decisions D-1…D-5 and comment 11846 are binding inputs. Every `OD-*` below is a recommendation awaiting owner approval. The OpenAPI YAML is **not** authored here; it is the first, GATED step of RT-473. |

## 1. Objective

Show the tenant's identity on the POS boot, pairing, sign-in and lock screens and on the printed receipt, with Retail Tower as a small secondary "powered by" mark. Branding never adds a wait, and it works offline.

## 2. Binding owner decisions (RT-472, 2026-10-13)

| # | Decision |
|---|---|
| D-1 | One logo per **tenant**. No per-branch or per-store logo. |
| D-2 | The tenant logo is also printed **on the receipt**. |
| D-3 | Tenant brand first. Retail Tower is a small secondary mark. No standalone splash screen. |
| D-4 | Screen-logo criteria (RT-472 comment 11845), approved. |
| D-5 | Receipt-logo criteria (comment 11845), approved. |
| 11846-a | The receipt logo is **automatic only**: always derived from the screen logo. No receipt upload. The D-5 override is dropped. |
| 11846-b | The lock screen is **light**. No light-variant upload. One upload per tenant. |
| 11846-c | Printer dpi and printable width are **measured on the bench, not assumed**. |

## 3. What exists on `main` today (verified)

### Backend-Core

- `tenants` (`packages/db/src/schema/tenants.ts`) holds `id, slug, name, status, created_at, updated_at, deleted_at`. `name` is `text NOT NULL`. The contract is `minLength: 1` with no maximum. There are no settings, branding or JSONB columns.
- There is **no object store** (no S3/R2/MinIO SDK, no bucket config) and **no multipart handling** anywhere in `apps/api`.
- There is **no image-processing dependency** (no `sharp`, `resvg`, `pngjs` or `jimp`) in any `package.json` or in the lockfile.
- Tenant routes are `api/v1/tenants` behind `DashboardAuthGuard`. Writes use `@RolesFromParam("id","owner","tenant_admin")`. A wrong role or another tenant gets `404`, and a cookie write gets `403 origin_rejected` (RT-430).
- The POS device scheme is `device` (`catalog/read-down.yaml`). `PosDeviceAuthGuard` resolves `(tenant_id, store_id)` from the `devices` row only.
- The latest migration is `0045_tracking_foundation`, so the next is `0046`.

### POS

- `TerminalPairResponse` has `branch_name`, `branch_address` and `tenant_tax_registration_id`, but **no tenant name and no logo**. The renderer sees only `PairingStatus` (ids, label, `paired_at`). It does not see `branch_name` (RT-246 deferral).
- `src/shared/api-types.ts` contains `/api/v1/branding/*` and `PublicBrandingResponse`. These come from the **legacy DataPulse snapshot** (`scripts/openapi-snapshot.json`, title "DataPulse API"), not from Backend-Core. They are **not** a contract and must not be consumed (Constitution I).
- The brand slot is hard-coded as the «POS Pulse» wordmark in `v5/entry/EntryStrip.tsx` and `v5/frame/V5Navigation.tsx`. VNext OD-5 says "Keep «POS Pulse» until a branding decision exists"; this spec is input to that decision (OD-12).
- Screens: `v5/foundation/RouteLoading.tsx` (boot), `routes/pairing/PairingScreen.tsx`, `routes/sign-in.tsx` with `v5/entry/*`, and `session/LockScreen.tsx`.
- The renderer CSP already allows `img-src 'self' data:`, so a `data:` image needs **no CSP change**.
- Receipts: `src/main/receipts/template-engine.ts` composes **text-only** bands and serialises them twice, to ESC/POS and to HTML. It is deterministic (AD-6). The live path is OS-print (`os-print-transport.ts`, a hidden `BrowserWindow`, `webContents.print`, 80 mm page, `.receipt` 70 mm, `printBackground: true`). ESC/POS-direct is a stub and is not selected.
- There is no user-facing unpair. `PairingStore.clear()` has no caller. A re-pair overwrites `terminal_assignment` and relaunches the app if the paired-only workers already ran.
- The latest migration is `0050_carts_park`, so the next is `0051`.

### Admin-Console

- React 19, react-router 7, react-query and `openapi-fetch`. Types are generated from a **pinned** Backend-Core SHA (`openapi-ts.config.ts`, `OPENAPI_SOURCE_SPECS`).
- Tenant pages are in `src/tenants/*` and `src/shell/rf2Routes.tsx`. There is **no file-upload component** anywhere.
- Error copy is keyed on `error.code` (see `classifyInviteOutcome`). The Arabic catalog is in `src/i18n/messages/ar/*.ts`.

### Bench (Confluence 18874418, RT-110)

- The bench printers are BIXOLON SRP-330 II and SRP-B300 on the Windows OS-print path. The 80 mm width was checked only visually (RT-110 comment 10559).
- **The dpi and the printable width in dots were never measured.** No image has ever been printed on the bench.

## 4. Requirements

### Backend-Core (RT-473)

- **FR-01** One logo record per tenant (D-1). Writing it requires `owner` or `tenant_admin` of that tenant. The tenant comes from the path parameter, checked against the session (Constitution XII). It is never taken from the body. Another tenant, or a wrong role, gets `404`.
- **FR-02** Any refusal is a `422` whose `error.code` is one value from the closed set in `contracts/README.md` §5.
- **FR-03** The file type is decided **only by magic bytes**: PNG (`89 50 4E 47 0D 0A 1A 0A`) or SVG (an XML prolog or `<svg` root after optional BOM and whitespace). The file name, the extension and the declared `Content-Type` are ignored. They neither accept nor refuse.
- **FR-04** The upload is at most 1 MiB, enforced by the HTTP body limit before any parsing.
- **FR-05** PNG dimensions are read from the `IHDR` chunk **before any pixel decode**. If either side is above 4000 px, or the pixel count is above 4000 × 4000, the upload is refused before decoding (bomb guard). The decoder also runs with an explicit input-pixel limit as a second guard.
- **FR-06** A PNG with bytes after `IEND`, or one that fails CRC or decoding, is refused as `image_malformed` (this covers the PNG/ZIP polyglot). An animated PNG keeps only its default image after re-encoding.
- **FR-07** SVG is refused as `svg_unsafe_content` when it contains any of:
  - a `DOCTYPE` or entity declaration;
  - `<script>`, `<foreignObject>`, `<iframe>`, `<embed>` or `<object>`;
  - any `on*` attribute;
  - any `href`/`xlink:href` that is not a same-document fragment (`#id`);
  - `<image>`;
  - CSS `url(` that is not a fragment, or `@import`.

  It is rasterized by a renderer with **all resource loading disabled** (no network, no file system). The SVG is never stored and never served.
- **FR-08** Normalization:
  - decode;
  - convert to sRGB;
  - drop every metadata chunk (EXIF, XMP, iCCP after conversion, text chunks);
  - trim the empty margins (transparent pixels, or the border colour when the image is opaque);
  - add a uniform 8% clear space on each side;
  - re-encode as PNG with fixed encoder options.

  The result is the **master**.
- **FR-09** Shape checks run on the **trimmed content box** (OD-4):
  - square-ish (aspect < 1.25, a threshold proposed in OD-4): at least 512 × 512;
  - otherwise: at least 256 px tall;
  - aspect (width ÷ height) in [1.0, 4.0]. A taller-than-wide image is refused.

  A rasterized SVG is produced at a fixed size that always meets the minimum, so only the aspect check applies to it.
- **FR-10** Screen renditions are produced at 1x and 2x for each slot (`boot`, `pairing`, `sign_in`, `lock`). Each is `contain`-fitted inside the slot box from the approved references (OD-7) and is **never upscaled** beyond the master's native pixels.
- **FR-11** Presentation:
  - `presentation.card` is `true` when the master has an opaque background, or when `low_contrast` applies;
  - the POS then shows the logo on a white rounded card;
  - `low_contrast` uses the rule in `contracts/README.md` §6.1, measured against the POS light surface `#ffffff` (POS `docs/DESIGN.md` `surface`).
- **FR-12** The receipt rendition is produced in these steps:
  1. composite onto white;
  2. convert to grayscale (BT.709 integer luma);
  3. resize to fit `RECEIPT_MAX_W_PX × RECEIPT_MAX_H_PX`, which is 48 × 15 mm at `RECEIPT_DPI`;
  4. apply in-repo **integer Floyd–Steinberg** dithering (OD-6);
  5. encode as a 1-bit PNG.

  The warnings `receipt_high_black_coverage` (> 35% black) and `receipt_thin_strokes` (`contracts/README.md` §6.2) never block the upload.
- **FR-13** The upload is deterministic. With the same upload bytes, pipeline version and rendition configuration, the server produces the same master, the same rendition bytes and the same `version`. `version` is the lowercase hex SHA-256 over `master PNG ‖ pipeline_version ‖ canonical rendition config`.
- **FR-14** Preview writes nothing. Saving requires the version that was previewed, so what the admin approved is exactly what is stored (OD-3).
- **FR-15** A replace or a remove writes one audit event in the same transaction: `tenant.logo.replaced` `{from_version, to_version}` or `tenant.logo.removed` `{from_version}`. Actor and tenant come from the request context (Constitution XIII). Image bytes are never logged.
- **FR-16** The POS read is device-authenticated. The tenant comes only from the device row. There is no tenant parameter.
- **FR-17** The POS read carries the tenant display name, so the fallback text exists even without a logo. "No logo" is `200` with `logo: null`, never an error.
- **FR-18** The POS read supports `ETag` / `If-None-Match`. The ETag changes only when the name or the logo version changes. An unchanged poll returns `304` with no body.

### Admin-Console (RT-474)

- **FR-20** One upload field, for PNG or SVG up to 1 MiB. Client checks of size and type are only for fast feedback. All real validation is in Backend-Core.
- **FR-21** The flow is pick a file, then preview (server), then confirm and save (server, with the preview version). Remove has a confirm step.
- **FR-22** Every refusal code in `contracts/README.md` §5 maps to its own Arabic message key, for example `tenants.logo.errors.<code>`, each with a test.
- **FR-23** Warnings are shown and never block saving. `low_contrast` makes the preview show the white card.
- **FR-24** The preview uses the **server renditions only**, never a client re-render. The receipt preview shows the 1-bit rendition at its physical width in CSS millimetres on an 80 mm strip.
- **FR-25** The UI gate mirrors the API roles (`owner`, `tenant_admin`), following the `stockDiscrepancyLogic.ts` pattern. It is not an authorization decision; the API stays authoritative.

### POS (RT-475, RT-476)

- **FR-30** A paired-only branding worker starts on the `pairedWorkersLatch`. It reads the branding at app start and then hourly with the device token, sending `If-None-Match`. It is not gated on an operator session. It stops on quit through `workerRegistry`.
- **FR-31** The cache is stored locally, keyed by `tenant_id` and `version`. It is replaced in one transaction, so the old renditions are deleted in the same write. A cache whose `tenant_id` differs from the current pairing is ignored and purged.
- **FR-32** The cache is cleared on re-pair to a different tenant and on any future unpair path (`PairingStore.clear()`). Revocation does not clear it, because the terminal still belongs to the tenant.
- **FR-33** The renderer gets the branding only through a typed bridge channel, as image bytes or a `data:` URI. No file path and no network URL is exposed (P8). The new channels need an §A4 record and the cache table needs an §A2 record.
- **FR-34** Each surface has a fixed slot. The layout never shifts. The image is `object-fit: contain`, centred, never stretched or upscaled. `presentation.card` puts it on a white card. Under `forced-colors` the card border uses a system colour.
- **FR-35** Fallback: with no logo, an unreadable cache, or an image decode error, the slot shows the tenant display name as text. It never shows a broken image or an empty box.
- **FR-36** The boot screen reads only the local cache. It never waits on the network.
- **FR-37** The receipt places the receipt rendition centred at the top. Its CSS size in millimetres is exactly `width_px / dpi × 25.4`, with `image-rendering: pixelated`. With no logo the receipt is byte-identical to today's output. Receipt rendering stays a pure function of its inputs: the logo bytes are an explicit input to `renderReceipt`.

## 5. Owner decisions required (PROPOSED: recommendation first)

| # | Question | Recommendation | Alternatives |
|---|---|---|---|
| **OD-1** | Where are the logo bytes stored? | **Postgres `bytea`**: the master and every rendition in a tenant-scoped table under FORCE RLS (migration `0046`, GATED). About 150 KB per tenant. It needs no new infrastructure, it is in backup and PITR, and Postgres stays the system of record (Constitution III). | An object store (S3/R2) is new infrastructure, secrets and a deploy change; defer it until assets grow. |
| **OD-2** | Which image library? | **`sharp`** (libvips) for PNG decode, sRGB, metadata strip, trim, resize and encode. **`@resvg/resvg-js`** for SVG rasterization with resource loading off. Dithering and the checks are **in-repo integer code** for determinism. This is a dependency and lockfile change, so it is GATED. The versions are pinned exactly, because determinism (FR-13) holds per pinned version. | `jimp` (pure JS, slower, weaker PNG validation); SVG via `sharp`/librsvg (less control over resource loading). |
| **OD-3** | How does the admin preview before saving? | **Stateless preview, then save with `preview_version`.** Preview returns the renditions and warnings and stores nothing. Save re-processes the same bytes and refuses with `409 logo_preview_mismatch` if the version differs. | A server-side draft (needs draft storage, expiry and cleanup). |
| **OD-4** | Are the shape checks run before or after trimming? | **After trimming**, on the content box, because that is what is displayed. The 4000 px cap is checked **before** decode, on the raw header. "Square" means a content aspect below 1.25:1; at 1.25:1 and above the logo counts as horizontal (≥ 256 px tall). | All checks on the raw upload (a 512 px canvas with a tiny logo would pass and look blurry). |
| **OD-5** | How do the bytes reach the POS? | **One JSON read with base64 renditions, plus `ETag`/`304`.** The version is atomic across all renditions, no asset URLs are exposed, and an hourly unchanged poll costs one `304`. | Metadata JSON plus per-rendition binary GETs (more requests, a torn-version risk). |
| **OD-6** | Threshold or dither for the receipt? | **Integer Floyd–Steinberg** (deterministic, keeps mid-tone brand colours visible). The coverage and thin-stroke warnings let the tenant judge it in the preview. | A fixed 50% threshold (a light brand colour can vanish). |
| **OD-7** | What are the slot sizes? | The rendition **shape is fixed now**. The pixel boxes for `boot`, `pairing`, `sign_in` and `lock` are **server configuration filled from the owner-approved 1024/1280 references** (freeze rule). Until then, RT-473 cannot finish FR-10. | — |
| **OD-8** | What are the printer dpi and printable width? | **Measure them on the bench** (11846-c). `RECEIPT_DPI` and `RECEIPT_PRINTABLE_WIDTH_MM` are server configuration. A config change changes `version`, so re-rendering existing logos needs a one-off re-render job (worker), in scope for RT-473. | — |
| **OD-9** | What happens before pairing? | The **pre-pair** pairing form has no device token, so it **cannot** know the tenant. It shows the product mark only. The tenant name and logo appear on the **post-pair confirmation** (first run), fetched right after the pairing succeeds, so the technician can confirm the tenant. | Add branding to the pairing response (a contract change to `pos-terminal-pairing`, which is pinned at pair time and goes stale). |
| **OD-10** | Which display name? | Use the existing **`tenants.name`** as the display name in v1, with no new field. Set a **max length of 80** for display, enforced by POS ellipsis. Do not change the schema here. | A separate `display_name` column (answers RT-404 Q2 differently). |
| **OD-11** | Which logo does a reprint use? | The logo is **current branding at print time**, not part of the sale's fiscal record, so a reprint after a logo change shows the new logo. Receipt text content is unchanged. | Snapshot the logo version on the sale (migration plus retention of old renditions). |
| **OD-12** | What does the "powered by" mark say? | D-3 says "Retail Tower", but the shipped wordmark is «POS Pulse» (VNext OD-5). **The owner picks the exact string and where it shows** (footer of the entry surfaces). The VNext references carry it. | — |
| **OD-13** | What happens to RT-404, RT-405 and RT-406? | They are the same feature, filed on 2026-10-12. **Mark them superseded by RT-472…RT-476.** This spec answers RT-404's questions: where POS reads (OD-5, FR-16), the name (OD-10), the logo (FR-03…FR-13), isolation (FR-16) and audit (FR-15). | Keep them and re-link them as duplicates. |
| **OD-14** | How are the upload bytes sent? | **A raw `application/octet-stream` body** for preview and save, capped at 1 MiB by the body limit. It needs no multipart parser and adds no attack surface. Admin-Console sends it with an `openapi-fetch` body serializer. | `multipart/form-data` through `FileInterceptor` (multer, already a transitive dependency of `@nestjs/platform-express`). |

## 6. Security and privacy (RT-472 Q5)

- **Type confusion:** magic bytes only (FR-03). The tests cover a `.png` with SVG bytes (accepted as SVG) and a `.svg` or `.png` with JPEG/GIF/ZIP bytes (refused).
- **Decompression bomb:** the header-only dimension check (FR-05), the decoder pixel limit, and the 1 MiB body cap before parsing (FR-04).
- **SVG:** a refuse-list (FR-07) plus resource-less rasterization (defence in depth). The parser runs with entity expansion off. The SVG is never served. No SSRF is possible because nothing is fetched.
- **Polyglot:** trailing data is refused (FR-06), and re-encoding guarantees the served bytes are a clean PNG.
- **Privacy:** every metadata chunk is stripped (FR-08). The original upload bytes are **not stored**; only the normalized master is.
- **Tenant isolation:**
  - Admin access is path tenant plus session role, with `404` across tenants.
  - The POS has no tenant parameter at all.
  - RLS covers the logo table.
  - The tests cover tenant A reading or replacing tenant B's logo, and a device of tenant A reading the branding.
- **Rendering:**
  - The POS renders only PNG bytes the server re-encoded, through `data:`, under the existing CSP.
  - The Admin-Console renders only server renditions.

## 7. Receipt impact (RT-472 Q4)

- **Paper:** at most 15 mm extra per receipt, plus a configured gap.
- **Speed:** the bench measures the delta (RT-476 evidence). One 1-bit image of about 340 × 106 to 384 × 120 px is expected to add little; this is a hypothesis to measure, not a claim.
- **Print failure:** unchanged. The logo is part of the same HTML document. If the logo cannot be decoded, the receipt prints without it (FR-35/FR-37).
- **Path:** OS-print only. ESC/POS raster is out of scope. The ESC/POS serializer skips the image band.

## 8. Follow-up slicing (already created; this spec is their contract input)

| Order | Issue | Starts when |
|---|---|---|
| 1 | **RT-473 S1** — author the OpenAPI YAML for `contracts/README.md`, GATED contract PR, owner review | OD-1…OD-6, OD-10 and OD-14 approved |
| 2 | **RT-473 S2** — migration `0046` (GATED), dependencies (GATED), pipeline, endpoints, tests | S1 merged; OD-7 slot boxes and OD-8 bench dpi known (the pipeline can land behind config before both) |
| 3 | **RT-474** — Admin-Console upload, preview and remove (re-pin the generated types) | RT-473 S1 merged (the UI can build against the contract); end-to-end needs S2 |
| 4 | **RT-475** — POS worker, cache (`0051`, §A2), bridge (§A4), slots | RT-473 S2 deployed; owner-approved references at 1024/1280 for the four surfaces, plus the post-pair confirmation (OD-9) and the powered-by string (OD-12) |
| 5 | **RT-476** — POS receipt logo plus bench evidence | RT-475 merged; OD-8 measured |

**Bench task (prerequisite of S2/RT-476):** print a calibration page (a 1 mm grid plus a known-pixel-width bar) on the SRP-330 II and the SRP-B300 through the same OS-print path, then derive dpi and printable width. Record the procedure in the Lab and Bench Runbook.

## 9. Out of scope

- Per-branch logos (D-1).
- Tenant theming or colours.
- A standalone splash screen (D-3).
- A receipt-specific upload or a light-variant upload (11846).
- ESC/POS raster commands.
- A logo in the in-app frame (`V5Navigation`) unless the owner adds it.
- Any use of the legacy `/api/v1/branding/*` snapshot types.
