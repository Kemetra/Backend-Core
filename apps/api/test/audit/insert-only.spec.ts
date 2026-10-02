/**
 * T237 — Audit insert-only proof.
 *
 * Proves that audit events are immutable at the application layer.
 * Three proof layers, each with a different scope:
 *
 * Layer A — TypeScript interface (compile-time)
 * -----------------------------------------------
 * `AuditRepository` exposes exactly one method: `listPage`. No `update`,
 * `delete`, `upsert`, or `patch` method exists. This is a structural proof:
 * the test constructs an object satisfying the interface, then inspects the
 * keys at runtime to confirm no mutation surface is reachable.
 *
 * Layer B — HTTP surface (controller + service)
 * -----------------------------------------------
 * `AuditController` exposes only `GET /api/v1/audit/events`. There are no
 * `POST`, `PUT`, `PATCH`, or `DELETE` routes for audit events. The tests
 * verify this via NestJS reflect-metadata (same mechanism NestJS itself uses
 * to discover routes) — no app instantiation required; metadata is on the
 * class/prototype and accessible immediately after import.
 *
 * `AuditService` exposes only `list()`. No mutation methods exist at the
 * service layer either.
 *
 * Layer C — DB boundary (RT-133)
 * ------------------------------
 * Migration 0034_audit_events_append_only refuses UPDATE / DELETE / TRUNCATE
 * on audit_events for every role — including `app_test` with full grants and
 * the table owner — apart from one-time retention marking and the schema's
 * ON DELETE SET NULL. Real PostgreSQL tests below.
 *
 * Out-of-scope boundary
 * ---------------------
 * `apps/worker/src/audit/` (the `AuditWorker` / `AuditWorkerService`) is
 * NOT covered here. The worker is the only legitimate INSERT path for the
 * application layer (it writes rows via `BullMQ` job consumption). Its
 * insert-only posture is separately governed by the job schema
 * (`AuditJobPayload` is INSERT-only by design: no `id` field that would
 * imply update semantics).
 */
import "reflect-metadata";

import type { Pool, PoolClient } from "pg";

import { AuditController } from "../../src/audit/audit.controller";
import { AuditService } from "../../src/audit/audit.service";
import {
  AUDIT_REPOSITORY,
  type AuditRepository,
  type AuditEventRecord,
  type ListPageInput,
} from "../../src/audit/audit.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Layer A — TypeScript interface structural proof
// ---------------------------------------------------------------------------

describe("AuditRepository interface — mutation surface", () => {
  it("has exactly one method: listPage", () => {
    // Construct a minimal conforming implementation and verify its keys.
    // If a future developer adds `update` / `delete` to the interface,
    // TypeScript will enforce it on implementors; this runtime check pins
    // that the minimal-satisfying shape has exactly one entry.
    const implementation: AuditRepository = {
      listPage: async (_input: ListPageInput): Promise<AuditEventRecord[]> => [],
    };

    const methods = Object.keys(implementation);
    expect(methods).toEqual(["listPage"]);
  });

  it("does not expose update, delete, upsert, patch, save, create, or insert on AuditRepository", () => {
    const implementation: AuditRepository = {
      listPage: async (_input: ListPageInput): Promise<AuditEventRecord[]> => [],
    };

    expect(implementation).not.toHaveProperty("update");
    expect(implementation).not.toHaveProperty("delete");
    expect(implementation).not.toHaveProperty("upsert");
    expect(implementation).not.toHaveProperty("patch");
    expect(implementation).not.toHaveProperty("save");
    expect(implementation).not.toHaveProperty("create");
    expect(implementation).not.toHaveProperty("insert");
  });

  it("AuditRepository type is assignable from a read-only object (structural type safety)", () => {
    // TypeScript structural typing: an object with ONLY listPage satisfies
    // the interface. If the interface later adds a mutation method, this
    // `satisfies` expression will produce a compile error.
    const readOnlyImpl = {
      listPage: async (_input: ListPageInput): Promise<AuditEventRecord[]> => [],
    } satisfies AuditRepository;

    expect(typeof readOnlyImpl.listPage).toBe("function");
  });

  it("AUDIT_REPOSITORY DI token is a string constant (prevents accidental class-token re-binding)", () => {
    // String DI tokens require explicit binding. A class token would allow
    // any class with a compatible shape to satisfy the injection, including
    // a mutation-capable implementation. The string token closes that gap.
    expect(typeof AUDIT_REPOSITORY).toBe("string");
    expect(AUDIT_REPOSITORY).toBe("AUDIT_REPOSITORY");
  });
});

// ---------------------------------------------------------------------------
// Layer B — HTTP surface proof (controller + service)
// ---------------------------------------------------------------------------

describe("AuditService — mutation surface", () => {
  it("exposes only list() — no mutation methods on prototype", () => {
    const serviceProto = AuditService.prototype;
    const protoMethods = Object.getOwnPropertyNames(serviceProto).filter(
      (name) =>
        name !== "constructor" &&
        typeof (serviceProto as unknown as Record<string, unknown>)[name] === "function",
    );

    expect(protoMethods).toContain("list");
    expect(protoMethods).not.toContain("update");
    expect(protoMethods).not.toContain("delete");
    expect(protoMethods).not.toContain("upsert");
    expect(protoMethods).not.toContain("insert");
    expect(protoMethods).not.toContain("create");
  });
});

describe("AuditController — HTTP surface (metadata inspection, no app instantiation)", () => {
  it("has exactly one handler: listAuditEvents", () => {
    // Verify the only handler on AuditController is the GET events handler.
    const controllerMethods = Object.getOwnPropertyNames(
      AuditController.prototype,
    ).filter((name) => name !== "constructor");

    expect(controllerMethods).toContain("listAuditEvents");
    expect(controllerMethods.length).toBe(1);
  });

  it("listAuditEvents carries HTTP method = GET (RequestMethod.GET = 0)", () => {
    // NestJS stores the RequestMethod enum value in the 'method' metadata key.
    // RequestMethod enum: GET=0, POST=1, PUT=2, DELETE=5, PATCH=4.
    const httpMethod = Reflect.getMetadata(
      "method",
      AuditController.prototype.listAuditEvents,
    ) as number;

    expect(httpMethod).toBe(0); // RequestMethod.GET
  });

  it("no mutation HTTP method decorators exist on AuditController prototype", () => {
    // RequestMethod: GET=0, POST=1, PUT=2, PATCH=4, DELETE=5.
    const MUTATION_METHODS = new Set([1, 2, 4, 5]);

    const methods = Object.getOwnPropertyNames(AuditController.prototype).filter(
      (name) => name !== "constructor",
    );

    for (const method of methods) {
      const httpMethod = Reflect.getMetadata(
        "method",
        (AuditController.prototype as unknown as Record<string, object>)[method]!,
      ) as number | undefined;
      if (httpMethod !== undefined) {
        expect(MUTATION_METHODS.has(httpMethod)).toBe(false);
      }
    }
  });

  it("controller path prefix is api/v1/audit (scoped, not a wildcard)", () => {
    const controllerPath = Reflect.getMetadata("path", AuditController) as string;
    expect(controllerPath).toBe("api/v1/audit");
  });

  it("listAuditEvents handler path is 'events'", () => {
    const handlerPath = Reflect.getMetadata(
      "path",
      AuditController.prototype.listAuditEvents,
    ) as string;
    expect(handlerPath).toBe("events");
  });
});

// ---------------------------------------------------------------------------
// Layer C — DB-level enforcement (RT-133, migration 0034)
// ---------------------------------------------------------------------------
//
// Until RT-133, insert-only held only at the application layer: the RLS
// policy and `applyAllUpAndCreateAppRole`'s full grants let a same-tenant
// UPDATE succeed (RT-120 C-1). Migration 0034_audit_events_append_only adds
// row and TRUNCATE triggers that refuse UPDATE / DELETE / TRUNCATE for every
// role, with two narrow carve-outs: one-time retention marking and the
// schema's own ON DELETE SET NULL. The full matrix lives in
// packages/db/__tests__/migration/0034-audit-append-only.spec.ts; this
// layer proves it through this app's own role setup.

let env: PgTestEnv | null = null;
let dockerSkipped = false;
const LAYER_C_TENANT = "0a000000-0000-7000-8000-000000134c01";
const LAYER_C_ROW = "0a000000-0000-7000-8000-000000134c02";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt133-layer-c', 'Layer C')`,
      [LAYER_C_TENANT],
    );
    await env.admin.query(
      `INSERT INTO audit_events (id, tenant_id, action) VALUES ($1, $2, 'rt133.layer_c')`,
      [LAYER_C_ROW, LAYER_C_TENANT],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[insert-only.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const APPEND_ONLY = { code: "42501", message: expect.stringMatching(/append-only/) };

describe("DB-level insert-only enforcement (RT-133)", () => {
  it("app_test (NOBYPASSRLS, full grants) can INSERT but not UPDATE or DELETE in its own tenant", async () => {
    if (dockerSkipped || !env) return;
    await withTenant(env.app, LAYER_C_TENANT, async (client) => {
      await client.query(
        `INSERT INTO audit_events (id, tenant_id, action) VALUES (gen_random_uuid(), $1, 'rt133.insert')`,
        [LAYER_C_TENANT],
      );
    });
    await expect(
      withTenant(env.app, LAYER_C_TENANT, (client) =>
        client.query(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [LAYER_C_ROW]),
      ),
    ).rejects.toMatchObject(APPEND_ONLY);
    await expect(
      withTenant(env.app, LAYER_C_TENANT, (client) =>
        client.query(`DELETE FROM audit_events WHERE id = $1`, [LAYER_C_ROW]),
      ),
    ).rejects.toMatchObject(APPEND_ONLY);
  });

  it("even the admin (owner) pool cannot UPDATE or DELETE audit_events", async () => {
    if (dockerSkipped || !env) return;
    await expect(
      env.admin.query(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [LAYER_C_ROW]),
    ).rejects.toMatchObject(APPEND_ONLY);
    await expect(
      env.admin.query(`DELETE FROM audit_events WHERE id = $1`, [LAYER_C_ROW]),
    ).rejects.toMatchObject(APPEND_ONLY);
    const r = await env.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE id = $1`,
      [LAYER_C_ROW],
    );
    expect(r.rows[0]?.action).toBe("rt133.layer_c");
  });
});

async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
