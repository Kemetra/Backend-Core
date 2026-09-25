/**
 * dashboard-auth.guard.unit.spec.ts
 *
 * Docker-free unit coverage for DashboardAuthGuard.
 *
 * Strategy: hand-written fakes for SessionRepository and AuthTokenRepository.
 * The guard is constructed directly (it extends AuthGuard, inheriting the same
 * constructor signature). No NestJS test module, no Testcontainers, no network.
 *
 * Contract under test:
 *   - session principal → allowed
 *   - dashboard_api token → allowed
 *   - pos token → UnauthorizedException (401)
 *   - pos_operator token → UnauthorizedException (401)
 *   - inner AuthGuard failure (bad credentials) → UnauthorizedException (401)
 */

import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthTokenRow, SessionRow } from "@data-pulse-2/db/schema";

import { AuthGuard, SESSION_COOKIE_NAME } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";
const TOKEN_ID   = "0a000000-0000-7000-8000-0000000tok01";
const USER_ID    = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID  = "0a000000-0000-7000-8000-0000000ten01";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const makeFakeSessions = () => ({
  findActiveByCredential: jest.fn<Promise<SessionRow | null>, [string]>(),
});

const makeFakeAuthTokens = () => ({
  findActiveByRawToken: jest.fn<Promise<AuthTokenRow | null>, [string]>(),
});

function buildGuard() {
  const sessions   = makeFakeSessions();
  const authTokens = makeFakeAuthTokens();
  const guard      = new DashboardAuthGuard(
    sessions   as unknown as SessionRepository,
    authTokens as unknown as AuthTokenRepository,
  );
  return { guard, sessions, authTokens };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    activeTenantId: TENANT_ID,
    activeStoreId: null,
    revokedAt: null,
    ...overrides,
  } as unknown as SessionRow;
}

function makeToken(
  scope: string,
  overrides: Partial<AuthTokenRow> = {},
): AuthTokenRow {
  return {
    id: TOKEN_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    scope,
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    ...overrides,
  } as unknown as AuthTokenRow;
}

// ---------------------------------------------------------------------------
// ExecutionContext / request helpers
// ---------------------------------------------------------------------------

function makeCtx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

function makeRequest(opts: { cookie?: string; bearer?: string }): Record<string, unknown> {
  const req: Record<string, unknown> = {
    headers: {} as Record<string, string>,
    cookies: {} as Record<string, string>,
  };
  if (opts.cookie !== undefined) {
    (req.cookies as Record<string, string>)[SESSION_COOKIE_NAME] = opts.cookie;
  }
  if (opts.bearer !== undefined) {
    (req.headers as Record<string, string>)["authorization"] = opts.bearer;
  }
  return req;
}

// ===========================================================================
// DAG1 — session principal is allowed
// ===========================================================================

describe("DashboardAuthGuard — session principal", () => {
  it("DAG1: cookie session → returns true (dashboard humans are always allowed)", async () => {
    const { guard, sessions } = buildGuard();
    sessions.findActiveByCredential.mockResolvedValue(makeSession());

    const req = makeRequest({ cookie: SESSION_ID });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(sessions.findActiveByCredential).toHaveBeenCalledWith(SESSION_ID);
  });
});

// ===========================================================================
// DAG2 — dashboard_api token is allowed
// ===========================================================================

describe("DashboardAuthGuard — dashboard_api token", () => {
  it("DAG2: bearer token with scope=dashboard_api → returns true", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(makeToken("dashboard_api"));

    const req = makeRequest({ bearer: "Bearer dashboard-token-xyz" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith("dashboard-token-xyz");
  });
});

// ===========================================================================
// DAG3 — pos token is rejected
// ===========================================================================

describe("DashboardAuthGuard — pos token rejected", () => {
  it("DAG3: bearer token with scope=pos → throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(makeToken("pos"));

    const req = makeRequest({ bearer: "Bearer pos-device-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(makeCtx(req))).rejects.toMatchObject({
      message: "Unauthorized",
    });
  });
});

// ===========================================================================
// DAG4 — pos_operator token is rejected
// ===========================================================================

describe("DashboardAuthGuard — pos_operator token rejected", () => {
  it("DAG4: bearer token with scope=pos_operator → throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(makeToken("pos_operator"));

    const req = makeRequest({ bearer: "Bearer pos-operator-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(makeCtx(req))).rejects.toMatchObject({
      message: "Unauthorized",
    });
  });
});

// ===========================================================================
// DAG5 — inner AuthGuard failure propagates as 401
// ===========================================================================

describe("DashboardAuthGuard — inner AuthGuard failure", () => {
  it("DAG5: missing credentials → inner AuthGuard throws UnauthorizedException (never reaches scope check)", async () => {
    const { guard } = buildGuard();

    const req = makeRequest({});
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("DAG5b: bearer token not found in DB → inner AuthGuard throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(null);

    const req = makeRequest({ bearer: "Bearer unknown-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("DAG5c: expired/revoked session → inner AuthGuard throws UnauthorizedException", async () => {
    const { guard, sessions } = buildGuard();
    sessions.findActiveByCredential.mockResolvedValue(null);

    const req = makeRequest({ cookie: SESSION_ID });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ===========================================================================
// DAG6 — !principal defensive branch (line 34 in dashboard-auth.guard.ts)
// ===========================================================================

describe("DashboardAuthGuard — !principal defensive check", () => {
  it("DAG6: super.canActivate resolves but principal is not set → UnauthorizedException", async () => {
    const { guard } = buildGuard();

    // Spy on AuthGuard.prototype.canActivate so it resolves true without
    // populating request.principal, exercising the !principal defensive check.
    const spy = jest.spyOn(AuthGuard.prototype, "canActivate").mockResolvedValueOnce(true);

    const req: Record<string, unknown> = { headers: {}, cookies: {} };
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    spy.mockRestore();
  });
});
