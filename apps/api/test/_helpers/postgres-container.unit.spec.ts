/**
 * Teardown race: pg-pool's end() resolves once idle clients are removed from
 * its bookkeeping, before their sockets close. Stopping the container right
 * after can deliver FATAL 57P01 to a closing client, which the pool re-emits
 * as 'error'. With no listener, Node throws "Unhandled error." and the suite
 * fails after its tests passed.
 */
import { Pool } from "pg";

import { endPoolQuietly } from "./postgres-container";

describe("endPoolQuietly", () => {
  it("absorbs a pool error emitted after end() resolves", async () => {
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/x" });
    await endPoolQuietly(pool);
    const late = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
    });
    expect(() => pool.emit("error", late)).not.toThrow();
  });

  it("does not throw when the pool was already ended", async () => {
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/x" });
    await pool.end();
    await expect(endPoolQuietly(pool)).resolves.toBeUndefined();
  });
});
