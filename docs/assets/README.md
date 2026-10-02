# Retail Tower OS Visual Assets

This directory contains GitHub-renderable SVG assets used by the README and
architecture documentation.

## Files

| Path | Purpose |
| --- | --- |
| `hero-data-pulse.svg` | Primary README hero for the Retail Tower OS platform story. |
| `pulse-signature.svg` | Platform identity waveform used as a subtle visual throughline in the README. |
| `architecture-isometric.svg` | Isometric architecture visual used in `docs/ARCHITECTURE.md`. |
| `icons/*.svg` | Small reusable icons for platform capabilities and package areas. |

## Architecture visuals

Presentation-grade SVG maps of the Retail Tower OS platform architecture.
These use the Retail Tower OS visual identity (midnight navy, muted gold,
ice-cyan) to make the architecture immediately readable in a product or
engineering context.

The Mermaid diagrams in `docs/ARCHITECTURE.md` remain the **reviewable
technical source** — diffable, tooling-compatible, and authoritative. The
SVGs below are the **presentation layer** placed alongside each Mermaid
section for visual clarity.

| Path | Purpose |
| --- | --- |
| `architecture/retail-tower-os-system-map.svg` | Full platform topology — clients, API gateway, packages, PostgreSQL, Redis, worker. |
| `architecture/retail-tower-os-request-flow.svg` | Request pipeline — AuthGuard → TenantContextGuard → RolesGuard → service → DB/RLS → audit → response. |
| `architecture/retail-tower-os-tenant-boundary.svg` | Tenant isolation — Tenant A / B zones, RLS boundary, worker tenantId propagation. |

> These are architecture documentation assets, not UI screenshots or
> feature implementations. The POS application is a separate repository.
> Dashboard UI is a separate future feature.

## Brand assets

Product-vision and brand-identity imagery for **Retail Tower OS** — the
external product brand. These assets are for README/product vision, docs,
pitch materials, and future landing page use. They are **not** architecture
diagrams or feature screenshots, and they do **not** imply that a dashboard
frontend, POS application, or production operations UI is implemented in
this repository.

### Product vision imagery (v2 — canonical)

Large raster PNGs representing the Retail Tower OS visual identity.

| Path | Classification | Purpose |
| --- | --- | --- |
| `brand/exterior/retail-tower-os-exterior-hero.png` | **Exterior Hero** | Fortified retail command tower over connected branch network. Use for project hero, pitch cover, landing page. |
| `brand/interior/retail-tower-os-interior-command-view.png` | **Interior Command View** | Leadership command room overlooking the branch network. Use for command center vision, operations, enterprise presentation. |

> **PNG exception**: Brand imagery may be raster PNG when it is approved
> product-vision artwork that cannot be represented as SVG. Architecture
> diagrams and capability icons should remain SVG where possible for
> lightweight, reviewable documentation. Brand imagery is not the same
> as implementation architecture diagrams.

### Brand icons

SVG line icons representing Retail Tower OS capability areas. Human-reviewable,
stroke-based, 24×24 viewBox. Intended for docs, pitch, identity, and future
landing page use — not for import into application source code.

| Path | Purpose |
| --- | --- |
| `brand/icons/branch-ops.svg` | Branch operations / command flow |
| `brand/icons/access-control.svg` | Access gate / tenant-scoped identity |
| `brand/icons/catalog.svg` | Product catalog / global product index |
| `brand/icons/inventory.svg` | Stock levels / inventory management |
| `brand/icons/pos-core.svg` | POS terminal / connectivity core |
| `brand/icons/store-network.svg` | Connected stores / branch network |
| `brand/icons/integrations.svg` | API connection / external integrations |
| `brand/icons/audit-compliance.svg` | Audit trail / compliance provenance |
| `brand/icons/dashboard.svg` | Control panel / operations metrics vision |
| `brand/icons/security.svg` | Secure core / multi-layer security |

See [`docs/brand/icon-system.md`](../brand/icon-system.md) for the full style
specification, color tokens, authoring rules, and usage guidelines.

See [`docs/brand/retail-tower-os.md`](../brand/retail-tower-os.md) for the
complete brand identity record, scope notes, and usage guidelines.

## Style

- Use restrained enterprise SaaS colors: deep navy, slate, blue, teal, amber,
  and white.
- Prefer simple geometric shapes that remain legible in GitHub Markdown.
- Keep SVG text short and accessible with `title` and `desc` elements.
- Avoid raster-only assets for diagrams so the docs remain lightweight and easy
  to review.

## Naming

- Use lowercase kebab-case.
- Use capability names for icons, for example `tenant-isolation.svg`.
- Add new assets only when they support a documented section or diagram.
