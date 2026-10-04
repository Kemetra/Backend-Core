/**
 * pos-device-auth.guard.unit.spec.ts
 *
 * Docker-free unit coverage for PosDeviceAuthGuard (issue #488, Option B-prime).
 *
 * The read-down catalogue API (010) must authenticate a POS terminal by its
 * `devices` pairing token ALONE — no operator session — and resolve
 * `(tenant_id, store_id)` from the store-bound device row. This guard is the
 * device-principal authenticator for the read-down routes ONLY; it does NOT
 * extend or broaden PosOperatorAuthGuard.
 *
 * Strategy: a hand-written fake DeviceRepository. The guard is constructed
 * directly. No NestJS test module, no Testcontainers, no network.
 *
 * Contract under test (FR-001 device-principal; FR-002 scope-from-principal):
 *   - valid pairing token (active device row) → returns true; req.context is
 *     populated with the row's (tenantId, storeId), source 'token'.
 *   - missing Authorization header              → UnauthorizedException (401)
 *   - non-bearer / malformed header             → UnauthorizedException (401)
 *   - token matches no active device (null,
 *     incl. revoked)                            → UnauthorizedException (401)
 *   - dashboard cookie session present          → UnauthorizedException (401)
 *     (dashboard credentials never authenticate a device principal)
 */
import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { DeviceRow } from "@data-pulse-2/db/schema";

import { SESSION_COOKIE_NAME } from "../../src/auth/auth.guard";
import type { DeviceRepository } from "../../src/pos-operators/device.repository";
import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import type { TenantContextRequest } from "../../src/context/types";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const DEVICE_ID = "0a000000-0000-7000-8000-0000000dev01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const STORE_ID = "0a000000-0000-7000-8000-0000000sto01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const makeFakeDevices = () => ({
  findActiveByAttestation: jest.fn<Promise<DeviceRow | null>, [string]>(),
});

function buildGuard() {
  const devices = makeFakeDevices();
  const guard = new PosDeviceAuthGuard(devices as unknown as DeviceRepository);
  return { guard, devices };
}

function makeDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    label: "Lane 1",
    revokedAt: null,
    ...overrides,
  } as unknown as DeviceRow;
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

function makeRequest(opts: { cookie?: string; authorization?: string }): TenantContextRequest {
  const req: Record<string, unknown> = {
    headers: {} as Record<string, string>,
    cookies: {} as Record<string, string>,
  };
  if (opts.cookie !== undefined) {
    (req.cookies as Record<string, string>)[SESSION_COOKIE_NAME] = opts.cookie;
  }
  if (opts.authorization !== undefined) {
    (req.headers as Record<string, string>)["authorization"] = opts.authorization;
  }
  return req as unknown as TenantContextRequest;
}

// ===========================================================================
// PDG1 — valid pairing token authenticates + resolves store scope
// ===========================================================================

describe("PosDeviceAuthGuard — valid device pairing token", () => {
  it("PDG1: active device row → returns true and publishes (tenant, store) onto req.context", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(makeDevice());

    const req = makeRequest({ authorization: "Bearer device-pairing-token" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    // The raw token (sans "Bearer ") is what gets hashed + looked up.
    expect(devices.findActiveByAttestation).toHaveBeenCalledWith("device-pairing-token");
    expect(req.context).toEqual({
      userId: null,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      isPlatformAdmin: false,
      source: "token",
    });
    // A device principal is also published for the audit actor (FR-080):
    // null operator user, the device id as tokenId, `pos` device scope.
    expect(req.principal).toEqual({
      kind: "token",
      tokenId: DEVICE_ID,
      tenantId: TENANT_ID,
      userId: null,
      storeId: STORE_ID,
      scope: "pos",
    });
  });

  it("PDG1b (RT-113 BC2): publishes the authenticated device id as req.posDeviceId", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(makeDevice());

    const req = makeRequest({ authorization: "Bearer device-pairing-token" });
    await guard.canActivate(makeCtx(req));

    expect(req.posDeviceId).toBe(DEVICE_ID);
  });

  it("PDG1c: a refused credential publishes no device binding", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(null);

    const req = makeRequest({ authorization: "Bearer revoked-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow();

    expect(req.posDeviceId).toBeUndefined();
  });
});

// ===========================================================================
// PDG2 — missing Authorization header is rejected
// ===========================================================================

describe("PosDeviceAuthGuard — missing credential", () => {
  it("PDG2: no Authorization header → UnauthorizedException; no DB lookup", async () => {
    const { guard, devices } = buildGuard();

    const req = makeRequest({});
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devices.findActiveByAttestation).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PDG3 — non-bearer / malformed header is rejected
// ===========================================================================

describe("PosDeviceAuthGuard — malformed header", () => {
  it("PDG3: non-Bearer Authorization → UnauthorizedException; no DB lookup", async () => {
    const { guard, devices } = buildGuard();

    const req = makeRequest({ authorization: "Basic abc123" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devices.findActiveByAttestation).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PDG4 — token matching no active device (incl. revoked) is rejected
// ===========================================================================

describe("PosDeviceAuthGuard — unknown / revoked device token", () => {
  it("PDG4: findActiveByAttestation returns null → UnauthorizedException; no context published", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(null);

    const req = makeRequest({ authorization: "Bearer revoked-or-unknown" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(req.context).toBeUndefined();
  });
});

// ===========================================================================
// PDG5 — a dashboard cookie session never authenticates a device principal
// ===========================================================================

describe("PosDeviceAuthGuard — dashboard cookie rejected", () => {
  it("PDG5: cookie session, no Bearer → UnauthorizedException; no DB lookup", async () => {
    const { guard, devices } = buildGuard();

    const req = makeRequest({ cookie: SESSION_ID });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devices.findActiveByAttestation).not.toHaveBeenCalled();
  });
});
