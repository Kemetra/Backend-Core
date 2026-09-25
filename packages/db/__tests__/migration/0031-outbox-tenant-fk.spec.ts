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

    const dropNotNull = up.search(/ALTER COLUMN tenant_id DROP NOT NULL/i);
    const rewriteNil = up.search(
      new RegExp(
        `SET tenant_id = NULL[\\s\\S]*'${NIL_TENANT_ID}'::uuid`,
        "i",
      ),
    );
    const addFk = up.search(/ADD CONSTRAINT outbox_events_tenant_id_fk/i);
    expect(dropNotNull).toBeGreaterThan(-1);
    expect(rewriteNil).toBeGreaterThan(dropNotNull);
    expect(addFk).toBeGreaterThan(rewriteNil);
  });

  it("down restores NOT NULL only after nil rows are rewritten and the FK is gone", () => {
    const down = readFileSync(DOWN_PATH, "utf8");

    expect(down).toMatch(
      /ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_tenant_id_fk/i,
    );
    expect(down).toMatch(
      /ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_id_not_nil/i,
    );
    const dropFk = down.search(/DROP CONSTRAINT IF EXISTS outbox_events_tenant_id_fk/i);
    const rewriteNull = down.search(
      new RegExp(
        `SET tenant_id = '${NIL_TENANT_ID}'::uuid[\\s\\S]*tenant_id IS NULL`,
        "i",
      ),
    );
    const setNotNull = down.search(/ALTER COLUMN tenant_id SET NOT NULL/i);
    expect(rewriteNull).toBeGreaterThan(dropFk);
    expect(setNotNull).toBeGreaterThan(rewriteNull);
    expect(down).not.toMatch(/DROP TABLE/i);
    expect(down).not.toMatch(/DROP COLUMN/i);
  });
});
