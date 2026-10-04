/**
 * RT-180 — the reconciliation run-history cursor `<startedAtISO>|<runId>`.
 *
 * A shape-valid token with an out-of-range timestamp (Feb 30, month 13, year
 * 0000, ...) used to pass the DTO and fail at `$2::timestamptz` with a 500. The
 * DTO now requires a real calendar instant and a real UUID, and the contract
 * declares the same rule as a pattern. This spec pins both, and that they agree
 * on every month/day combination across leap, non-leap and century years.
 *
 * Unit only (no app boot, no DB).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { load } from "js-yaml";

import { SyncOpsRunListQuerySchema } from "../../../src/catalog/erpnext-sync-ops/dto/sync-ops-query.dto";

const RUN_ID = "0a000000-0000-7000-8000-00000e0517f1";

function accepts(cursor: string): boolean {
  return SyncOpsRunListQuerySchema.safeParse({ cursor }).success;
}

/** Zero-padded two-digit strings from `from` to `to`, inclusive. */
function range(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => String(from + i).padStart(2, "0"));
}

function contractPattern(): RegExp {
  const file = resolve(
    __dirname, "..", "..", "..", "..", "..",
    "packages", "contracts", "openapi", "erpnext-sync-ops", "console-sync-ops.yaml",
  );
  const doc = load(readFileSync(file, "utf8")) as {
    components: { parameters: Record<string, { schema: { pattern?: string } }> };
  };
  const pattern = doc.components.parameters["RunCursor"]?.schema.pattern;
  if (!pattern) throw new Error("RunCursor has no declared pattern");
  return new RegExp(pattern);
}

describe("RT-180 run cursor DTO — accepts server-issued cursors", () => {
  it.each([
    `2026-10-04T12:34:56.789Z|${RUN_ID}`,
    `2000-02-29T00:00:00.000Z|${RUN_ID}`,
    `2024-02-29T23:59:59.999Z|${RUN_ID}`,
    `0001-01-01T00:00:00.000Z|${RUN_ID}`,
    `9999-12-31T23:59:59.999Z|${RUN_ID.toUpperCase()}`,
  ])("accepts %s", (cursor) => {
    expect(accepts(cursor)).toBe(true);
  });

  it("accepts a cursor produced by Date#toISOString (the read-model's nextCursor)", () => {
    expect(accepts(`${new Date().toISOString()}|${RUN_ID}`)).toBe(true);
  });

  it("leaves the cursor optional", () => {
    expect(SyncOpsRunListQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe("RT-180 run cursor DTO — rejects out-of-range or malformed tokens", () => {
  it.each([
    ["Feb 30 (the RT-180 report)", `2000-02-30T00:00:00Z|${RUN_ID}`],
    ["all-zero date, short time (the RT-180 report)", `0000-00-00T0Z|${RUN_ID}`],
    ["Feb 30 at ms precision", `2000-02-30T00:00:00.000Z|${RUN_ID}`],
    ["Feb 29 in a non-leap century", `1900-02-29T00:00:00.000Z|${RUN_ID}`],
    ["Feb 29 in a non-leap year", `2023-02-29T00:00:00.000Z|${RUN_ID}`],
    ["Apr 31", `2024-04-31T00:00:00.000Z|${RUN_ID}`],
    ["month 13", `2024-13-01T00:00:00.000Z|${RUN_ID}`],
    ["month 00", `2024-00-10T00:00:00.000Z|${RUN_ID}`],
    ["day 00", `2024-01-00T00:00:00.000Z|${RUN_ID}`],
    ["year 0000", `0000-01-01T00:00:00.000Z|${RUN_ID}`],
    ["hour 24", `2024-01-01T24:00:00.000Z|${RUN_ID}`],
    ["minute 60", `2024-01-01T00:60:00.000Z|${RUN_ID}`],
    ["leap second", `2024-01-01T23:59:60.000Z|${RUN_ID}`],
    ["no milliseconds", `2024-01-01T00:00:00Z|${RUN_ID}`],
    ["microseconds", `2024-01-01T00:00:00.000000Z|${RUN_ID}`],
    ["offset instead of Z", `2024-01-01T00:00:00.000+00:00|${RUN_ID}`],
    ["36 dashes as the id", `2024-01-01T00:00:00.000Z|${"-".repeat(36)}`],
    ["id with misplaced dashes", `2024-01-01T00:00:00.000Z|0a0000000-000-7000-8000-00000e0517f1`],
    ["non-hex id", `2024-01-01T00:00:00.000Z|0a000000-0000-7000-8000-00000e0517fg`],
    ["missing id", "2024-01-01T00:00:00.000Z|"],
    ["timestamp only", "2024-01-01T00:00:00.000Z"],
    ["numeric token", "12345"],
    ["empty", ""],
  ])("rejects %s", (_label, cursor) => {
    expect(accepts(cursor)).toBe(false);
  });
});

describe("RT-180 run cursor — contract pattern matches the DTO", () => {
  const pattern = contractPattern();

  it("the contract pattern accepts a server-issued cursor and rejects the RT-180 tokens", () => {
    expect(pattern.test(`${new Date().toISOString()}|${RUN_ID}`)).toBe(true);
    expect(pattern.test(`2000-02-30T00:00:00Z|${RUN_ID}`)).toBe(false);
    expect(pattern.test(`0000-00-00T0Z|${RUN_ID}`)).toBe(false);
  });

  it("agrees with the DTO on every month/day across leap, non-leap and century years", () => {
    const years = ["0000", "0001", "0004", "0100", "0400", "1900", "2000", "2023", "2024", "2100", "9999"];
    const months = range(0, 13);
    const days = range(0, 32);
    const times = ["00:00:00.000", "23:59:59.999", "24:00:00.000", "12:60:00.000"];
    const cursors = years.flatMap((year) =>
      months.flatMap((mm) =>
        days.flatMap((dd) => times.map((time) => `${year}-${mm}-${dd}T${time}Z|${RUN_ID}`)),
      ),
    );
    expect(cursors).toHaveLength(years.length * 14 * 33 * times.length);
    const disagreements = cursors.filter((cursor) => pattern.test(cursor) !== accepts(cursor));
    expect(disagreements).toEqual([]);
  });
});
