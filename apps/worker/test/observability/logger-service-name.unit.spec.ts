/**
 * RT-684 (OBS-9 F-D) — worker log lines carry the OBS-1 service name
 * `backend-worker` (D4), matching the worker's OTel and Sentry service name.
 *
 * `createLogger` is wrapped so each logger the worker builds writes to a
 * capture buffer; the emitted `service` field is asserted. A source scan then
 * keeps any new literal service name in apps/worker/src on the same name.
 */
const loggedLines: string[] = [];
jest.mock("@data-pulse-2/shared", () => {
  const actual = jest.requireActual<typeof import("@data-pulse-2/shared")>("@data-pulse-2/shared");
  return {
    ...actual,
    createLogger: (opts: Parameters<typeof actual.createLogger>[0]) =>
      actual.createLogger({ ...opts, destination: { write: (line: string) => void loggedLines.push(line) } }),
  };
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkerFactory, WorkerLike } from "../../src/email/email.worker";
import type { SaleRedriveProcessor } from "../../src/sales/sale-redrive.processor";
import { SaleRedriveWorker } from "../../src/sales/sale-redrive.worker";

beforeEach(() => {
  loggedLines.length = 0;
});

describe("worker logger service name (RT-684)", () => {
  it("the sale re-drive worker logs as backend-worker", () => {
    let onError: ((err: Error) => void) | undefined;
    const fakeWorker = {
      on: (event: string, handler: (err: Error) => void) => {
        if (event === "error") onError = handler;
      },
      close: async () => undefined,
    } as unknown as WorkerLike;
    const factory = { create: () => fakeWorker } as unknown as WorkerFactory;

    new SaleRedriveWorker({} as SaleRedriveProcessor, factory).start();
    onError?.(new Error("probe"));

    expect(loggedLines).toHaveLength(1);
    expect(JSON.parse(loggedLines[0] ?? "{}")).toMatchObject({
      service: "backend-worker",
      component: "sales.sale-redrive.worker",
    });
  });

  it("every literal service name in apps/worker/src is backend-worker", () => {
    const root = join(__dirname, "..", "..", "src");
    const names = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        [...readFileSync(join(root, file), "utf8").matchAll(/\bservice:\s*"([^"]+)"/g)].map((m) => `${file}: ${m[1]}`),
      );

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((entry) => !entry.endsWith(": backend-worker"))).toEqual([]);
  });
});
