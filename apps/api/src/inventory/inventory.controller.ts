/**
 * InventoryController — 009-US1-ONHAND (T033).
 *
 * The first runtime routes of the Inventory domain — the two READ operations
 * from the contract (packages/contracts/openapi/inventory/inventory.yaml):
 *
 *   GET /api/inventory/v1/on-hand/{storeId}/{productId}   → getOnHand
 *   GET /api/inventory/v1/stores/{storeId}/movements      → listStockMovements
 *
 * Auth: class-level `@UseGuards(DashboardAuthGuard, TenantContextGuard)` — the
 * cookieAuth operator surface (plan §4.2), NOT a POS-device route. The guards
 * authenticate and publish the resolved tenant context as `request.context`.
 * Tenant resolves from context (never from path/body for write-authority);
 * `storeId` is the path-scoped SELECTION target, authorized object-level
 * against the principal's resolved store: a request for a store outside the
 * caller's scope is a non-disclosing 404 (FR-051, §II/§XII).
 *
 * Write path (009-US2-MANUAL, T044):
 *   POST /api/inventory/v1/stores/{storeId}/movements → createStockMovement
 * The store is the PATH parameter; tenant + actor resolve from `request.context`
 * server-side. The body is a STRICT Zod DTO (`.strict()`) — any `tenantId` /
 * `storeId` / `createdBy` / `receivedAt` / derived-balance key is rejected 400
 * (mass-assignment ban, FR-052/§XII). NO `@Auditable` decorator on the route:
 * the service writes the audit row in-transaction, and a route-level
 * `@Auditable` would persist a SECOND row for one action (the dual-audit trap
 * the catalog service warns about).
 *
 * Transfer / count operations are authored in 009-US5 / US6 — NOT here.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { DashboardAuthGuard } from '../auth/dashboard-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { resolveStoreScope } from '../context/store-scope';
import { TenantContextGuard } from '../context/tenant-context.guard';
import type { ResolvedContext, TenantContextRequest } from '../context/types';
import {
  InventoryService,
  type OnHandBody,
  type StockMovementBody,
  type StockMovementListBody,
  type StockTransferBody,
  type StockCountResultBody,
} from './inventory.service';

const UuidSchema = z.string().uuid();
const LimitSchema = z.coerce.number().int().min(1).max(200).optional();
const OptionalUuidSchema = z.string().uuid().optional();

/**
 * Strict create-movement command (contract `CreateStockMovementCommand`,
 * `additionalProperties: false`). `.strict()` rejects any unknown key — which
 * is how the mass-assignment ban (FR-052) is enforced at the boundary: a body
 * `tenantId` / `storeId` / `createdBy` / `receivedAt` / `negativeBalance` is an
 * unknown key here and 400s. `quantity` is a signed decimal string preserved
 * verbatim (no float coercion). Nullable provenance refs are accepted as
 * provenance only.
 */
// Bounded to the `numeric(19,4)` shape (≤15 integer + ≤4 fraction digits). An
// unbounded regex would let the DTO accept values that the `$5::numeric(19,4)`
// cast silently rounds to 0.0000 (defeating the non-zero / adjustment rules) or
// that overflow numeric(19,4) at insert (a 500 escaping the 400 boundary).
const DecimalQtySchema = z
  .string()
  .regex(
    /^-?\d{1,15}(\.\d{1,4})?$/,
    'quantity must be a signed numeric(19,4) decimal string (≤15 integer, ≤4 fraction digits)',
  );
const CreateStockMovementSchema = z
  .object({
    movementType: z.enum(['inbound', 'outbound', 'adjustment']),
    quantity: DecimalQtySchema,
    stockingUnit: z.string().min(1).max(32),
    tenantProductRef: z.string().uuid().nullable().optional(),
    reason: z.string().max(500).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    saleId: z.string().uuid().nullable().optional(),
    saleLineId: z.string().uuid().nullable().optional(),
    terminalEventRef: z.string().uuid().nullable().optional(),
  })
  .strict();
type CreateStockMovementDto = z.infer<typeof CreateStockMovementSchema>;

/**
 * Strict create-transfer command (contract `CreateStockTransferCommand`,
 * `additionalProperties: false`). `.strict()` enforces the mass-assignment ban
 * (FR-052): a body `tenantId` / `createdBy` is an unknown key → 400. Quantity is
 * a strictly POSITIVE numeric(19,4) magnitude — a zero / negative quantity is a
 * validation error (the `.refine` catches "0.0000", which the positive regex
 * alone would otherwise accept).
 */
const PositiveDecimalQtySchema = z
  .string()
  .regex(
    /^\d{1,15}(\.\d{1,4})?$/,
    'quantity must be an unsigned numeric(19,4) decimal string (≤15 integer, ≤4 fraction digits)',
  )
  .refine((s) => /[1-9]/.test(s), {
    message: 'transfer quantity must be strictly positive',
  });
const CreateStockTransferSchema = z
  .object({
    sourceStoreId: z.string().uuid(),
    destinationStoreId: z.string().uuid(),
    tenantProductRef: z.string().uuid(),
    quantity: PositiveDecimalQtySchema,
    stockingUnit: z.string().min(1).max(32),
    reason: z.string().max(500).optional(),
  })
  .strict();
type CreateStockTransferDto = z.infer<typeof CreateStockTransferSchema>;

/**
 * Strict record-count command (contract `RecordStockCountCommand`,
 * `additionalProperties: false`). The store is the PATH parameter — never a body
 * field (§XII); a body `storeId` is an unknown key → 400. `countedQuantity` is a
 * NON-NEGATIVE numeric(19,4) (the signed variance vs derived on-hand becomes the
 * correction movement).
 */
const NonNegativeDecimalQtySchema = z
  .string()
  .regex(
    /^\d{1,15}(\.\d{1,4})?$/,
    'countedQuantity must be an unsigned numeric(19,4) decimal string (≤15 integer, ≤4 fraction digits)',
  );
const RecordStockCountSchema = z
  .object({
    tenantProductRef: z.string().uuid(),
    countedQuantity: NonNegativeDecimalQtySchema,
    stockingUnit: z.string().min(1).max(32),
    countedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
type RecordStockCountDto = z.infer<typeof RecordStockCountSchema>;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * GET /api/inventory/v1/on-hand/{storeId}/{productId}
   *
   * The derived (compute-on-read) on-hand for a (store, product). Empty key ⇒
   * deterministic zero (FR-005); negative ⇒ negativeBalance=true (FR-024).
   */
  @Get('api/inventory/v1/on-hand/:storeId/:productId')
  async getOnHand(
    @Req() request: TenantContextRequest,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Param('productId', new ZodValidationPipe(UuidSchema)) productId: string,
  ): Promise<OnHandBody> {
    const ctx = this.requireContext(request);
    this.authorizeStore(ctx, storeId);
    return this.inventoryService.getOnHand({
      tenantId: ctx.tenantId as string,
      storeId,
      productId,
    });
  }

  /**
   * GET /api/inventory/v1/stores/{storeId}/movements
   *
   * Movements for a (store) in stable order (FR-004). `productId` set ⇒ that
   * product; omitted ⇒ ad-hoc (NULL-product) movements only (contract).
   */
  @Get('api/inventory/v1/stores/:storeId/movements')
  async listStockMovements(
    @Req() request: TenantContextRequest,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Query('productId', new ZodValidationPipe(OptionalUuidSchema))
    productId: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number | undefined,
  ): Promise<StockMovementListBody> {
    const ctx = this.requireContext(request);
    this.authorizeStore(ctx, storeId);
    return this.inventoryService.listStockMovements({
      tenantId: ctx.tenantId as string,
      storeId,
      productId: productId ?? null,
      limit,
    });
  }

  /**
   * POST /api/inventory/v1/stores/{storeId}/movements
   *
   * Append a manual movement (inbound / outbound / adjustment; write-off is a
   * reason-coded outbound). Tenant + actor come from the resolved context, the
   * store from the path — never the body (FR-052). A cross-unit movement is a
   * 400 (CrossUnitError, surfaced by the global filter). On-hand MAY go
   * negative (allow-and-flag, FR-024) — never rejected.
   */
  @Post('api/inventory/v1/stores/:storeId/movements')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent('required')
  async createStockMovement(
    @Req() request: TenantContextRequest,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Body(new ZodValidationPipe(CreateStockMovementSchema))
    body: CreateStockMovementDto,
  ): Promise<StockMovementBody> {
    const ctx = this.requireContext(request);
    this.authorizeStore(ctx, storeId);
    return this.inventoryService.createStockMovement({
      tenantId: ctx.tenantId as string,
      storeId,
      userId: ctx.userId as string,
      movementType: body.movementType,
      quantity: body.quantity,
      stockingUnit: body.stockingUnit,
      tenantProductRef: body.tenantProductRef ?? null,
      reason: body.reason ?? null,
      occurredAt: body.occurredAt ?? null,
      saleId: body.saleId ?? null,
      saleLineId: body.saleLineId ?? null,
      terminalEventRef: body.terminalEventRef ?? null,
    });
  }

  /**
   * POST /api/inventory/v1/transfers
   *
   * Create an intra-tenant transfer as LINKED movements (FR-020): a
   * `transfer_out` at the source + a `transfer_in` at the destination sharing a
   * transfer group (SC-004). The SOURCE store is authorized object-level against
   * the principal's scope (a source outside scope is a non-disclosing 404); the
   * DESTINATION is a target reference resolved server-side under tenant RLS — a
   * cross-tenant destination is a non-disclosing 404 (FR-051). Source ≠ dest and
   * quantity > 0 (else 400). A transfer-out driving source on-hand negative is
   * still recorded (allow-and-flag, FR-024). Idempotent via `Idempotency-Key`.
   */
  @Post('api/inventory/v1/transfers')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent('required')
  async createStockTransfer(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(CreateStockTransferSchema))
    body: CreateStockTransferDto,
  ): Promise<StockTransferBody> {
    const ctx = this.requireContext(request);
    // The source store is the operator's authorized scope (a store-scoped
    // principal may only transfer FROM its own store; a foreign source is a
    // non-disclosing 404). The destination must be inside the membership's
    // store access too (RT-61); the service still validates it under RLS.
    this.authorizeStore(ctx, body.sourceStoreId);
    this.authorizeDestinationStore(ctx, body.destinationStoreId);
    return this.inventoryService.createStockTransfer({
      tenantId: ctx.tenantId as string,
      userId: ctx.userId as string,
      sourceStoreId: body.sourceStoreId,
      destinationStoreId: body.destinationStoreId,
      tenantProductRef: body.tenantProductRef,
      quantity: body.quantity,
      stockingUnit: body.stockingUnit,
      reason: body.reason ?? null,
    });
  }

  /**
   * POST /api/inventory/v1/stores/{storeId}/counts
   *
   * Record a physical count at the path-scoped store; any variance from the
   * derived on-hand is appended as a `count_correction` movement (signed
   * variance) linked to the count — the history is NEVER rewritten (FR-021). The
   * store is the PATH parameter, authorized object-level against the principal's
   * scope; tenant + actor resolve from context. Idempotent via `Idempotency-Key`.
   */
  @Post('api/inventory/v1/stores/:storeId/counts')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent('required')
  async recordStockCount(
    @Req() request: TenantContextRequest,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Body(new ZodValidationPipe(RecordStockCountSchema))
    body: RecordStockCountDto,
  ): Promise<StockCountResultBody> {
    const ctx = this.requireContext(request);
    this.authorizeStore(ctx, storeId);
    return this.inventoryService.recordStockCount({
      tenantId: ctx.tenantId as string,
      storeId,
      userId: ctx.userId as string,
      tenantProductRef: body.tenantProductRef,
      countedQuantity: body.countedQuantity,
      stockingUnit: body.stockingUnit,
      countedAt: body.countedAt ?? null,
    });
  }

  /** Resolve + assert an authenticated, tenant-bound principal. */
  private requireContext(request: TenantContextRequest): ResolvedContext {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException('Unauthorized');
    }
    return ctx;
  }

  /**
   * Object-level store authorization (§XII / §II).
   *
   *  1. A store-scoped principal (`ctx.storeId` set) may only address its own
   *     store.
   *  2. A session's MEMBERSHIP store access decides the rest, via the shared
   *     `resolveStoreScope` rule (RT-131): 'all' → any store in the tenant,
   *     'specific' → exactly the granted stores. A null active store is never
   *     read as tenant-wide (#606).
   *
   * The store access comes from `ctx.storeAccess`, which TenantContextGuard
   * resolved inside its tenant context. This method must NOT re-query
   * `memberships` / `store_access` itself: on the plain domain pool, outside
   * `runWithTenantContext`, FORCE RLS either hides the rows (404) or, on a
   * reused connection whose `app.current_tenant` reset to '', fails the
   * policy cast with 22P02 (400) — for every session user, the owner
   * included (RT-61).
   *
   * There is no database backstop: the RLS policies on `stock_movements`
   * scope by `tenant_id` only, so store separation is enforced exclusively
   * here. A store outside the caller's scope is a NON-DISCLOSING 404
   * (FR-051) — never 403, which would leak existence.
   *
   * Non-session principals have no membership in this slice and are left to
   * RLS, which still scopes them to their tenant.
   */
  private authorizeStore(ctx: ResolvedContext, storeId: string): void {
    // 1. A store-bound principal may only address its own store.
    if (ctx.storeId !== null && ctx.storeId !== storeId) {
      throw new NotFoundException('Not Found');
    }
    if (ctx.source !== 'session') return;

    // 2. The membership's store access decides the rest.
    const scope = resolveStoreScope(ctx);
    if (scope.kind === 'stores' && !scope.storeIds.includes(storeId)) {
      throw new NotFoundException('Not Found');
    }
  }

  /**
   * A transfer's DESTINATION store must also be within the caller's
   * membership store access (RT-61 / RT-120). Unlike the source it is not
   * tied to the active store: a tenant-wide member with an active store may
   * transfer to any store in the tenant, a 'specific' member only to stores
   * it is granted.
   */
  private authorizeDestinationStore(ctx: ResolvedContext, storeId: string): void {
    if (ctx.source !== 'session') return;
    const access = ctx.storeAccess;
    if (access?.kind === 'all') return;
    if (access?.kind === 'specific' && access.storeIds.includes(storeId)) return;
    throw new NotFoundException('Not Found');
  }
}
