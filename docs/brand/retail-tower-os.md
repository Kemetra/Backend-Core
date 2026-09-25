# Retail Tower OS — Brand Identity

## Status

Draft — approved for documentation and product-vision use.
Not yet applied to repository identifiers, package names, OpenAPI titles,
or deployment configuration. See [Repository Scope Notes](#repository-scope-notes).

---

## Brand Name

**Retail Tower OS**

---

## Logo Concept

Fortified command watchtower mark.

A single, elevated structure that surveys and commands the entire retail
landscape — communicating authority, visibility, and architectural solidity.

---

## Primary Slogan

> The command tower for modern retail.

---

## Secondary Slogan

> Control every branch from one secure core.

---

## Punchline

> One tower. Every branch. Total control.

---

## Visual Direction

**Premium Fortress Watchtower / Premium Watchtower Enterprise**

Deep, authoritative tones. Structured geometry. A visual language of
command, control, and clarity — not decoration. Assets should convey
that operators are at the top of the tower looking out, not buried in
complexity looking up.

---

## Positioning

Retail Tower OS is the premium command layer for multi-branch retail
operations. It unifies branch operations, access control, catalog
workflows, POS connectivity, and integrations under one secure operating
core — giving ownership groups and operations teams a single, trusted
command surface across every location they run.

---

## Product Meaning

Retail Tower OS is not a point-of-sale application. It is the platform
that stands behind every branch:

- **Multi-tenant architecture** — each ownership group operates in a
  fully isolated tenant context.
- **Catalog authority** — a global product index propagated through
  tenant and store layers, with store-level override capability.
- **POS connectivity** — the API gateway that POS applications connect
  to; the POS app itself lives in a separate repository.
- **Access control** — role-based identity for operators, staff, and
  administrators, scoped to tenant and store.
- **Audit and provenance** — every mutation is traceable; sale facts
  are immutable once committed.

The tower metaphor is precise: you do not operate in the tower — you
operate *from* it.

---

## Approved Imagery

These are product-vision brand assets. They represent the external product
identity of Retail Tower OS and are intended for use in README/product
vision, docs, pitch materials, and future landing page. They do **not**
imply that a dashboard frontend, POS application, or production operations
UI is implemented in this repository.

### Exterior Hero

![Retail Tower OS Exterior Hero](../assets/brand/exterior/retail-tower-os-exterior-hero.png)

Fortified retail command tower illuminated at dusk, overlooking a connected
branch network. The canonical exterior product-vision image.

**Use for:** project hero, product vision, pitch cover, future landing page,
brand introduction.

### Interior Command View

![Retail Tower OS Interior Command View](../assets/brand/interior/retail-tower-os-interior-command-view.png)

Leadership perspective from inside the command tower — operator at the command
desk with a panoramic view of the live branch network below.

**Use for:** command center vision, operations view, dashboard vision,
enterprise presentation.

---

## Icon System

A companion SVG icon set lives at `docs/assets/brand/icons/`. See
[`docs/brand/icon-system.md`](icon-system.md) for style rules, color tokens,
the full approved icon list, and usage guidelines.

---

## Repository Scope Notes

> **Important**: Retail Tower OS is the external product identity and
> product-vision brand. **Backend-Core is the canonical backend repository.**
> Legacy package names, code identifiers, OpenAPI `info.title` values, and
> deployment identifiers remain intentionally stable unless separately migrated.

- The brand imagery above describes **product identity and vision only**.
- It does **not** imply that a dashboard frontend is implemented in this
  repository.
- It does **not** imply that the POS application lives in this
  repository — the POS app is a separate repository that integrates
  through the OpenAPI contracts in `packages/contracts/openapi/`.
- It does **not** imply that production operations UI is shipped today.
- The icon SVGs are brand and docs assets only — they do not replace
  OpenAPI contracts or implementation architecture diagrams.

Future decisions to rename packages or API titles to match the Retail Tower OS
brand will be made explicitly and tracked as separate approved changes.

---

## Usage Guidelines

- Use **Retail Tower OS** (full form) in product communications,
  investor materials, sales assets, and external documentation.
- Do **not** use "RTO" as an abbreviation without prior brand approval.
- Do **not** place brand imagery next to UI screenshots that are not yet
  implemented — the exterior and interior visuals are vision assets,
  not feature screenshots.
- Do **not** alter or crop the approved images without explicit approval.
- Brand assets live in `docs/assets/brand/`. Do not copy them into
  application source directories.

---

## Future Decisions

The following are **not yet decided or approved** and must be tracked as
explicit separate changes when the time comes:

- [ ] Update package names (`@data-pulse/*` → brand-aligned namespace).
- [ ] Update OpenAPI `info.title` in `packages/contracts/openapi/`.
- [ ] Adopt Retail Tower OS product naming in any remaining deployment identifiers.
- [ ] Commission or finalize the fortified watchtower logomark.
- [ ] Define full brand color palette and typography system.
- [ ] Produce brand guidelines document covering all touchpoints.
