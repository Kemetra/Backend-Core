/**
 * ConsoleCatalogWriteController — RT-738 (CAT-W1 + CAT-W2): the interim,
 * audited console writes of the Tenant Catalog (`catalog/console-catalog.yaml`
 * 1.1.0-draft), before Catalog Change Sets (decision 400).
 *
 *   POST  /api/v1/catalog/products                                              consoleCreateCatalogProduct
 *   PATCH /api/v1/catalog/products/{productId}                                  consoleUpdateCatalogProduct
 *   POST  /api/v1/catalog/products/{productId}/retire                           consoleRetireCatalogProduct
 *   POST  /api/v1/catalog/products/{productId}/identifiers                      consoleAddProductIdentifier
 *   POST  /api/v1/catalog/products/{productId}/identifiers/retire               consoleRetireProductIdentifier
 *   PUT   /api/v1/catalog/products/{productId}/store-overrides/{storeId}        consoleUpsertStoreOverride
 *   POST  /api/v1/catalog/products/{productId}/store-overrides/{storeId}/retire consoleRetireStoreOverride
 *
 * Auth: the reads' chain. `SessionOnlyAdminGuard` (every bearer is 401; a
 * cookie write without a trusted `Origin` is 403 `origin_rejected`, RT-430),
 * then `TenantContextGuard`, then `RolesGuard` (default deny → the
 * non-disclosing 404): CAT-W1 is `owner` / `tenant_admin`; CAT-W2 adds
 * `store_manager` for the availability of a store in its scope. The tenant
 * and the actor are the session's (§XII).
 *
 * The create is `@Idempotent("required")`. Every audit row is written by the
 * service in the write's transaction, so no handler carries `@Auditable`.
 * Every write answers with the product detail, `Cache-Control: no-store`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import type { ConsoleCatalogProductDetail } from "./console-catalog.projections";
import { ProductIdParamSchema } from "./console-catalog.query";
import { CatalogProductNotFoundError, CatalogStoreNotInScopeError } from "./console-catalog.service";
import {
  CreateCatalogProductBodySchema,
  ProductIdentifierKeySchema,
  RetireBodySchema,
  UpdateCatalogProductBodySchema,
  UpsertStoreOverrideBodySchema,
  type CreateCatalogProductBody,
  type ProductIdentifierKeyBody,
  type RetireBody,
  type UpdateCatalogProductBody,
  type UpsertStoreOverrideBody,
} from "./console-catalog.write-bodies";
import {
  CatalogWriteRefusedError,
  ConsoleCatalogWriteService,
  type CatalogWriteInput,
} from "./console-catalog.write.service";

const PRODUCTS = "api/v1/catalog/products";
const PRODUCT = `${PRODUCTS}/:productId`;
const OVERRIDE = `${PRODUCT}/store-overrides/:storeId`;

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (FR-ISO-4). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const REFUSAL_MESSAGES: Readonly<Record<CatalogWriteRefusedError["code"], string>> = {
  stale_write: "The record changed since it was read. Reload and retry.",
  product_retired: "The product is retired.",
  alias_conflict: "The identifier is already in use.",
  price_override_present: "The override has a price, which this surface does not change.",
  category_unavailable: "The category is not available.",
  override_empty: "The override would hold no overridden field. Retire it instead.",
  tax_override_forbidden: "Only an owner or tenant admin may change a store tax override.",
};

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsoleCatalogWriteController {
  constructor(private readonly service: ConsoleCatalogWriteService) {}

  @Post(PRODUCTS)
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  create(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(CreateCatalogProductBodySchema)) body: CreateCatalogProductBody,
  ): Promise<ConsoleCatalogProductDetail> {
    return mapErrors(() => this.service.createProduct(writer(request), body));
  }

  @Patch(PRODUCT)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Header("Cache-Control", "no-store")
  update(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Body(new ZodValidationPipe(UpdateCatalogProductBodySchema)) body: UpdateCatalogProductBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const id = parseId(productId, "productId");
    return mapErrors(() => this.service.updateProduct(writer(request), { productId: id }, body));
  }

  @Post(`${PRODUCT}/retire`)
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Header("Cache-Control", "no-store")
  retire(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Body(new ZodValidationPipe(RetireBodySchema)) body: RetireBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const id = parseId(productId, "productId");
    return mapErrors(() => this.service.retireProduct(writer(request), { productId: id }, body));
  }

  @Post(`${PRODUCT}/identifiers`)
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Header("Cache-Control", "no-store")
  addIdentifier(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Body(new ZodValidationPipe(ProductIdentifierKeySchema)) body: ProductIdentifierKeyBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const id = parseId(productId, "productId");
    return mapErrors(() => this.service.addIdentifier(writer(request), { productId: id }, body));
  }

  @Post(`${PRODUCT}/identifiers/retire`)
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Header("Cache-Control", "no-store")
  retireIdentifier(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Body(new ZodValidationPipe(ProductIdentifierKeySchema)) body: ProductIdentifierKeyBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const id = parseId(productId, "productId");
    return mapErrors(() => this.service.retireIdentifier(writer(request), { productId: id }, body));
  }

  @Put(OVERRIDE)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  upsertOverride(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Param("storeId") storeId: string,
    @Body(new ZodValidationPipe(UpsertStoreOverrideBodySchema)) body: UpsertStoreOverrideBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const id = parseId(productId, "productId");
    const store = parseId(storeId, "storeId");
    return mapErrors(() => this.service.upsertOverride(writer(request), { productId: id, storeId: store }, body));
  }

  @Post(`${OVERRIDE}/retire`)
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  retireOverride(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Param("storeId") storeId: string,
    @Body(new ZodValidationPipe(RetireBodySchema)) body: RetireBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const id = parseId(productId, "productId");
    const store = parseId(storeId, "storeId");
    return mapErrors(() => this.service.retireOverride(writer(request), { productId: id, storeId: store }, body));
  }
}

/** A request-shape error, checked before any read: it discloses nothing. */
function parseId(value: string, name: string): string {
  const parsed = ProductIdParamSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: "validation_error", message: `${name} must be a valid UUID` });
  return parsed.data;
}

/** The session tenant, the actor and the request id of a write. */
function writer(request: TenantContextRequest): CatalogWriteInput {
  const ctx = request.context;
  if (ctx === undefined) throw new UnauthorizedException("Unauthorized");
  const { tenantId, userId } = ctx;
  if (tenantId === null) throw new UnauthorizedException("Unauthorized");
  if (userId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId, context: ctx, actorUserId: userId, requestId: request.requestId ?? null };
}

/** Maps the service's refusals to the contract's 4xx; anything else propagates (500). */
async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof CatalogProductNotFoundError || err instanceof CatalogStoreNotInScopeError) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (err instanceof CatalogWriteRefusedError) {
      throw new HttpException({ code: err.code, message: REFUSAL_MESSAGES[err.code] }, err.status);
    }
    throw err;
  }
}
