/**
 * UnknownItemsController — 005 Wave 1 / T512 (CAPTURE-HAPPY).
 *
 * Implements the `posCaptureItem` operationId defined in
 * `packages/contracts/openapi/catalog/unknown-items.yaml`:
 *   POST /api/pos/v1/catalog/unknown-items
 *
 * Wave 1 / CAPTURE-HAPPY scope: only the capture endpoint. The `list`
 * (T524) and `dismiss` (T541) operations live in separate downstream
 * slices and will be added to this controller then.
 *
 * Auth / context:
 *   This slice does NOT introduce a new auth guard. The
 *   `req.context: ResolvedContext` shape from 001 is consumed —
 *   integration tests stand up a configurable context guard, and
 *   subsequent slices (or a 002 wiring slice) will mount the real POS
 *   principal resolution onto this route. Per the slice brief, auth
 *   files under `apps/api/src/auth/` are forbidden surface for 005.
 *
 * Idempotency:
 *   `@Idempotent("required")` engages the existing global
 *   `IdempotencyInterceptor` (registered as `APP_INTERCEPTOR` in
 *   `IdempotencyModule`). The interceptor handles the header
 *   (`Idempotency-Key`), per-device scoping (FR-021a — via
 *   `clientId = req.context.userId`), 72h TTL (FR-021b), and
 *   payload-mismatch 409s (FR-021c). T505 (PR #306) proved the
 *   primitive's coverage; we do not re-author it here.
 *
 * Audit:
 *   `@Auditable("unknown_item.captured")` is passive metadata read
 *   by the global `AuditEmitterInterceptor` from `AuditModule`. The
 *   interceptor emits one audit-event per successful response.
 *
 *   Audit-subject branching (T514): the `AuditEmitterInterceptor` reads
 *   the metadata key from the route handler BEFORE invoking the handler
 *   (audit-emitter.interceptor.ts:75-83), so the decorator string is
 *   fixed per route at module-load time. Mutating the subject per branch
 *   would require either (a) injecting `AUDIT_JOB_ENQUEUER` into this
 *   controller and emitting programmatically — disallowed because the
 *   CAPTURE-HAPPY integration spec wires this controller without the
 *   audit module's providers, so adding a constructor dependency would
 *   regress the existing test — or (b) modifying `AuditEmitterInterceptor`
 *   itself, which is forbidden surface for 005. The safest choice is to
 *   keep ONE static subject for both outcomes: `unknown_item.captured`
 *   is semantically accurate for the POS capture *request* regardless
 *   of whether it resolved or fell through to a new pending row. A
 *   future audit-taxonomy refinement (e.g. T546) can split this if
 *   downstream needs require it. Deep audit-event assertion lives in T546.
 *
 * Validation:
 *   The Zod schema in `./dto/capture-request.dto.ts` is the boundary
 *   for FR-070 / FR-071. CAPTURE-HAPPY ships a minimal schema covering
 *   the happy-path fields; T520 (005-WAVE1-VALIDATION) tightens it.
 *
 * Status code (T514):
 *   - 200 OK for the `resolved` outcome (alias hit — no row created).
 *   - 201 Created for the `unknown` outcome (new pending row).
 *
 *   Status branching uses NestJS's `@Res({ passthrough: true })` pattern
 *   so the handler still returns a body (the global interceptors —
 *   logging, idempotency replay storage — keep working) while setting
 *   the status code programmatically. The route-level `@HttpCode`
 *   decorator is removed because it would override `res.status(...)`.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
import { PosOperatorAuthGuard } from "../../auth/pos-operator-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  PosCaptureItemRequestSchema,
  type PosCaptureItemRequestDto,
} from "./dto/capture-request.dto";
import {
  ListUnknownItemsQuerySchema,
  type ListUnknownItemsQueryDto,
} from "./dto/list-unknown-items.dto";
import {
  toReviewQueueItem,
  type ReviewQueueItem,
} from "./dto/review-queue-item.dto";
import {
  UnknownItemsService,
  type BulkDismissOutcome,
  type CapturedUnknownItemRow,
} from "./unknown-items.service";

/**
 * 007 US8 (T058): Zod schema for `tenantAdminBulkDismissUnknownItems` request
 * body. Mirrors OpenAPI `BulkDismissUnknownItemsRequest`:
 *   required: [ids]; ids: array<uuid>, minItems 1, maxItems 200, uniqueItems;
 *   additionalProperties: false.
 * The `maxItems(200)` bound is the FR-044 whole-batch ceiling — a 201-id batch
 * fails Zod validation → 400 (reject-whole, NOT clamp). `.strict()` rejects any
 * smuggled field (no body-supplied tenant/store — Constitution §III).
 */
const BulkDismissUnknownItemsRequestSchema = z
  .object({
    ids: z
      .array(z.string().uuid())
      .min(1)
      .max(200)
      // Canonicalize hex casing before the uniqueness check (CodeRabbit #409
      // F3): Postgres treats UUIDs case-insensitively, so two ids differing
      // only in casing are the same logical row — they must not both slip
      // through the whole-batch uniqueness guard.
      .refine(
        (arr) => new Set(arr.map((id) => id.toLowerCase())).size === arr.length,
        { message: "ids must be unique" },
      ),
  })
  .strict();

type BulkDismissUnknownItemsRequestDto = z.infer<
  typeof BulkDismissUnknownItemsRequestSchema
>;

/** 007 US8 wire shape of `BulkDismissUnknownItemsResponse` (data-model §2.3). */
interface BulkDismissUnknownItemsResponseBody {
  readonly outcomes: ReadonlyArray<BulkDismissOutcome>;
}

/**
 * 007 (T032): the dashboard list + dismiss responses project to
 * `ReviewQueueItem` (the shipped `UnknownItem` MINUS `sale_context`) via the
 * shared `toReviewQueueItem` helper (R7.2), per FR-007 / T002 (TIGHTEN). The
 * former local `UnknownItemWireShape` + `rowToUnknownItemWireShape` (which
 * echoed `sale_context`) are removed — the POS capture response keeps its own
 * `toUnknownWireShape` (R7.3), which is unaffected.
 */
interface ListUnknownItemsResponseBody {
  readonly items: ReadonlyArray<ReviewQueueItem>;
  readonly next_cursor: string | null;
}

/**
 * Wire shape of the contract's `PosCaptureUnknownResponse`. Adapts the
 * service's `CapturedUnknownItemRow` (camelCase) to the contract's
 * snake_case `UnknownItem`.
 */
interface PosCaptureUnknownResponseBody {
  readonly kind: "unknown";
  readonly unknown_item: {
    readonly id: string;
    readonly tenant_id: string;
    readonly store_id: string;
    readonly identifier_type: string;
    readonly identifier_value: string;
    readonly source_system: string | null;
    readonly resolution_status: "pending";
    readonly resolution_action: null;
    readonly resolved_at: null;
    readonly resolved_by: null;
    readonly resolved_product_id: null;
    readonly encountered_at: string;
    readonly sale_context: Record<string, unknown> | null;
  };
}

/**
 * Wire shape of the contract's `PosCaptureResolvedResponse`
 * (catalog/unknown-items.yaml#PosCaptureResolvedResponse) — discriminated
 * literal `kind: "resolved"`, required `product_id`, optional `alias_id`.
 */
interface PosCaptureResolvedResponseBody {
  readonly kind: "resolved";
  readonly product_id: string;
  readonly alias_id: string;
}

function toUnknownWireShape(
  row: CapturedUnknownItemRow,
): PosCaptureUnknownResponseBody {
  return {
    kind: "unknown",
    unknown_item: {
      id: row.id,
      tenant_id: row.tenantId,
      store_id: row.storeId,
      identifier_type: row.identifierType,
      identifier_value: row.identifierValue,
      source_system: row.sourceSystem,
      resolution_status: row.resolutionStatus,
      resolution_action: row.resolutionAction,
      resolved_at: row.resolvedAt,
      resolved_by: row.resolvedBy,
      resolved_product_id: row.resolvedProductId,
      encountered_at: row.encounteredAt.toISOString(),
      sale_context: row.saleContext,
    },
  };
}

function toResolvedWireShape(
  productId: string,
  aliasId: string,
): PosCaptureResolvedResponseBody {
  return {
    kind: "resolved",
    product_id: productId,
    alias_id: aliasId,
  };
}

/**
 * Controller class has no `@Controller(prefix)` argument — the URL
 * paths are placed on each method instead. Two route families live in
 * this controller and they have different prefixes:
 *
 *   - `posCaptureItem` is POS-facing → `/api/pos/v1/catalog/unknown-items`
 *     (CAPTURE-HAPPY, PR #317)
 *   - `tenantAdminListUnknownItems` is dashboard / tenant-admin facing
 *     → `/api/v1/catalog/unknown-items` (LIST, T524 — no `/pos/` prefix
 *     per the OpenAPI contract `packages/contracts/openapi/catalog/unknown-items.yaml`)
 *   - Future `tenantAdminDismissUnknownItem` lands at
 *     `/api/v1/catalog/unknown-items/{id}/dismiss` for the same reason
 *
 * The pre-LIST iteration used `@Controller("api/pos/v1/catalog/unknown-items")`
 * because capture was the only route. LIST forced the move to a
 * method-level path scheme — same served URLs, same supertest
 * assertions, just relocated decorators.
 */
@Controller()
export class UnknownItemsController {
  constructor(private readonly unknownItemsService: UnknownItemsService) {}

  /**
   * `posCaptureItem` — POS submits an item reference.
   *
   * CAPTURE-HAPPY behavior: every submission produces a new pending
   * row. Alias-resolution, store-scope, and natural-dedup are layered
   * in by downstream slices (CAPTURE-RESOLVE / CAPTURE-STORE-SCOPE /
   * CAPTURE-DEDUP).
   */
  @Post("api/pos/v1/catalog/unknown-items")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  @Idempotent("required")
  @Auditable("unknown_item.captured")
  // T533 / 005-WAVE1-IDEMP-MISMATCH catalog-domain telemetry — the
  // `idempotency_token_mismatch_total` counter (FR-021c) and the
  // `unknown_item.idempotency_mismatch_rejected` audit subject (FR-082)
  // fire inline inside `IdempotencyInterceptor.handle()`'s collision
  // branch (apps/api/src/idempotency/idempotency.interceptor.ts).
  // No route-level decorator is required: the platform interceptor
  // observes the collision and emits the catalog-axis side effects
  // at the same point it emits the platform-axis ones.
  //
  // Architectural history: this slice originally used
  // `@UseFilters(IdempotencyMismatchFilter)` (async exception filter,
  // broken in this codebase — see PR #386 evidence) and then
  // `@UseInterceptors(IdempotencyMismatchInterceptor)` (route-level
  // RxJS tap.error, which never fires because the collision is thrown
  // by an APP_INTERCEPTOR BEFORE next.handle() is invoked, so the
  // route-level interceptor's inner observable is never subscribed —
  // see PR #389 CI evidence). The inline approach is what works.
  async posCaptureItem(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(PosCaptureItemRequestSchema))
    body: PosCaptureItemRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PosCaptureResolvedResponseBody | PosCaptureUnknownResponseBody> {
    const ctx = request.context;
    if (!ctx) {
      // No resolved POS principal context. In production this is
      // unreachable when an auth guard is mounted; in tests the
      // configurable guard sets it. Mirrors `InvitationsController`.
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // FR-011: a POS principal MUST resolve a store binding. Returning
      // 400 here would be a deterministic outcome; the broader FR-070
      // / FR-071 validation taxonomy lands in T519/T520. For CAPTURE-HAPPY
      // we surface this as an Unauthorized — the test exercise always
      // sets a store, so this branch is defensive.
      throw new UnauthorizedException("store_context_required");
    }
    if (ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const result = await this.unknownItemsService.captureItem({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      // Use the request's correlation id when available; fall back to a
      // freshly-minted UUID — 003 requires `correlation_id NOT NULL`.
      correlationId:
        (request as { requestId?: string }).requestId ?? randomUUID(),
      identifierType: body.identifier_type,
      identifierValue: body.identifier_value,
      sourceSystem: body.source_system ?? null,
      saleContext: body.sale_context ?? null,
    });

    if (result.kind === "resolved") {
      // FR-022 / FR-030 / FR-031 — alias hit. 200 OK, no row created.
      res.status(HttpStatus.OK);
      return toResolvedWireShape(result.productId, result.aliasId);
    }

    // FR-001 — capture: a new pending row was inserted. 201 Created.
    res.status(HttpStatus.CREATED);
    return toUnknownWireShape(result.unknownItem);
  }

  /**
   * `tenantAdminListUnknownItems` — dashboard / tenant-admin queue read
   * (T524 / 005-WAVE1-LIST).
   *
   * GET /api/v1/catalog/unknown-items?status=&store_id=&cursor=&limit=
   *
   * RLS-driven visibility:
   *   - Tenant-wide actors (storeId=null) see all stores in their
   *     tenant; 003 0009 carve-out makes the `app.current_store=''`
   *     pass the `unknown_items_store_read` policy branch.
   *   - Store-scoped operators see only their bound store; the policy
   *     branch matches `store_id = app.current_store`.
   *   - Cross-tenant probes return an empty page (003
   *     `unknown_items_tenant_isolation` filters at the DB layer),
   *     NOT an authorization error — non-disclosing per SI-001 /
   *     FR-013.
   *
   * Pagination: Wave 1 single-pages within `limit` (default 50, max
   * 200 per the contract). `cursor` is accepted at the boundary so
   * `.strict()` doesn't reject it, but ignored internally — the
   * response always carries `next_cursor: null`. See `listForTenant`
   * comment for the forward-compat plan.
   *
   * Audit / idempotency:
   *   - No `@Auditable` decorator: list reads are not state
   *     transitions (FR-080 scopes audits to transitions).
   *   - No `@Idempotent` decorator: GETs are naturally idempotent
   *     and the interceptor expects a header on writes only.
   *
   * Auth / RolesGuard (documented intentional gap):
   *   This handler does NOT carry `@UseGuards(AuthGuard,
   *   TenantContextGuard, RolesGuard)` or `@Roles(...)` decorators.
   *   It inherits the same posture as `posCaptureItem` above —
   *   the route is consumed by integration tests via a
   *   configurable context guard, and production wiring of the
   *   real auth+roles stack lands in a future Wave 1 slice. Auth
   *   files (`apps/api/src/auth/**`) are forbidden surface for
   *   005 per the slice contract, so adding decorators here
   *   would silently expand scope. Flagged by CodeRabbit on
   *   PR #334; tracked as a follow-up auth-wiring slice that
   *   addresses both `posCaptureItem` and
   *   `tenantAdminListUnknownItems` consistently.
   */
  @Get("api/v1/catalog/unknown-items")
  @UseGuards(DashboardAuthGuard, TenantContextGuard)
  async tenantAdminListUnknownItems(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListUnknownItemsQuerySchema))
    query: ListUnknownItemsQueryDto,
  ): Promise<ListUnknownItemsResponseBody> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    // No `store_context_required` check here — list supports both
    // tenant-wide actors (ctx.storeId === null) and store-scoped
    // actors (ctx.storeId === UUID). The service's
    // `app.current_store` GUC drives the RLS branch accordingly.

    const result = await this.unknownItemsService.listForTenant({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      status: query.status,
      limit: query.limit,
      storeIdFilter: query.store_id ?? null,
      // 007 US2 (FR-002/003/004): scope-safe filter / sort / grouping.
      sourceSystem: query.source_system ?? null,
      sort: query.sort,
      groupBy: query.group_by ?? null,
    });

    // FR-001a (007 canSeeProduct policy): a tenant-wide actor
    // (ctx.storeId === null) may see the linked/created product reference; a
    // store-scoped actor gets `resolved_product_id` omitted (SC-007 — no
    // cross-store product leak), while the item row is still returned.
    const canSeeProduct = ctx.storeId === null;
    return {
      items: result.items.map((row) => toReviewQueueItem(row, canSeeProduct)),
      next_cursor: result.nextCursor,
    };
  }

  /**
   * `tenantAdminInspectUnknownItem` — inspect a single item (007 US3 / T042).
   *
   * GET /api/v1/catalog/unknown-items/:id
   *
   * Returns the addressed row as a `ReviewQueueItem` (no `sale_context`,
   * FR-007; no candidate-match hint, FR-070). RLS-scoped via the existing
   * `findByIdForTenant` single-row read: a cross-tenant or out-of-scope id
   * yields zero rows → non-disclosing 404 (SI-004 / FR-062). This is a
   * BROWSE surface, so FR-001a product-reference suppression applies — a
   * tenant-wide actor (ctx.storeId === null) sees `resolved_product_id`; a
   * store-scoped actor has it omitted (the item row is still returned).
   *
   * Auth posture mirrors the list route (FR-009 "inherits the document-level
   * cookieAuth"): `DashboardAuthGuard + TenantContextGuard`, no `RolesGuard` —
   * inspect is a read, and scope is enforced by RLS (a wrong-scope id is
   * non-disclosing 404, never a role-based 403). The contract's documented 403
   * exists for the shared `forbidden` category (used by reopen), not inspect.
   *
   * No `@Auditable` (a read is not a state transition; matches list/FR-080
   * scope) and no `@Idempotent` (no Idempotency-Key on a GET).
   */
  @Get("api/v1/catalog/unknown-items/:id")
  @UseGuards(DashboardAuthGuard, TenantContextGuard)
  async tenantAdminInspectUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid()))
    id: string,
  ): Promise<ReviewQueueItem> {
    const ctx = request.context;
    if (!ctx) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const row = await this.unknownItemsService.findByIdForTenant({
      id,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
    });

    // Browse surface → FR-001a suppression applies (unlike the action responses
    // for link/create/dismiss which always show the product they acted on).
    return toReviewQueueItem(row, ctx.storeId === null);
  }

  /**
   * `tenantAdminDismissUnknownItem` — dashboard / tenant-admin
   * dismiss action (T541 / 005-WAVE1-DISMISS).
   *
   * POST /api/v1/catalog/unknown-items/:id/dismiss
   *
   * Transitions the addressed `unknown_items` row from `pending` to
   * `dismissed` per FR-003 / FR-004. The service-layer
   * `dismissUnknownItem` enforces the monotonicity guard at the
   * UPDATE's WHERE clause + distinguishes 404 (non-disclosing)
   * from 409 (`already_reconciled`) via a conditional SELECT on
   * rowCount=0.
   *
   * Path-param validation:
   *   The `:id` segment is Zod-validated as a UUID at the controller
   *   boundary. A malformed id rejects as 400 (validation_error)
   *   before reaching the service. Matches the contract's
   *   `format: uuid` requirement.
   *
   * Audit / idempotency:
   *   - `@Auditable("unknown_item.dismissed")` fires on success only
   *     (the AuditEmitterInterceptor only emits after handler
   *     completion). The 404/409 paths throw before the interceptor
   *     can fire; rejected-dismiss audit emission is deferred to a
   *     future enhancement (tasks.md T543's `rejected=true`
   *     discriminator would need a filter pattern similar to
   *     PR #339's IDEMP-MISMATCH).
   *   - No `@Idempotent('required')` decorator: dismiss is naturally
   *     idempotent at the DB layer via the monotonicity guard.
   *     Re-dismissing returns deterministic 409 from the lifecycle
   *     invariant — no client-side dedup key needed.
   *
   * Auth gap (carried forward from CAPTURE-HAPPY / NON-DISCLOSING /
   * LIST / IDEMP-WIRE / IDEMP-MISMATCH): no `@UseGuards(AuthGuard,
   * TenantContextGuard, RolesGuard)`. Same documented intentional gap;
   * `apps/api/src/auth/**` remains forbidden surface for 005.
   * Tracked in wave-status.md "Outstanding known gap" section.
   */
  @Post("api/v1/catalog/unknown-items/:id/dismiss")
  // NestJS's `@Post()` defaults to 201 Created. The OpenAPI contract
  // for `tenantAdminDismissUnknownItem` specifies 200 OK for the
  // successful dismiss outcome (lines 299-308 of unknown-items.yaml).
  // Unlike `posCaptureItem` which branches on outcome (200 for
  // resolved alias, 201 for new pending row) and uses `@Res(...)`
  // for runtime status branching, dismiss has exactly one success
  // code — static `@HttpCode(HttpStatus.OK)` is the right shape.
  // CodeRabbit Critical catch on PR #341.
  @HttpCode(HttpStatus.OK)
  @UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
  // Per tasks.md T540 + spec.md US2 #3: tenant-admin OR store-manager (scoped
  // to the item's store via RLS) can dismiss. The store_manager role is
  // intentional — store-scoped operators reconcile within their store.
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("unknown_item.dismissed")
  async tenantAdminDismissUnknownItem(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid()))
    id: string,
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

    const row = await this.unknownItemsService.dismissUnknownItem({
      id,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
    });

    // ACTION response (the caller just dismissed this item) → canSeeProduct =
    // true, uniform with link/create-product. Functionally moot — a dismissed
    // row has resolved_product_id = NULL by the schema CHK — but keeping the
    // "action responses never suppress; only list/inspect do" rule uniform
    // avoids a future reader mistaking dismiss suppression as intentional.
    return toReviewQueueItem(row, true);
  }

  /**
   * `tenantAdminBulkDismissUnknownItems` — dismiss a bounded selection
   * (007 US8 / T058).
   *
   * POST /api/v1/catalog/unknown-items/bulk-dismiss
   *
   * Dismiss up to 200 unknown items in one request. The ≤200 ceiling is the
   * FR-044 whole-batch reject: a 201-id batch fails the Zod
   * `maxItems(200)` boundary → 400 validation, NOTHING dismissed (reject, NOT
   * clamp — SC-008). Within a valid batch each id is decomposed by the service
   * into the SHIPPED per-item dismiss path (006 FR-070a — no new lifecycle
   * write); the response carries one outcome per id.
   *
   * Path note: `bulk-dismiss` is a literal segment with no trailing sub-path,
   * so it does NOT collide with the `:id/dismiss` / `:id/reopen` parameterised
   * routes (those require a trailing action segment).
   *
   * Authority: class-level `@UseGuards(DashboardAuthGuard, TenantContextGuard)`
   * authenticates; this route adds `@UseGuards(RolesGuard)` +
   * `@Roles("owner","tenant_admin","store_manager", { denyAs: 403 })`. Same
   * role set as the shipped single dismiss (store_manager dismisses within
   * their store via RLS). `denyAs: 403` (not 404) per the contract — the batch
   * is acted on within the caller's resolved tenant, so a role failure is a
   * `forbidden`, not a non-disclosing not-found (per-item not-found is surfaced
   * inside the 200 outcome list, never as the batch status).
   *
   * Idempotency (FR-063, T003 ISOLATE): `@Idempotent("required")` →
   * `Idempotency-Key`; the WHOLE batch response is replayed on a same-key
   * same-body retry, and a body mismatch is `idempotency_key_conflict` (409).
   *
   * No `@Auditable`: per-item dismiss audits are emitted by the shipped
   * `dismissUnknownItem` path's own `@Auditable` on the single route — but
   * here we call the SERVICE method directly (not via the decorated route), so
   * the dismiss audit is emitted by the service's metric/audit pathway per
   * item. (The single-dismiss audit subject is `unknown_item.dismissed`; the
   * service increments it on each successful per-item transition.)
   */
  @Post("api/v1/catalog/unknown-items/bulk-dismiss")
  @HttpCode(HttpStatus.OK)
  @UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager", { denyAs: 403 })
  @Idempotent("required")
  async tenantAdminBulkDismissUnknownItems(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(BulkDismissUnknownItemsRequestSchema))
    body: BulkDismissUnknownItemsRequestDto,
  ): Promise<BulkDismissUnknownItemsResponseBody> {
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

    const result = await this.unknownItemsService.bulkDismissUnknownItems({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      ids: body.ids,
      // Thread the request correlation id into every per-item dismiss audit so
      // the whole batch's events are linkable to the one request (T070 /
      // SC-004 / FR-064). Mirrors the reopen route; falls back to a minted
      // UUID when no RequestIdInterceptor populated request.requestId
      // (unknown_items audit request_id is nullable, but a present id is
      // strictly better for traceability than null).
      correlationId:
        (request as { requestId?: string }).requestId ?? randomUUID(),
    });

    return { outcomes: result.outcomes };
  }
}
