# Retail Tower OS — Icon System

## Status

Draft — approved for documentation, pitch, and identity use.
Not applied to any frontend implementation. See [Scope Notes](#scope-notes).

---

## Purpose

A consistent set of SVG line icons representing the core capability areas
of Retail Tower OS. Intended for use in README, docs, pitch materials,
and future landing page. Not tied to any implemented UI component library.

---

## Icon Style

| Property | Value |
| --- | --- |
| Format | SVG, inline-authored, human-reviewable |
| ViewBox | `0 0 24 24` |
| Default render size | 24×24 px (scalable via CSS `width`/`height`) |
| Fill | `none` (stroke-only) |
| Primary stroke | `#C8A24A` (muted gold) |
| Accent stroke | `#22D6F6` (ice cyan) — used sparingly for key focal elements |
| Stroke width | `1.75` (primary) · `1.5` (accents) |
| Stroke caps | `round` |
| Stroke joins | `round` |
| Background | Transparent |
| Style | Premium enterprise line icons — command tower / control room / branch network aesthetic |

---

## Color Tokens

| Token | Hex | Role |
| --- | --- | --- |
| Gold | `#C8A24A` | Primary stroke — structure, frames, connections |
| Ice Cyan | `#22D6F6` | Accent — focal points, status indicators, key nodes |

---

## Approved Icons

Icons live at `docs/assets/brand/icons/`.

| File | Concept | Description |
| --- | --- | --- |
| `branch-ops.svg` | Branch operations | Command tower node radiating to branch nodes below |
| `access-control.svg` | Access gate | Shield with keyhole — tenant-scoped identity and access |
| `catalog.svg` | Product catalog | Layered structured rows — global product index |
| `inventory.svg` | Stock levels | Stacked boxes — inventory and stock management |
| `pos-core.svg` | POS terminal | Counter terminal with screen — POS connectivity core |
| `store-network.svg` | Branch network | Central hub connected to four branch nodes |
| `integrations.svg` | API / plug | Electrical plug with connector — external integrations |
| `audit-compliance.svg` | Audit trail | Shield with checkmark — compliance and audit provenance |
| `dashboard.svg` | Control panel | Screen with chart and metrics — operations dashboard vision |
| `security.svg` | Secure core | Layered double shield — multi-layer security architecture |

---

## Usage Guidelines

- Render at `24px` or scale up proportionally (48px, 64px, 96px).
- Do not distort aspect ratio — always scale uniformly.
- On dark backgrounds (deep navy, charcoal): gold stroke reads well without modification.
- On light backgrounds: consider applying a dark filter or using CSS `filter: invert()` where appropriate.
- Do not recolor icons outside the approved palette without brand review.
- Do not use as UI component icons in the application until a UI framework
  decision is made and these icons are formally adopted into a component library.
- Reference via relative path from Markdown docs, for example:
  `![Branch Ops](../assets/brand/icons/branch-ops.svg)`

---

## SVG Authoring Rules

- No XML declaration — start directly with `<svg>`.
- No embedded raster data (no base64 blobs).
- No Illustrator or Inkscape metadata.
- `fill="none"` on the root `<svg>` element.
- All stroke colors set explicitly (not inherited from CSS) so icons render
  correctly in GitHub Markdown without a stylesheet.
- Keep total file size under 2 KB per icon.
- Use comments (`<!-- description -->`) to identify the icon concept.
- Human-reviewable in a plain git diff.

---

## Scope Notes

> **Important**: These icons are brand and documentation assets only.
> **Backend-Core is the canonical backend repository** for this project.

- These icons do **not** imply that a dashboard UI is implemented in this
  repository.
- They do **not** replace OpenAPI contracts or implementation architecture
  diagrams.
- They do **not** imply that the POS application lives in this repository.
- They are intended for README, product vision, docs, pitch materials, and
  future landing page use — not for import into application source code.

---

## Future Decisions

The following are not yet decided or approved:

- [ ] Adopt icons into a frontend component library once a UI framework is chosen.
- [ ] Produce dark-mode and light-mode color variants.
- [ ] Commission a full logomark and wordmark to complement the icon set.
- [ ] Define animation and motion guidelines for landing page use.
