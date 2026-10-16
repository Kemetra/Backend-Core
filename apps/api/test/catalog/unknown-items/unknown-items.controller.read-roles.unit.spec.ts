/**
 * unknown-items.controller.read-roles.unit.spec.ts — RT-566.
 *
 * Docker-free proof that the two dashboard READ handlers (list + inspect) are
 * role-gated exactly like dismiss: owner / tenant_admin / store_manager pass,
 * store_staff (and a caller with no membership) is refused with 403 `forbidden`
 * (the contract's documented role-refusal for both operations).
 *
 * The REAL `RolesGuard` + `Reflector` run against the REAL controller handler
 * metadata; only the membership lookup is stubbed.
 */
import "reflect-metadata";

import {
  ForbiddenException,
  type ExecutionContext,
} from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";

import { RolesGuard } from "../../../src/auth/roles.guard";
import { UnknownItemsController } from "../../../src/catalog/unknown-items/unknown-items.controller";
import type { MembershipRepository } from "../../../src/context/membership.repository";

type Handler = (...args: never[]) => unknown;

const READ_HANDLERS: ReadonlyArray<readonly [name: string, handler: Handler]> = [
  ["list", UnknownItemsController.prototype.tenantAdminListUnknownItems as Handler],
  ["inspect", UnknownItemsController.prototype.tenantAdminInspectUnknownItem as Handler],
];

function guardFor(role: string | null): RolesGuard {
  const memberships = {
    isPlatformAdmin: async () => false,
    findRoleCodeForUserInTenant: async () => role,
  } as unknown as MembershipRepository;
  return new RolesGuard(new Reflector(), memberships);
}

function execCtx(handler: Handler): ExecutionContext {
  const request = {
    principal: { kind: "session", sessionId: "s", userId: "u" },
    context: { tenantId: "t", storeId: null, userId: "u", isPlatformAdmin: false },
  };
  return {
    getHandler: () => handler,
    getClass: () => UnknownItemsController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe.each(READ_HANDLERS)("RT-566 — %s read is role-gated", (_name, handler) => {
  it("mounts RolesGuard on the handler", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
    expect(guards).toContain(RolesGuard);
  });

  it.each(["owner", "tenant_admin", "store_manager"])("%s is allowed", async (role) => {
    await expect(guardFor(role).canActivate(execCtx(handler))).resolves.toBe(true);
  });

  it("store_staff is refused with 403 forbidden", async () => {
    const attempt = guardFor("store_staff").canActivate(execCtx(handler));
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a caller with no membership is refused with 403", async () => {
    const attempt = guardFor(null).canActivate(execCtx(handler));
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
  });
});
