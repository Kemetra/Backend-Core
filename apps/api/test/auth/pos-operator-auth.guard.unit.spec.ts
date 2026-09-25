/**
 * pos-operator-auth.guard.unit.spec.ts
 *
 * Docker-free unit coverage for PosOperatorAuthGuard (mirror of
 * `dashboard-auth.guard.unit.spec.ts`).
 *
 * Strategy: hand-written fakes for SessionRepository and AuthTokenRepository.
 * The guard is constructed directly (it extends AuthGuard, inheriting the
 * same constructor signature). No NestJS test module, no Testcontainers, no
 * network.
 *
 * Contract under test (per 002 FR-POS-AUTH-4):
 *   - session principal           → UnauthorizedException (401)
 *     (dashboard cookies never reach POS routes)
 *   - pos_operator token          → allowed
 *   - dashboard_api token         → UnauthorizedException (401)
 *   - pos token                   → UnauthorizedException (401)
 *     (POS service-account tokens are not operator-session state)
 *   - inner AuthGuard failure     → UnauthorizedException (401)
 *   - super resolves, no principal → UnauthorizedException (401)
 */
import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthTokenRow, SessionRow } from "@data-pulse-2/db/schema";

import { AuthGuard, SESSION_COOKIE_NAME } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import { PosOperatorAuthGuard } from "../../src/auth/pos-operator-auth.guard";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";
const TOKEN_ID   = "0a000000-0000-7000-8000-0000000tok01";
const USER_ID    = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID  = "0a000000-0000-7000-8000-0000000ten01";
const STORE_ID   = "0a000000-0000-7000-8000-0000000sto01";
const DEVICE_ID  = "0a000000-0000-7000-8000-0000000dev01";

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
  const guard      = new PosOperatorAuthGuard(
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
    // pos_operator tokens carry a device + store binding per 002 FR-POS-AUTH-4.
    // Default to populated so the realistic happy-path test exercises a fully
    // bound row; tests overriding for other scopes (dashboard_api/pos) set
    // them to null since those scopes have no store binding.
    deviceId: DEVICE_ID,
    storeId: STORE_ID,
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
// POG1 — pos_operator token is allowed
// ===========================================================================

describe("PosOperatorAuthGuard — pos_operator token", () => {
  it("POG1: bearer token with scope=pos_operator → returns true", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(makeToken("pos_operator"));

    const req = makeRequest({ bearer: "Bearer pos-operator-token" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    expect(authTokens.findActiveByRawToken).toHaveBeenCalledWith("pos-operator-token");
  });
});

// ===========================================================================
// POG2 — session principal is rejected (dashboard cookies don't cross to POS)
// ===========================================================================

describe("PosOperatorAuthGuard — session principal rejected", () => {
  it("POG2: cookie session → throws UnauthorizedException (POS routes reject dashboard sessions)", async () => {
    const { guard, sessions } = buildGuard();
    sessions.findActiveByCredential.mockResolvedValue(makeSession());

    const req = makeRequest({ cookie: SESSION_ID });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ===========================================================================
// POG3 — dashboard_api token is rejected
// ===========================================================================

describe("PosOperatorAuthGuard — dashboard_api token rejected", () => {
  it("POG3: bearer token with scope=dashboard_api → throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(
      makeToken("dashboard_api", { deviceId: null, storeId: null }),
    );

    const req = makeRequest({ bearer: "Bearer dashboard-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ===========================================================================
// POG4 — pos token is rejected (POS service-account tokens are not operator state)
// ===========================================================================

describe("PosOperatorAuthGuard — pos token rejected", () => {
  it("POG4: bearer token with scope=pos → throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(
      makeToken("pos", { deviceId: null, storeId: null }),
    );

    const req = makeRequest({ bearer: "Bearer pos-device-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ===========================================================================
// POG5 — inner AuthGuard failure propagates as 401
// ===========================================================================

describe("PosOperatorAuthGuard — inner AuthGuard failure", () => {
  it("POG5: missing credentials → inner AuthGuard throws UnauthorizedException", async () => {
    const { guard } = buildGuard();

    const req = makeRequest({});
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("POG5b: bearer token not found in DB → inner AuthGuard throws UnauthorizedException", async () => {
    const { guard, authTokens } = buildGuard();
    authTokens.findActiveByRawToken.mockResolvedValue(null);

    const req = makeRequest({ bearer: "Bearer unknown-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ===========================================================================
// POG6 — !principal defensive branch
// ===========================================================================

describe("PosOperatorAuthGuard — !principal defensive check", () => {
  it("POG6: super.canActivate resolves but principal is not set → UnauthorizedException", async () => {
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
