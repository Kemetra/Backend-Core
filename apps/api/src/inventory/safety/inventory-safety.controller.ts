/**
 * InventorySafetyController — Jira RT-449 PR 1 (RT-50 Gate 7 G7-2 / G7-6 /
 * G7-7; owner rulings H1–H8, RT-449 comment 13434).
 *
 *   POST /api/inventory/v1/tracking-holds                    → placeQualityHold
 *   GET  /api/inventory/v1/tracking-holds/{holdId}           → getTrackingHold
 *   POST /api/inventory/v1/tracking-holds/{holdId}/release   → releaseTrackingHold
 *   POST /api/inventory/v1/recalls                           → createInventoryRecall
 *   GET  /api/inventory/v1/recalls/{recallId}                → getInventoryRecall
 *   POST /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections
 *                                                            → correctTrackingIdentityExpiry
 *
 * Auth (H1, H2; decision 965): the cookieAuth operator surface. These are
 * TENANT-level operations — a hold reaches the identity at every location of
 * every store — so no store scope can admit a caller: `RolesGuard` admits
 * owner and tenant_admin to the placements, the recall, the expiry
 * correction and the reads, and only the owner to a release (higher
 * sensitivity than placement). A store_manager is a 403 (denyAs 403: the
 * active tenant is the caller's own, so nothing is disclosed). As on every
 * `@Roles` route, a platform-admin session passes `RolesGuard` (RT-132 D6,
 * RT-414 support sessions).
 *
 * Bodies are strict Zod DTOs: tenant, store and actor are never accepted from
 * the body (FR-052). Placement, recall and expiry correction are
 * `@Idempotent('required')`; the services also record a fingerprint of the
 * key, so a replay never writes twice. A release needs no key: a released
 * hold is final and a second release writes nothing. Audit rows are written
 * by the services in the command's transaction (no `@Auditable`).
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
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SAFETY_REASON_CODE_PATTERN } from '@data-pulse-2/db';
import { z } from 'zod';

import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import type { TenantContextRequest } from '../../context/types';
import { Idempotent } from '../../idempotency/idempotent.decorator';
import { IdentityExpiryService, type ExpiryCorrectionResult } from './identity-expiry.service';
import {
  InventoryRecallsService,
  type InventoryRecallBody,
  type InventoryRecallResult,
} from './inventory-recalls.service';
import type { TrackingHoldBody, TrackingHoldResult } from './safety.common';
import { TrackingHoldsService } from './tracking-holds.service';

const UuidSchema = z.string().uuid();
const ReasonCodeSchema = z.string().regex(SAFETY_REASON_CODE_PATTERN);
const NoteSchema = z.string().max(500).optional();

/** Contract `PlaceQualityHoldCommand` (`additionalProperties: false`). */
const PlaceQualityHoldSchema = z
  .object({ trackingIdentityId: UuidSchema, reasonCode: ReasonCodeSchema, note: NoteSchema })
  .strict();
type PlaceQualityHoldDto = z.infer<typeof PlaceQualityHoldSchema>;

/** Contract `ReleaseTrackingHoldCommand`; the body itself is optional. */
const ReleaseTrackingHoldSchema = z.object({ note: NoteSchema }).strict().optional();
type ReleaseTrackingHoldDto = z.infer<typeof ReleaseTrackingHoldSchema>;

/** Contract `CreateInventoryRecallCommand`. */
const CreateInventoryRecallSchema = z
  .object({
    tenantProductRef: UuidSchema,
    trackingIdentityIds: z
      .array(UuidSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
        message: 'trackingIdentityIds must not repeat an identity',
      }),
    reasonCode: ReasonCodeSchema,
    reference: z.string().trim().min(1).max(200),
    note: NoteSchema,
    effectiveAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
type CreateInventoryRecallDto = z.infer<typeof CreateInventoryRecallSchema>;

/** Contract `CorrectTrackingIdentityExpiryCommand` (`expiryDate` required, nullable). */
const CorrectExpirySchema = z
  .object({
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    reasonCode: ReasonCodeSchema,
    note: NoteSchema,
  })
  .strict();
type CorrectExpiryDto = z.infer<typeof CorrectExpirySchema>;

/** The resolved caller of a safety command. */
interface SafetyActor {
  readonly tenantId: string;
  readonly userId: string;
}

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class InventorySafetyController {
  constructor(
    private readonly holds: TrackingHoldsService,
    private readonly recalls: InventoryRecallsService,
    private readonly expiry: IdentityExpiryService,
  ) {}

  /** Place a quality hold on a tracking identity (G7-6). */
  @Post('api/inventory/v1/tracking-holds')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  @Idempotent('required')
  async placeQualityHold(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(PlaceQualityHoldSchema)) body: PlaceQualityHoldDto,
  ): Promise<TrackingHoldResult> {
    return this.holds.placeQualityHold({
      ...actor(request),
      idempotencyKey: requireKey(idempotencyKey),
      trackingIdentityId: body.trackingIdentityId,
      reasonCode: body.reasonCode,
      note: body.note ?? null,
    });
  }

  /** One hold of the tenant. */
  @Get('api/inventory/v1/tracking-holds/:holdId')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async getTrackingHold(
    @Req() request: TenantContextRequest,
    @Param('holdId', new ZodValidationPipe(UuidSchema)) holdId: string,
  ): Promise<TrackingHoldBody> {
    return this.holds.getHold(actor(request).tenantId, holdId);
  }

  /** Release a hold: owner only (965, H1). */
  @Post('api/inventory/v1/tracking-holds/:holdId/release')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', { denyAs: 403 })
  async releaseTrackingHold(
    @Req() request: TenantContextRequest,
    @Param('holdId', new ZodValidationPipe(UuidSchema)) holdId: string,
    @Body(new ZodValidationPipe(ReleaseTrackingHoldSchema)) body: ReleaseTrackingHoldDto,
  ): Promise<TrackingHoldResult> {
    return this.holds.releaseHold({ ...actor(request), holdId, note: body?.note ?? null });
  }

  /** Recall listed identities of one product (860). */
  @Post('api/inventory/v1/recalls')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  @Idempotent('required')
  async createInventoryRecall(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(CreateInventoryRecallSchema)) body: CreateInventoryRecallDto,
  ): Promise<InventoryRecallResult> {
    return this.recalls.createRecall({
      ...actor(request),
      idempotencyKey: requireKey(idempotencyKey),
      tenantProductRef: body.tenantProductRef,
      trackingIdentityIds: body.trackingIdentityIds,
      reasonCode: body.reasonCode,
      reference: body.reference,
      note: body.note ?? null,
      effectiveAt: body.effectiveAt ?? null,
    });
  }

  /** One recall of the tenant with its holds. */
  @Get('api/inventory/v1/recalls/:recallId')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async getInventoryRecall(
    @Req() request: TenantContextRequest,
    @Param('recallId', new ZodValidationPipe(UuidSchema)) recallId: string,
  ): Promise<InventoryRecallBody> {
    return this.recalls.getRecall(actor(request).tenantId, recallId);
  }

  /** Correct an identity's expiry date, with history (G7-2, H7). */
  @Post('api/inventory/v1/tracking-identities/:identityId/expiry-corrections')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  @Idempotent('required')
  async correctTrackingIdentityExpiry(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('identityId', new ZodValidationPipe(UuidSchema)) identityId: string,
    @Body(new ZodValidationPipe(CorrectExpirySchema)) body: CorrectExpiryDto,
  ): Promise<ExpiryCorrectionResult> {
    return this.expiry.correctExpiry({
      ...actor(request),
      idempotencyKey: requireKey(idempotencyKey),
      trackingIdentityId: identityId,
      expiryDate: body.expiryDate,
      reasonCode: body.reasonCode,
      note: body.note ?? null,
    });
  }
}

/** An authenticated, tenant-bound principal. */
function actor(request: TenantContextRequest): SafetyActor {
  const tenantId = request.context?.tenantId ?? null;
  const userId = request.context?.userId ?? null;
  if (tenantId === null) throw new UnauthorizedException('Unauthorized');
  if (userId === null) throw new UnauthorizedException('Unauthorized');
  return { tenantId, userId };
}

/** `@Idempotent('required')` rejects a request without the header first. */
function requireKey(idempotencyKey: string | undefined): string {
  if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
  return idempotencyKey;
}
