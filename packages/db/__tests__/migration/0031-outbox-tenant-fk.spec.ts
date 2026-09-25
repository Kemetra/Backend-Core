/**
 * #616 — outbox tenant FK and nil-tenant CHECK.
 *
 * Reads `packages/db/drizzle/0031_outbox_tenant_fk.sql` (+ `.down.sql`) and
 * asserts the constraint text. Does not need Docker. The file is absent
 * until the migration lands, so this spec is the RED gate.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0031_outbox_tenant_fk.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0031_outbox_tenant_fk.down.sql");

const NIL_TENANT_ID = "00000000-0000-0000-0000-000000000000";

describe("0031 — outbox tenant FK and nil tenant id", () => {
  it("up adds the outbox tenant FK (ON DELETE RESTRICT) and rejects the nil tenant id", () => {
    const up = readFileSync(UP_PATH, "utf8");

    expect(up).toMatch(/outbox_events_tenant_id_fk/);
    expect(up).toMatch(
      /FOREIGN KEY \(tenant_id\)\s+REFERENCES tenants\(id\)\s+ON DELETE RESTRICT/i,
    );
    expect(up).not.toMatch(/ON DELETE CASCADE/i);
    expect(up).toMatch(/tenants_id_not_nil/);
    expect(up).toMatch(
      new RegExp(
        `CHECK\\s*\\(\\s*id\\s*<>\\s*'${NIL_TENANT_ID}'::uuid\\s*\\)`,
        "i",
      ),
    );
  });

  it("down drops only the constraints this migration added", () => {
    const down = readFileSync(DOWN_PATH, "utf8");

    expect(down).toMatch(
      /ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_tenant_id_fk/i,
    );
    expect(down).toMatch(
      /ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_id_not_nil/i,
    );
    expect(down).not.toMatch(/DROP TABLE/i);
    expect(down).not.toMatch(/DROP COLUMN/i);
    expect(down).not.toMatch(/NOT NULL/i);
  });
});
