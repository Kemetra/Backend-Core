/**
 * ConsoleCatalogController — RT-730 (CAT-R2): the console read of the Tenant
 * Catalog (`catalog/console-catalog.yaml`, RT-729) for Admin-Console RF-3 and
 * the RT-724 link product picker.
 *
 *   GET /api/v1/catalog/products              consoleListCatalogProducts
 *   GET /api/v1/catalog/products/{productId}  consoleGetCatalogProduct
 *   GET /api/v1/catalog/categories            consoleListCatalogCategories
 *
 * Auth: the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard` (every
 * bearer is 401), then `TenantContextGuard` (publishes `request.context`),
 * then `RolesGuard` + `@Roles("owner", "tenant_admin", "store_manager")`
 * (default deny → 404). The guards run before the query and path are
 * validated, so a refused role is a 404 for any input. The tenant is the
 * session's, never the request's (§XII); the store scope is applied by the
 * service. The console-sales precedent.
 *
 * Refusals: a malformed path, query or cursor is 400 `validation_error`; every
 * scope refusal (role, store outside the scope, other tenant, absent product)
 * is the same non-disclosing 404.
 *
 * Audit: none. Catalog reads are not audited per request (RT-281 O-6).
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import type {
  ConsoleCatalogCategory,
  ConsoleCatalogProductDetail,
  ConsoleCatalogProductPage,
} from "./console-catalog.projections";
import {
  catalogFiltersOf,
  CatalogProductListQuerySchema,
  InvalidCatalogCursorError,
  LIMIT_DEFAULT,
  ProductIdParamSchema,
  type CatalogProductListQuery,
} from "./console-catalog.query";
import {
  CatalogProductNotFoundError,
  CatalogStoreNotInScopeError,
  ConsoleCatalogReadService,
  type ScopedCatalogReadInput,
} from "./console-catalog.service";

/**
 * The one 404 body of this surface: the `RolesGuard` role refusal's, so a role,
 * store, tenant or product refusal cannot be told apart by its body (FR-ISO-4).
 */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: "validation_error", message });
}

function rejectAnyQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length > 0) throw validationError("this operation takes no query parameter");
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsoleCatalogController {
  constructor(private readonly service: ConsoleCatalogReadService) {}

  /** GET — search and list the tenant's products, keyset paginated. */
  @Get("api/v1/catalog/products")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  // RT-619 (RT-574 D3): a name scan with no trigram index (O-8).
  @ConsoleRateLimit("expensiveRead")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(CatalogProductListQuerySchema)) query: CatalogProductListQuery,
  ): Promise<ConsoleCatalogProductPage> {
    const scoped = requireTenant(request);
    try {
      return await this.service.list({
        ...scoped,
        filters: catalogFiltersOf(query),
        cursor: query.cursor ?? null,
        limit: query.limit ?? LIMIT_DEFAULT,
      });
    } catch (err) {
      if (err instanceof InvalidCatalogCursorError) throw validationError(err.message);
      if (err instanceof CatalogStoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /** GET — one product with its identifiers and store overrides in the caller's scope. */
  @Get("api/v1/catalog/products/:productId")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  async get(
    @Req() request: TenantContextRequest,
    @Param("productId") rawProductId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ConsoleCatalogProductDetail> {
    const scoped = requireTenant(request);
    // Request-shape errors, checked before any read: they disclose nothing.
    rejectAnyQuery(query);
    const parsed = ProductIdParamSchema.safeParse(rawProductId);
    if (!parsed.success) throw validationError("productId must be a valid UUID");
    try {
      return await this.service.get(scoped, parsed.data);
    } catch (err) {
      if (err instanceof CatalogProductNotFoundError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }

  /** GET — the tenant's active categories (flat). */
  @Get("api/v1/catalog/categories")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  async listCategories(
    @Req() request: TenantContextRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{ items: ConsoleCatalogCategory[] }> {
    const scoped = requireTenant(request);
    rejectAnyQuery(query);
    return { items: await this.service.listCategories(scoped) };
  }
}

/** The session tenant + the context whose store scope bounds the store data. */
function requireTenant(request: TenantContextRequest): ScopedCatalogReadInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}
