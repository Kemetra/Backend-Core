/**
 * TrackingIdentitiesController — RT-448 (RT-50 Inventory Gate 7, rule G7-2).
 *
 *   GET /api/inventory/v1/products/{productId}/tracking-identities
 *     → listTrackingIdentities (packages/contracts/openapi/inventory/inventory.yaml)
 *
 * Read-only: the tenant's batches / serials of one product. Identities are
 * tenant-wide, not store-scoped, so this route does not use the store-scoped
 * authorization of `InventoryController`; it is owner / tenant-admin only
 * (`RolesGuard` + `@Roles`, denyAs 404: any other role, and a product outside
 * the session tenant, is a non-disclosing 404, §II/§XII).
 *
 * A separate controller keeps `RolesGuard` (and its MembershipRepository
 * dependency) off the store-scoped inventory routes.
 */
import {
  Controller,
  Get,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { DashboardAuthGuard } from '../auth/dashboard-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TenantContextGuard } from '../context/tenant-context.guard';
import type { TenantContextRequest } from '../context/types';
import { InventoryService, type TrackingIdentityListBody } from './inventory.service';

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class TrackingIdentitiesController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('api/inventory/v1/products/:productId/tracking-identities')
  @UseGuards(RolesGuard)
  @Roles('owner', 'tenant_admin')
  async listTrackingIdentities(
    @Req() request: TenantContextRequest,
    @Param('productId', new ZodValidationPipe(z.string().uuid())) productId: string,
  ): Promise<TrackingIdentityListBody> {
    const tenantId = request.context?.tenantId;
    if (!tenantId) throw new UnauthorizedException('Unauthorized');
    return this.inventoryService.listTrackingIdentities({ tenantId, productId });
  }
}
