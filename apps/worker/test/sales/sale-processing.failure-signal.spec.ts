/**
 * RT-457 (RT-447 F02b) — a failed sale-processing attempt is visible.
 *
 * Before RT-457 the processor was wired without a logger and no metric
 * counted its failures, so a sale whose job ran out of retries left no trace.
 * Now every failed attempt logs identifiers + the error class (never the
 * message or a row) and counts under worker_processing_failure_total, and the
 * module factory wires a real logger.
 */
import type { Pool } from "pg";

import * as metrics from "../../src/observability/metrics/worker.metrics";
import { SaleProcessingProcessor } from "../../src/sales/sale-processing.processor";
import { saleProcessingProcessorProviderFactory } from "../../src/worker.module";

const JOB = {
  saleId: "5a1e0000-0000-7000-8000-0000000000d1",
  tenantId: "5a1e0000-0000-7000-8000-0000000000a1",
  storeId: "5a1e0000-0000-7000-8000-0000000000b1",
  correlationId: null,
};

/** A pool whose connect fails the way an unreachable database does. */
const downPool = {
  connect: async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=secret");
  },
} as unknown as Pool;

afterEach(() => jest.restoreAllMocks());

describe("SaleProcessingProcessor failure signal (RT-457)", () => {
  it("logs ids + error class and counts the failed attempt", async () => {
    const counted = jest.spyOn(metrics, "recordWorkerProcessingFailure");
    const error = jest.fn();

    await expect(new SaleProcessingProcessor(downPool, { error }).process(JOB)).rejects.toThrow();

    expect(counted).toHaveBeenCalledWith({ job_name: "sale-processing", error_class: "UnknownError" });
    expect(error).toHaveBeenCalledTimes(1);
    const [fields] = error.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ sale_id: JOB.saleId, tenant_id: JOB.tenantId, error_class: "Error" });
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  });

  it("is wired with a logger by the module factory", () => {
    const processor = saleProcessingProcessorProviderFactory({ pool: downPool } as never);
    expect((processor as unknown as { logger?: unknown }).logger).toBeDefined();
  });
});
