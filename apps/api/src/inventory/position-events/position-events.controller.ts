/**
 * InventoryPositionEventsController — Jira RT-435 (RT-290 Gate 4; owner
 * decisions D1–D4, RT-435 comment 12993).
 *
 *   POST /api/inventory/v1/stores/{storeId}/status-moves  → createStatusMove
 *   POST /api/inventory/v1/stores/{storeId}/relocations   → createRelocation
 *   GET  /api/inventory/v1/settings/return-landing        → getReturnLandingPolicy
 *   PUT  /api/inventory/v1/settings/return-landing        → setReturnLandingPolicy
 *
 * Auth (960, 961; D2): the cookieAuth operator surface. `RolesGuard` admits
 * owner, tenant_admin and store_manager to the moves and the policy read
 * (denyAs 403: the active tenant is the caller's own, so nothing is
 * disclosed); the policy write is owner / tenant_admin. The path store is
 * authorized object-level exactly as the other store-scoped inventory routes
 * (`authorizeInventoryStore`): a store_manager moves stock only in its store
 * scope, and a store outside it is a non-disclosing 404. A status move OUT of
 * a sensitive status is limited further to owner / tenant_admin by the
 * service, which knows the role.
 *
 * Bodies are strict Zod DTOs: tenant, store, actor and tracking fields are
 * never accepted from the body (FR-052; tracking arrives with RT-451). The
 * moves are `@Idempotent('required')`; the service also records a fingerprint
 * of the key, so a replay never writes a second effect. Audit rows are written
 * by the service in the write's transaction (no `@Auditable`).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { INVENTORY_REASON_CODES, INVENTORY_STATUSES, RETURN_LANDING_STATUSES } from '@data-pulse-2/db';
import { z } from 'zod';

import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import type { ResolvedContext, TenantContextRequest } from '../../context/types';
import { Idempotent } from '../../idempotency/idempotent.decorator';
import { authorizeInventoryStore } from '../inventory.controller';
import {
  InventoryPositionEventsService,
  type InventoryPositionEventBody,
  type PositionCommandActor,
  type ReturnLandingPolicyBody,
} from './position-events.service';

const UuidSchema = z.string().uuid();

/** A strictly positive numeric(19,4) magnitude (contract `PositiveDecimalQuantity`). */
const PositiveDecimalQtySchema = z
  .string()
  .regex(
    /^\d{1,15}(\.\d{1,4})?$/,
    'quantity must be an unsigned numeric(19,4) decimal string (≤15 integer, ≤4 fraction digits)',
  )
  .refine((s) => /[1-9]/.test(s), { message: 'quantity must be strictly positive' });

const NoteSchema = z.string().max(500).optional();

/** Contract `CreateStatusMoveCommand` (`additionalProperties: false`). */
const CreateStatusMoveSchema = z
  .object({
    tenantProductRef: z.string().uuid(),
    quantity: PositiveDecimalQtySchema,
    stockingUnit: z.string().min(1).max(32),
    stockLocationId: z.string().uuid().optional(),
    fromStatus: z.enum(INVENTORY_STATUSES),
    toStatus: z.enum(INVENTORY_STATUSES),
    reasonCode: z.enum(INVENTORY_REASON_CODES),
    note: NoteSchema,
  })
  .strict();
type CreateStatusMoveDto = z.infer<typeof CreateStatusMoveSchema>;

/** Contract `CreateRelocationCommand` (`additionalProperties: false`). */
const CreateRelocationSchema = z
  .object({
    tenantProductRef: z.string().uuid(),
    quantity: PositiveDecimalQtySchema,
    stockingUnit: z.string().min(1).max(32),
    fromLocationId: z.string().uuid(),
    toLocationId: z.string().uuid(),
    inventoryStatus: z.enum(INVENTORY_STATUSES).optional(),
    reasonCode: z.enum(INVENTORY_REASON_CODES).optional(),
    note: NoteSchema,
  })
  .strict();
type CreateRelocationDto = z.infer<typeof CreateRelocationSchema>;

/** Contract `SetReturnLandingPolicyCommand` (`additionalProperties: false`). */
const SetReturnLandingSchema = z
  .object({ returnLandingStatus: z.enum(RETURN_LANDING_STATUSES) })
  .strict();
type SetReturnLandingDto = z.infer<typeof SetReturnLandingSchema>;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class InventoryPositionEventsController {
  constructor(private readonly service: InventoryPositionEventsService) {}

  /** Move stock between two statuses at one location (G4-2, 842–844). */
  @Post('api/inventory/v1/stores/:storeId/status-moves')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  @Idempotent('required')
  async createStatusMove(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Body(new ZodValidationPipe(CreateStatusMoveSchema)) body: CreateStatusMoveDto,
  ): Promise<InventoryPositionEventBody> {
    const actor = this.actor(request, idempotencyKey);
    authorizeInventoryStore(this.context(request), storeId);
    return this.service.createStatusMove({
      ...actor,
      storeId,
      tenantProductRef: body.tenantProductRef,
      quantity: body.quantity,
      stockingUnit: body.stockingUnit,
      stockLocationId: body.stockLocationId ?? null,
      fromStatus: body.fromStatus,
      toStatus: body.toStatus,
      reasonCode: body.reasonCode,
      note: body.note ?? null,
    });
  }

  /** Move stock between two locations of one store, same status (800). */
  @Post('api/inventory/v1/stores/:storeId/relocations')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  @Idempotent('required')
  async createRelocation(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('storeId', new ZodValidationPipe(UuidSchema)) storeId: string,
    @Body(new ZodValidationPipe(CreateRelocationSchema)) body: CreateRelocationDto,
  ): Promise<InventoryPositionEventBody> {
    const actor = this.actor(request, idempotencyKey);
    authorizeInventoryStore(this.context(request), storeId);
    return this.service.createRelocation({
      ...actor,
      storeId,
      tenantProductRef: body.tenantProductRef,
      quantity: body.quantity,
      stockingUnit: body.stockingUnit,
      fromLocationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      inventoryStatus: body.inventoryStatus ?? null,
      reasonCode: body.reasonCode ?? null,
      note: body.note ?? null,
    });
  }

  /** The tenant's return landing policy (Q6). */
  @Get('api/inventory/v1/settings/return-landing')
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  async getReturnLandingPolicy(@Req() request: TenantContextRequest): Promise<ReturnLandingPolicyBody> {
    const ctx = this.context(request);
    return this.service.getReturnLandingPolicy(ctx.tenantId as string);
  }

  /** Set the tenant's return landing policy (Q6, 849). */
  @Put('api/inventory/v1/settings/return-landing')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async setReturnLandingPolicy(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(SetReturnLandingSchema)) body: SetReturnLandingDto,
  ): Promise<ReturnLandingPolicyBody> {
    const ctx = this.context(request);
    return this.service.setReturnLandingPolicy({
      tenantId: ctx.tenantId as string,
      userId: ctx.userId as string,
      returnLandingStatus: body.returnLandingStatus,
    });
  }

  /** An authenticated, tenant-bound principal. */
  private context(request: TenantContextRequest): ResolvedContext {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException('Unauthorized');
    if (ctx.tenantId === null) throw new UnauthorizedException('Unauthorized');
    if (ctx.userId === null) throw new UnauthorizedException('Unauthorized');
    return ctx;
  }

  private actor(request: TenantContextRequest, idempotencyKey: string | undefined): PositionCommandActor {
    const ctx = this.context(request);
    // `@Idempotent('required')` rejects a request without the header first.
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    return {
      tenantId: ctx.tenantId as string,
      userId: ctx.userId as string,
      isPlatformAdmin: ctx.isPlatformAdmin,
      idempotencyKey,
    };
  }
}
