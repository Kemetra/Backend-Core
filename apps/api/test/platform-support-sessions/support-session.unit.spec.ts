/**
 * RT-414 support-session units: the gate's decision table, the refusal
 * envelope, route coverage, and the audit metadata builders (allowlist, no
 * other-tenant session on a `support_session_required` row). Docker-free;
 * the HTTP + RLS behavior is platform-support-sessions.http.integration.spec.ts.
 */
import "reflect-metadata";

import { Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { PoolClient } from "pg";

import {
  coveredTarget,
  readOnlyExemptFor,
  routeTemplate,
} from "../../src/platform-support-sessions/support-session.coverage";
import {
  decideSupportSession,
  supportSessionRefusal,
} from "../../src/platform-support-sessions/support-session.gate";
import {
  recordCrossTenantAccess,
  recordSupportSessionChange,
  toSupportSessionBody,
  toSupportSessionSummary,
  type SupportSessionRecord,
} from "../../src/platform-support-sessions/support-session.store";

const TENANT = "04140000-0000-4000-8000-0000000000a1";
const OTHER = "04140000-0000-4000-8000-0000000000b1";

function record(overrides: Partial<SupportSessionRecord> = {}): SupportSessionRecord {
  return {
    id: "04140000-0000-4000-8000-00000000f001",
    authSessionId: "04140000-0000-4000-8000-00000000f002",
    userId: "04140000-0000-4000-8000-00000000f003",
    tenantId: TENANT,
    purpose: "incident",
    ticketRef: "ZD-1",
    openedAt: new Date("2026-10-21T08:00:00Z"),
    renewedAt: null,
    expiresAt: new Date("2026-10-21T09:00:00Z"),
    renewalCapAt: new Date("2026-10-21T16:00:00Z"),
    endedAt: null,
    endReason: null,
    status: "active",
    ...overrides,
  };
}

const ACTIVE_TENANT = { exists: true, suspended: false };
const SUSPENDED_TENANT = { exists: true, suspended: true };

describe("decideSupportSession (RT-414 contract order)", () => {
  const base = { tenantId: TENANT, tenant: ACTIVE_TENANT, method: "GET", readOnlyExempt: false };

  it("admits an active session for exactly this tenant", () => {
    expect(decideSupportSession({ ...base, session: record() })).toBeUndefined();
    expect(decideSupportSession({ ...base, method: "POST", session: record() })).toBeUndefined();
  });

  it("requires a session: none, another tenant's, or a gone tenant", () => {
    expect(decideSupportSession({ ...base, session: null })).toBe("support_session_required");
    expect(decideSupportSession({ ...base, session: record({ tenantId: OTHER }) })).toBe(
      "support_session_required",
    );
    expect(
      decideSupportSession({ ...base, tenant: { exists: false, suspended: false }, session: record() }),
    ).toBe("support_session_required");
  });

  it("refuses an expired session before the read-only rule", () => {
    expect(decideSupportSession({ ...base, session: record({ status: "expired" }) })).toBe(
      "support_session_expired",
    );
    expect(
      decideSupportSession({
        ...base,
        tenant: SUSPENDED_TENANT,
        method: "POST",
        session: record({ status: "expired" }),
      }),
    ).toBe("support_session_expired");
  });

  it("makes a suspended tenant read-only unless the route is exempt", () => {
    const suspended = { ...base, tenant: SUSPENDED_TENANT, session: record() };
    expect(decideSupportSession({ ...suspended, method: "GET" })).toBeUndefined();
    expect(decideSupportSession({ ...suspended, method: "head" })).toBeUndefined();
    for (const method of ["POST", "PUT", "PATCH", "delete"]) {
      expect(decideSupportSession({ ...suspended, method })).toBe("support_session_read_only");
    }
    expect(decideSupportSession({ ...suspended, method: "PATCH", readOnlyExempt: true })).toBeUndefined();
  });
});

describe("supportSessionRefusal", () => {
  it("is a 403 with the stable code and a non-disclosing message", () => {
    for (const code of [
      "support_session_required",
      "support_session_expired",
      "support_session_read_only",
      "origin_rejected",
    ] as const) {
      const err = supportSessionRefusal(code);
      expect(err.getStatus()).toBe(403);
      const payload = err.getResponse() as { code: string; message: string };
      expect(payload.code).toBe(code);
      expect(payload.message).not.toMatch(/[0-9a-f]{8}-/);
    }
  });
});

// ----- coverage -------------------------------------------------------------

class TenantContextGuard {
  canActivate(): boolean {
    return true;
  }
}

@Controller("api/v1/stores")
@UseGuards(TenantContextGuard)
class StoresController {
  @Get(":store_id")
  read(): void {}
}

@Controller("api/v1/tenants")
class TenantsController {
  @Get(":id/members")
  listMembers(): void {}
  @Patch(":id")
  update(): void {}
  @Get(":id")
  read(): void {}
}

@Controller("api/v1/context")
class ContextController {
  @Post("store")
  switchStore(): void {}
  @Get("me")
  me(): void {}
}

function ctx(cls: object, handler: string): ExecutionContext {
  const target = cls as { prototype: Record<string, unknown> };
  return {
    getClass: () => cls,
    getHandler: () => target.prototype[handler],
  } as unknown as ExecutionContext;
}

describe("coveredTarget / routeTemplate", () => {
  it("covers TenantContextGuard routes on the active tenant", () => {
    expect(coveredTarget(ctx(StoresController, "read"))).toEqual({
      kind: "active-tenant",
      readOnlyExempt: false,
    });
    expect(routeTemplate(ctx(StoresController, "read"))).toBe("/api/v1/stores/:store_id");
  });

  it("covers the path tenants and switchActiveStore, with their read-only exemptions", () => {
    expect(coveredTarget(ctx(TenantsController, "listMembers"))).toEqual({
      kind: "path-tenant",
      param: "id",
      readOnlyExempt: false,
    });
    expect(coveredTarget(ctx(TenantsController, "update"))).toMatchObject({ readOnlyExempt: "status-only" });
    expect(coveredTarget(ctx(ContextController, "switchStore"))).toEqual({
      kind: "active-tenant",
      readOnlyExempt: true,
    });
  });

  it("exempts updateTenant on a suspended tenant only for a status-only body", () => {
    const update = coveredTarget(ctx(TenantsController, "update"))!;
    expect(readOnlyExemptFor(update, { status: "active" })).toBe(true);
    expect(readOnlyExemptFor(update, { status: "active", name: "x" })).toBe(false);
    expect(readOnlyExemptFor(update, { name: "x" })).toBe(false);
    expect(readOnlyExemptFor(update, {})).toBe(false);
    expect(readOnlyExemptFor(update, undefined)).toBe(false);
    expect(readOnlyExemptFor(update, ["status"])).toBe(false);
    expect(readOnlyExemptFor(coveredTarget(ctx(ContextController, "switchStore"))!, undefined)).toBe(true);
    expect(readOnlyExemptFor(coveredTarget(ctx(StoresController, "read"))!, { status: "x" })).toBe(false);
  });

  it("leaves platform-scope and context reads uncovered", () => {
    expect(coveredTarget(ctx(TenantsController, "read"))).toBeNull();
    expect(coveredTarget(ctx(ContextController, "me"))).toBeNull();
  });

  it("falls back to 'unknown' without route metadata", () => {
    const bare = { getClass: () => ({}), getHandler: () => ({}) } as unknown as ExecutionContext;
    expect(routeTemplate(bare)).toBe("unknown");
  });
});

// ----- store builders -------------------------------------------------------

function fakeClient(): { client: PoolClient; inserted: () => unknown[][] } {
  const calls: unknown[][] = [];
  const client = {
    query: jest.fn(async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, inserted: () => calls };
}

function metadataOf(params: unknown[]): Record<string, unknown> {
  return JSON.parse(String(params[6])) as Record<string, unknown>;
}

describe("audit rows", () => {
  it("records opened / ended with the allowlist only", async () => {
    const { client, inserted } = fakeClient();
    await recordSupportSessionChange(client, "platform.support_session.opened", record(), "rid-1");
    await recordSupportSessionChange(
      client,
      "platform.support_session.ended",
      record({ status: "ended", endedAt: new Date(), endReason: "operator" }),
      null,
    );
    const [opened, ended] = inserted();
    expect(opened![2]).toBe("platform_support");
    expect(opened![3]).toBe(TENANT);
    expect(metadataOf(opened!)).toEqual({
      actor_kind: "platform_admin",
      outcome: "succeeded",
      support_session_id: record().id,
      purpose: "incident",
      ticket_ref: "ZD-1",
      expires_at: "2026-10-21T09:00:00.000Z",
    });
    expect(metadataOf(ended!)).toMatchObject({ end_reason: "operator" });
    expect(metadataOf(ended!)).not.toHaveProperty("expires_at");
  });

  it("never names another tenant's session on a support_session_required row", async () => {
    const { client, inserted } = fakeClient();
    await recordCrossTenantAccess(client, {
      tenantId: TENANT,
      actorUserId: record().userId,
      requestId: null,
      method: "get",
      route: "/api/v1/stores",
      session: record({ tenantId: OTHER }),
      reason: "support_session_required",
    });
    expect(metadataOf(inserted()[0]!)).toEqual({
      actor_kind: "platform_admin",
      outcome: "rejected",
      reason: "support_session_required",
      support_session_id: null,
      purpose: null,
      method: "GET",
      route: "/api/v1/stores",
    });
  });

  it("bounds the method and route", async () => {
    const { client, inserted } = fakeClient();
    await recordCrossTenantAccess(client, {
      tenantId: null,
      actorUserId: record().userId,
      requestId: "rid",
      method: "OPTIONS",
      route: "",
      session: record(),
    });
    const meta = metadataOf(inserted()[0]!);
    expect(meta).toMatchObject({ outcome: "succeeded", method: "GET", route: "unknown" });
    expect(meta).not.toHaveProperty("reason");
  });
});

describe("wire shapes", () => {
  it("projects the session and hides an ended one from the banner", () => {
    expect(toSupportSessionBody(record())).toMatchObject({
      id: record().id,
      status: "active",
      renewed_at: null,
      ended_at: null,
      end_reason: null,
    });
    expect(toSupportSessionSummary(record())).toEqual({
      id: record().id,
      tenant_id: TENANT,
      purpose: "incident",
      ticket_ref: "ZD-1",
      status: "active",
      expires_at: "2026-10-21T09:00:00.000Z",
      renewal_cap_at: "2026-10-21T16:00:00.000Z",
    });
    expect(toSupportSessionSummary(record({ status: "ended" }))).toBeNull();
  });
});
