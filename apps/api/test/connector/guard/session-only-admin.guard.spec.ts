/**
 * 018-US1 (T044a) — SessionOnlyAdminGuard kind-check (FR-005c).
 *
 * The integration spec (`register-and-issue.spec.ts`) overrides this guard, so
 * the KIND discrimination is proven here in isolation: a human cookie session
 * is allowed; ANY token principal — including a privileged `dashboard_api`
 * bearer — is rejected with a non-disclosing 401. This is the load-bearing
 * FR-005c case: a role check alone (RolesGuard) cannot deny an owner's
 * dashboard_api bearer, so the kind check must.
 *
 * Pure unit test: we stub `AuthGuard.canActivate` (the base) to attach a chosen
 * principal, then assert the subclass's post-auth kind gate. No app boot, no DB.
 */
import "reflect-metadata";

import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";

import { AuthGuard } from "../../../src/auth/auth.guard";
import { SessionOnlyAdminGuard } from "../../../src/auth/session-only-admin.guard";

type Principal = { kind: string; scope?: string; userId?: string | null };

function ctxWith(principal: Principal | undefined): ExecutionContext {
  const req: { principal?: Principal } = {};
  if (principal) req.principal = principal;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("SessionOnlyAdminGuard — FR-005c kind check", () => {
  let guard: SessionOnlyAdminGuard;
  let baseSpy: jest.SpyInstance;

  beforeEach(() => {
    // The base AuthGuard requires DI collaborators; we only need it to "succeed
    // authentication" (the subclass reads request.principal which our ctx sets).
    guard = new SessionOnlyAdminGuard(...([{}, {}] as unknown as ConstructorParameters<typeof SessionOnlyAdminGuard>));
    baseSpy = jest
      .spyOn(AuthGuard.prototype, "canActivate")
      .mockResolvedValue(true);
  });

  afterEach(() => {
    baseSpy.mockRestore();
  });

  it("allows a human cookie session", async () => {
    await expect(
      guard.canActivate(ctxWith({ kind: "session", userId: "u1" })),
    ).resolves.toBe(true);
  });

  it("REJECTS a dashboard_api machine bearer (the load-bearing FR-005c case)", async () => {
    await expect(
      guard.canActivate(
        ctxWith({ kind: "token", scope: "dashboard_api", userId: "u1" }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("REJECTS a connector / pos / pos_operator bearer (any token kind)", async () => {
    for (const scope of ["connector", "pos", "pos_operator"]) {
      await expect(
        guard.canActivate(ctxWith({ kind: "token", scope })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it("REJECTS when no principal is attached (non-disclosing 401)", async () => {
    await expect(guard.canActivate(ctxWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
