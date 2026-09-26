/**
 * Teardown race: pg-pool's end() resolves once idle clients are removed from
 * its bookkeeping, before their sockets close. Stopping the container right
 * after can deliver FATAL 57P01 to a closing client, which the pool re-emits
 * as 'error'. With no listener, Node throws "Unhandled error." and the suite
 * fails after its tests passed.
 */
import { Pool } from "pg";

import { endPoolQuietly, guardPool, isShutdownError } from "./postgres-container";

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

describe("shutdown error filter", () => {
  const pgError = (code: string, message = "server error") =>
    Object.assign(new Error(message), { code });

  it.each(["57P01", "57P02", "57P03"])("treats SQLSTATE %s as a shutdown error", (code) => {
    expect(isShutdownError(pgError(code))).toBe(true);
  });

  it.each(["Connection terminated", "Connection terminated unexpectedly"])(
    "treats pg's %j as a shutdown error",
    (message) => {
      expect(isShutdownError(new Error(message))).toBe(true);
    },
  );

  it("does not treat other errors as shutdown errors", () => {
    expect(isShutdownError(pgError("28P01", "password authentication failed"))).toBe(false);
    expect(isShutdownError(pgError("57014", "canceling statement"))).toBe(false);
    expect(isShutdownError(new Error("boom"))).toBe(false);
    expect(isShutdownError("57P01")).toBe(false);
  });

  it("a guarded pool absorbs shutdown errors but rethrows anything else", async () => {
    const pool = guardPool(new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/x" }));
    try {
      expect(() => pool.emit("error", pgError("57P01"))).not.toThrow();
      const other = pgError("XX000", "internal error");
      expect(() => pool.emit("error", other)).toThrow(other);
    } finally {
      await pool.end();
    }
  });

  it("guardPool attaches its listener only once", async () => {
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/x" });
    guardPool(guardPool(pool));
    expect(pool.listenerCount("error")).toBe(1);
    await pool.end();
  });
});
