/**
 * RT-802 — `PosPayersController` wiring, Docker-free: the route, the envelope
 * guard followed by the per-device rate limit, `no-store`, no audit action, no
 * device marker, and the 403 body (the one `captureSale` uses). Scope comes
 * only from the guard-published context.
 */
import "reflect-metadata";

import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";

import { AUDITABLE_KEY } from "../../../../src/audit/auditable.decorator";
import { POS_WRITE_RATE_LIMIT_BUCKET_KEY } from "../../../../src/auth/pos-write-rate-limit.decorator";
import { PosOperatorEnvelopeSaleGuard } from "../../../../src/auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../../../../src/auth/pos-write-rate-limit.guard";
import { POS_WRITE_RATE_LIMIT_BUCKETS } from "../../../../src/auth/rate-limit";
import { DEVICE_BEARER_KEY } from "../../../../src/auth/route-auth";
import { PosPayersController } from "../../../../src/catalog/sales/payers/pos-payers.controller";
import type { PosPayersService } from "../../../../src/catalog/sales/payers/pos-payers.service";
import { SaleResponsibilityRoleRefusedError } from "../../../../src/catalog/sales/sale-responsibilities";
import type { TenantContextRequest } from "../../../../src/context/types";

const TENANT = "0a802000-0000-4000-8000-000000000001";
const STORE = "0a802000-0000-4000-8000-0000000000a1";
const USER = "0a802000-0000-4000-8000-0000000000b1";

const handler = PosPayersController.prototype.listChargeablePayers;

function requestWith(context: TenantContextRequest["context"]): TenantContextRequest {
  return { context } as TenantContextRequest;
}

describe("RT-802 PosPayersController wiring", () => {
  it("serves GET api/pos/v1/payer-accounts", () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("api/pos/v1/payer-accounts");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // RequestMethod.GET
  });

  it("runs the envelope guard, then the per-device rate limit on its own read bucket", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([PosOperatorEnvelopeSaleGuard, PosWriteRateLimitGuard]);
    expect(Reflect.getMetadata(POS_WRITE_RATE_LIMIT_BUCKET_KEY, handler)).toBe("posReadPayers");
    expect(POS_WRITE_RATE_LIMIT_BUCKETS.posReadPayers).toEqual({ limit: 600, windowMs: 60 * 60 * 1000 });
  });

  it("is no-store, unaudited and not a device route", () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([{ name: "Cache-Control", value: "no-store" }]);
    expect(Reflect.getMetadata(AUDITABLE_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(DEVICE_BEARER_KEY, handler)).toBeUndefined();
  });
});

describe("RT-802 PosPayersController handler", () => {
  it("passes only the guard-published tenant, store and operator to the service", async () => {
    const list = jest.fn().mockResolvedValue({ items: [], nextCursor: null, asOf: "2026-10-21T10:00:00.000Z" });
    const controller = new PosPayersController({ list } as unknown as PosPayersService);
    const ctx = { userId: USER, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" as const };
    await controller.listChargeablePayers(requestWith(ctx), { page_size: "5" });
    expect(list).toHaveBeenCalledWith({ tenantId: TENANT, storeId: STORE, actorUserId: USER, rawQuery: { page_size: "5" } });
  });

  it.each([
    ["no context", undefined],
    ["no store", { userId: USER, tenantId: TENANT, storeId: null, isPlatformAdmin: false, source: "token" as const }],
    ["no operator", { userId: null, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" as const }],
  ])("is the generic 401 with %s", async (_label, ctx) => {
    const controller = new PosPayersController({ list: jest.fn() } as unknown as PosPayersService);
    await expect(controller.listChargeablePayers(requestWith(ctx), {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("maps the role refusal to captureSale's 403 body", async () => {
    const list = jest.fn().mockRejectedValue(new SaleResponsibilityRoleRefusedError());
    const controller = new PosPayersController({ list } as unknown as PosPayersService);
    const ctx = { userId: USER, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" as const };
    const err = await controller.listChargeablePayers(requestWith(ctx), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({
      code: "sale_responsibility_role_refused",
      message: "credit sales need an owner, tenant admin or store manager",
    });
  });
});
