/**
 * ReconciliationController — 005-WAVE2-LINK-HAPPY (T622) +
 *                            005-WAVE2-CREATE-HAPPY (T632).
 *
 * Implements the tenant-admin reconciliation routes defined in:
 *   packages/contracts/openapi/catalog/unknown-items.yaml
 *
 * Routes:
 *   POST /api/v1/catalog/unknown-items/:id/link
 *     operationId: tenantAdminLinkUnknownItem
 *   POST /api/v1/catalog/unknown-items/:id/create-product
 *     operationId: tenantAdminCreateProductFromUnknownItem
 *
 * Request bodies (snake_case per OpenAPI — Constitution §IV):
 *   LinkUnknownItemRequest:                   { product_id: UUID }
 *   CreateProductFromUnknownItemRequest:      { name: string,
 *                                               tax_category: string,
 *                                               category_id?: UUID | null }
 *   Both schemas use `additionalProperties: false`; enforced via `.strict()`
 *   on the Zod definitions below. The body-supplied `tenantId` (if any)
 *   is rejected with 400 `validation_error` — Constitution §III. OpenAPI and
 *   runtime use the same `validation_error` / ErrorCodes.VALIDATION wire code.
 *
 * Authentication & authorization (wired by 005-WAVE2-AUTH-GUARD-WIRING):
 *   Class-level `@UseGuards(DashboardAuthGuard, TenantContextGuard)`
 *   authenticates every request and publishes the resolved tenant
 *   context as `request.context`. Per-method `RolesGuard` + `@Roles`
 *   gate writes:
 *
 *     - POST link            → @Roles("owner","tenant_admin","store_manager")  // denyAs: 404
 *     - POST create-product  → @Roles("owner","tenant_admin")                  // denyAs: 404
 *
 *   Both are state changes against an existing `:id` (an unknown
 *   item the caller may or may not have access to); per FR-013 /
 *   FR-092 / SI-001, a wrong-role caller MUST NOT be able to
 *   distinguish "you exist but lack permission" from "this item
 *   does not exist", so the default `denyAs: 404` shape is correct.
 *   Integration tests `.overrideGuard()` these three guards with
 *   no-op passthroughs and continue to inject context via the
 *   global ConfigurableContextGuard registered on the test app.
 *
 * Audit subjects (no dual-emission — tasks.md L477):
 *   link        → @Auditable("unknown_item.resolved.linked")
 *   create      → @Auditable("unknown_item.resolved.created")
 *   The service owns raw `INSERT INTO tenant_products` SQL on the create
 *   path; it does NOT call TenantCatalogService.create (which would
 *   emit a second `catalog.product.create` audit row in the same
 *   transaction).
 *
 * Spec anchors: FR-040, FR-053, FR-060, FR-061, FR-062, FR-063, FR-080,
 *               FR-081, FR-092, SI-001, Constitution §III, §IV.
 */
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { Auditable } from "../../audit/auditable.decorator";
import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  toReviewQueueItem,
  type ReviewQueueItem,
} from "../unknown-items/dto/review-queue-item.dto";
import {
  CreateProductFromUnknownItemRequestSchema,
  type CreateProductFromUnknownItemRequestDto,
} from "./dto/create-product-request.dto";
import { ReconciliationService } from "./reconciliation.service";

// ---------------------------------------------------------------------------
// 007 US7 — Reopen request DTO + Zod schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for `tenantAdminReopenUnknownItem` request body.
 * Mirrors OpenAPI `ReopenUnknownItemRequest`: empty object, no properties,
 * `additionalProperties: false`. Tenant / store / authority are resolved from
 * the authenticated principal (Constitution §III) — no body-supplied scope is
 * honoured. `.strict()` rejects any smuggled field with 400 validation_error.
 *
 * The contract sets `requestBody.required: false`, so an OMITTED body is valid.
 * A missing body arrives at the pipe as `undefined`/`null` (no parsed JSON), so
 * `z.preprocess` coerces nullish → `{}` BEFORE the strict-object check —
 * otherwise `z.object({}).strict().parse(undefined)` would 400 a legitimately
 * empty request (CodeRabbit #408 F4: the optional-body contract must hold for an
 * omitted body, not only for an explicit `{}`).
 */
const ReopenUnknownItemRequestSchema = z.preprocess(
  (val) => (val == null ? {} : val),
  z.object({}).strict(),
);

// ---------------------------------------------------------------------------
// Request DTO + Zod schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for `tenantAdminLinkUnknownItem` request body.
 * Mirrors OpenAPI `LinkUnknownItemRequest`:
 *   required: [product_id]
 *   additionalProperties: false
 */
const LinkUnknownItemRequestSchema = z
  .object({
    product_id: z.string().uuid(),
  })
  .strict();

type LinkUnknownItemRequestDto = z.infer<typeof LinkUnknownItemRequestSchema>;

// The CreateProductFromUnknownItemRequest schema lives in
// ./dto/create-product-request.dto.ts (T636) so the request contract has a
// single named home. Imported above.

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------
//
// 007 (T038): link + create-product responses project to `ReviewQueueItem`
// (shipped `UnknownItem` MINUS `sale_context`) via the shared
// `toReviewQueueItem` helper (R7.2) — the same home unknown-items.controller
// imports — per FR-007 / T002 (TIGHTEN). The former local
// `UnknownItemWireShape` + `rowToWireShape` (which echoed `sale_context`) are
// removed. FR-001a product-reference suppression uses the 007 canSeeProduct
// rule: a tenant-wide actor (ctx.storeId === null) sees `resolved_product_id`;
// a store-scoped actor has it omitted.

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class ReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  /**
   * POST /api/v1/catalog/unknown-items/:id/link
   *
   * Links a pending unknown item to an existing, active tenant product.
   * On success: 200 OK + resolved UnknownItem shape.
   * On error:
   *   400 validation_error  — malformed :id or invalid body
   *   401 Unauthorized      — missing resolved context
   *   404 Not Found         — unknown item or product not found (SI-001:
   *                           non-disclosing, does not distinguish the two)
   *   409 alias_conflict    — product_aliases unique index violated (FR-040)
   *   409 already_reconciled — item already resolved or dismissed (FR-004)
   *   409 target_unavailable — target product is retired (FR-051)
   */
  @Post("api/v1/catalog/unknown-items/:id/link")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  // Per spec.md US2 #5 + tasks.md T622: tenant-admin OR store-manager
  // (scoped to the item's store via RLS) can link. The store_manager role
  // is intentional — store-scoped operators reconcile within their store.
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("unknown_item.resolved.linked")
  async tenantAdminLinkUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(LinkUnknownItemRequestSchema))
    body: LinkUnknownItemRequestDto,
  ): Promise<ReviewQueueItem> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.reconciliationService.linkUnknownItem({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      unknownItemId: id,
      productId: body.product_id,
      actorUserId: ctx.userId,
    });

    if (result.kind === "ok") {
      // FR-001a suppression is a browse-surface rule (list/inspect — items may
      // reference products the caller can't see). This is an ACTION response:
      // the caller named `product_id` in the request and just linked it, so
      // they can always see it → canSeeProduct = true. (storeId is NOT a
      // role proxy: a tenant-wide admin may act with a store context set.)
      return toReviewQueueItem(result.row, true);
    }

    if (result.kind === "alias_conflict") {
      throw new ConflictException({
        code: "alias_conflict",
        message:
          "A product alias with this identifier already exists for the target product. " +
          "Linking would violate the unique alias constraint (FR-040).",
      });
    }

    if (result.kind === "already_reconciled") {
      throw new ConflictException({
        code: "already_reconciled",
        message:
          "The unknown item is already resolved or dismissed; lifecycle transitions are monotonic per FR-004.",
      });
    }

    if (result.kind === "target_unavailable") {
      throw new ConflictException({
        code: "target_unavailable",
        message:
          "The target product is retired and cannot accept new alias links (FR-051).",
      });
    }

    // SI-001 / FR-092: non-disclosing 404 — does not reveal whether the
    // unknown item was absent or the product was absent. Retired products
    // are handled by the `target_unavailable` branch above (409); this
    // fallthrough represents truly absent items (RLS-filtered cross-tenant
    // or fabricated UUID).
    throw new NotFoundException("Not Found");
  }

  /**
   * POST /api/v1/catalog/unknown-items/:id/create-product
   *
   * Creates a brand-new tenant product directly from a pending unknown
   * item. Server-resolved tenant_id (Constitution §III); body-supplied
   * tenantId is rejected with 400 validation_error by the `.strict()`
   * Zod schema.
   *
   * On success: 201 Created + updated UnknownItem shape (resolution_status
   *   = 'resolved', resolution_action = 'created', resolved_product_id
   *   pointing at the new tenant_products row).
   * On error:
   *   400 validation_error     — malformed :id, missing name / tax_category,
   *                              or body smuggling an additional property
   *   401 Unauthorized         — missing resolved context
   *   404 Not Found            — unknown item absent (non-disclosing per
   *                              SI-001 / FR-092)
   *   409 alias_conflict       — product_aliases unique index violated
   *                              (FR-062); the would-be new product is
   *                              NOT created (transaction rollback)
   *   409 already_reconciled   — item already resolved/dismissed (FR-004)
   */
  @Post("api/v1/catalog/unknown-items/:id/create-product")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("unknown_item.resolved.created")
  async tenantAdminCreateProductFromUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(CreateProductFromUnknownItemRequestSchema))
    body: CreateProductFromUnknownItemRequestDto,
  ): Promise<ReviewQueueItem> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.reconciliationService.createProductFromUnknownItem({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      unknownItemId: id,
      actorUserId: ctx.userId,
      // The Zod schema already trims; the .min(1) check guarantees the
      // trimmed string is non-empty.
      name: body.name.trim(),
      taxCategory: body.tax_category.trim(),
      categoryId: body.category_id ?? null,
    });

    if (result.kind === "ok") {
      // ACTION response: the caller just CREATED this product, so it is always
      // visible to them → canSeeProduct = true. FR-001a suppression applies to
      // the browse surface (list/inspect), not to the response of an operation
      // the caller just performed.
      return toReviewQueueItem(result.row, true);
    }

    if (result.kind === "alias_conflict") {
      throw new ConflictException({
        code: "alias_conflict",
        message:
          "A product alias with this identifier already exists for a different product. " +
          "Creating would violate the unique alias constraint (FR-062).",
      });
    }

    if (result.kind === "already_reconciled") {
      throw new ConflictException({
        code: "already_reconciled",
        message:
          "The unknown item is already resolved or dismissed; lifecycle transitions are monotonic per FR-004.",
      });
    }

    // SI-001 / FR-092: non-disclosing 404 — RLS-filtered cross-tenant
    // or fabricated UUID.
    throw new NotFoundException("Not Found");
  }

  /**
   * POST /api/v1/catalog/unknown-items/:id/reopen (007 US7 / T054).
   *
   * operationId: tenantAdminReopenUnknownItem
   *
   * Reopen a `dismissed` unknown item by creating a fresh `pending` row for
   * the same logical identifier (005 FR-005); the original `dismissed` row is
   * preserved. Tenant-wide actors only.
   *
   * Authority (R7.1 / R7.4): the class-level
   * `@UseGuards(DashboardAuthGuard, TenantContextGuard)` authenticates; this
   * route adds `@UseGuards(RolesGuard)` + `@Roles("owner","tenant_admin",
   * "store_manager", { denyAs: 404 })`. The store_manager role is in the set
   * INTENTIONALLY so a store-scoped operator REACHES the service — the
   * 403-forbidden-vs-404-not-found split is decided in
   * `reopenUnknownItem(... isTenantWide ...)`, NOT at the guard. Using
   * `@Roles("owner","tenant_admin")` here would wrongly 404 an in-scope
   * store_manager (the R7.4 trap).
   *
   * `isTenantWide` is derived from `ctx.storeId === null` — `ResolvedContext`
   * carries no role field, and a store context (even for a tenant_admin) means
   * the actor is operating store-scoped (the same store-context rule the
   * wave-1 canSeeProduct policy uses).
   *
   * Idempotency (FR-063, T003 ISOLATE — only new ops carry the key):
   * `@Idempotent("required")` engages the shared `IdempotencyInterceptor` —
   * `Idempotency-Key` header, per-principal scoping, replay short-circuit, and
   * the `idempotency_key_conflict` 409 on a body mismatch. (Header is
   * `Idempotency-Key`, code `idempotency_key_conflict` — never
   * `Idempotency-Token`, T564 trap.)
   *
   * Audit (R7.5): emitted PROGRAMMATICALLY by the service (both the reopen
   * action AND the fresh capture on success; a single reopen_rejected on
   * 403/409; nothing on a non-disclosing 404). NO static `@Auditable` here —
   * the one-shot decorator can only emit one subject.
   *
   * Status: 201 Created on a fresh-pending reopen; 200 OK when an existing
   * pending sibling is returned (no new row). `@Res({ passthrough: true })`
   * sets the status programmatically while the interceptors still see the body.
   */
  @Post("api/v1/catalog/unknown-items/:id/reopen")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager", { denyAs: 404 })
  @Idempotent("required")
  async tenantAdminReopenUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(ReopenUnknownItemRequestSchema))
    _body: Record<string, never>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReviewQueueItem> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.reconciliationService.reopenUnknownItem({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      unknownItemId: id,
      actorUserId: ctx.userId,
      // R7.4: tenant-wide authority is signalled by the ABSENCE of a store
      // context (ResolvedContext has no role field). A store-scoped actor
      // (storeId set) is NOT tenant-wide → the service returns `forbidden`.
      isTenantWide: ctx.storeId === null,
      // correlation_id is NOT NULL on unknown_items; reopen has no POS
      // correlation, so derive from the request id (mirrors captureItem).
      correlationId:
        (request as { requestId?: string }).requestId ?? randomUUID(),
    });

    if (result.kind === "ok") {
      // CodeRabbit #408 F3: honour the documented two-status contract.
      // createdFresh → a new pending row was INSERTed → 201 Created (005 FR-005).
      // !createdFresh → an existing pending row was reused (target already
      // pending, or a pending sibling) → 200 OK, no-op (no row created). This
      // matches the wire contract and keeps the status truthful.
      res.status(result.createdFresh ? HttpStatus.CREATED : HttpStatus.OK);
      // ACTION response: the caller just reopened/holds this item in their
      // tenant-wide scope (isTenantWide is true to reach here) → canSeeProduct
      // = true, uniform with link/create/dismiss. A pending row has
      // resolved_product_id = NULL anyway.
      return toReviewQueueItem(result.row, true);
    }

    if (result.kind === "forbidden") {
      // FR-042 / 007 `forbidden` 8th category: in-scope but lacks tenant-wide
      // authority. 403 (NOT 404) — the item exists in the caller's scope.
      throw new ForbiddenException({
        code: "forbidden",
        message:
          "Reopening a dismissed item requires tenant-wide authority (FR-042).",
      });
    }

    if (result.kind === "already_reconciled") {
      // FR-043: the item is already `resolved`. 409 with prior_state detail so
      // the client can render why the reopen was refused.
      throw new ConflictException({
        code: "already_reconciled",
        message:
          "The unknown item is already resolved; it cannot be reopened (FR-043).",
        details: { prior_state: result.priorState },
      });
    }

    // result.kind === "not_found" → SI-004 / FR-062 non-disclosing 404. RLS
    // filtered the row (cross-tenant / out-of-scope) or it does not exist.
    throw new NotFoundException("Not Found");
  }
}
