/**
 * platform-audit.unit.spec.ts — RT-431 runtime, Docker-free.
 *
 *   1. `maskActorLabel` (decision D5): every output is checked against the
 *      contract's `PlatformAuditEvent.actor_label` schema, so the mask and the
 *      schema stay pinned together.
 *   2. `PlatformAuditQuerySchema`: the closed filter set (no `tenant_id`, no
 *      `store_id`, unknown keys refused), the limit bounds and the cursor.
 *   3. Controller wiring: not under RT-414 support-session enforcement, not
 *      audited, `expensiveRead`, and the platform-admin check runs as a guard
 *      (before the query pipe).
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { ExecutionContext } from "@nestjs/common";

import { loadOpenApiContracts } from "../../src/openapi/loader";
import { maskActorLabel } from "../../src/audit/platform-audit.mask";
import { PlatformAuditQuerySchema } from "../../src/audit/platform-audit.query.schema";
import { encodeCursor } from "../../src/audit/audit.query.schema";
import { PlatformAuditController } from "../../src/audit/platform-audit.controller";
import { PlatformAdminGuard } from "../../src/audit/platform-admin.guard";
import { SessionOnlyAdminGuard } from "../../src/auth/session-only-admin.guard";
import { AUDITABLE_KEY } from "../../src/audit/auditable.decorator";
import { CONSOLE_RATE_LIMIT_CLASS_KEY } from "../../src/console-rate-limit/console-rate-limit.decorator";
import { coveredTarget } from "../../src/platform-support-sessions/support-session.coverage";

let actorLabel: ValidateFunction;

beforeAll(() => {
  const found = loadOpenApiContracts().find((c) => c.id === "audit.openapi");
  if (!found) throw new Error("audit.openapi is not loaded");
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(found.document as object, "audit");
  actorLabel = ajv.compile({
    $ref: "audit#/components/schemas/PlatformAuditEvent/properties/actor_label",
  });
});

describe("maskActorLabel (RT-431 D5)", () => {
  it.each([
    ["alice@example.com", "a***@example.com"],
    ["a@x", "a***@x"],
    ["first.last+tag@sub.example.co", "f***@sub.example.co"],
    ["a@b@example.com", "a***@example.com"],
    ["\u{1F600}x@example.com", "\u{1F600}***@example.com"],
    ["@example.com", "***@example.com"],
  ])("masks %s as %s", (stored, masked) => {
    expect(maskActorLabel(stored)).toBe(masked);
    expect(actorLabel(masked)).toBe(true);
  });

  it.each([["platform_support"], ["system"], [""]])("returns %p as stored", (label) => {
    expect(maskActorLabel(label)).toBe(label);
    expect(actorLabel(label)).toBe(true);
  });

  it("keeps a null label null", () => {
    expect(maskActorLabel(null)).toBeNull();
  });

  it("never returns the local part beyond its first code point", () => {
    const masked = maskActorLabel("secretname@example.com")!;
    expect(masked).not.toContain("ecretname");
  });
});

describe("PlatformAuditQuerySchema", () => {
  it("defaults limit to 50 and accepts the closed filter set", () => {
    const parsed = PlatformAuditQuerySchema.parse({
      action: "auth.signin.",
      kind: "change",
      actor_user_id: "0192f0a0-0000-7000-8000-000000000002",
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-21T00:00:00Z",
    });
    expect(parsed.limit).toBe(50);
    expect(parsed.from).toBeInstanceOf(Date);
  });

  it("decodes a cursor", () => {
    const at = new Date("2026-10-21T09:00:00.123Z");
    const id = "0192f0a0-0000-7000-8000-000000000001";
    expect(PlatformAuditQuerySchema.parse({ cursor: encodeCursor(at, id) }).cursor).toEqual({
      occurredAt: at,
      id,
    });
  });

  it.each([
    ["tenant_id", { tenant_id: "0192f0a0-0000-7000-8000-000000000009" }],
    ["store_id", { store_id: "0192f0a0-0000-7000-8000-000000000009" }],
    ["an unknown key", { foo: "bar" }],
    ["an unknown kind", { kind: "other" }],
    ["limit 0", { limit: "0" }],
    ["limit 201", { limit: "201" }],
    ["a non-integer limit", { limit: "1.5" }],
    ["a non-UUID actor", { actor_user_id: "nope" }],
    ["a malformed date", { from: "yesterday" }],
    ["a malformed cursor", { cursor: "!!" }],
    ["an empty action", { action: "" }],
  ])("refuses %s", (_name, query) => {
    expect(PlatformAuditQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("PlatformAuditController wiring", () => {
  const handler = PlatformAuditController.prototype.listPlatformAuditEvents;

  function execCtx(): ExecutionContext {
    return {
      getClass: () => PlatformAuditController,
      getHandler: () => handler,
    } as unknown as ExecutionContext;
  }

  it("runs the cookie-only guard, then the platform-admin guard", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformAuditController)).toEqual([
      SessionOnlyAdminGuard,
      PlatformAdminGuard,
    ]);
  });

  it("is not covered by RT-414 support-session enforcement", () => {
    expect(coveredTarget(execCtx())).toBeNull();
  });

  it("is not itself audited", () => {
    expect(Reflect.getMetadata(AUDITABLE_KEY, handler)).toBeUndefined();
  });

  it("carries the expensiveRead console rate-limit class", () => {
    expect(Reflect.getMetadata(CONSOLE_RATE_LIMIT_CLASS_KEY, handler)).toBe("expensiveRead");
  });
});
