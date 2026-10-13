/**
 * RT-457 — SaleRedriveProcessor orchestration (no Docker).
 *
 * The SQL side is proven against real Postgres in
 * sale-redrive.integration.spec.ts; this spec pins the sweep's control flow:
 * every tenant is swept, one failing sale or tenant does not stop the rest,
 * an incomplete pass fails the job (so BullMQ retries it), the counter gets the
 * re-driven totals, and a stranded sale is handed to the processor with its
 * own tenant and store.
 */
import * as metrics from "../../src/observability/metrics/worker.metrics";
import type { SaleProcessingJob, SaleProcessingResult } from "../../src/sales/sale-processing.processor";
import {
  SALE_REDRIVE_JOB_NAME,
  SaleRedriveIncompleteError,
  SaleRedriveProcessor,
  UnknownSaleRedriveJobError,
  type SaleRedriveLogLine,
} from "../../src/sales/sale-redrive.processor";
import type {
  ReemittedIntents,
  SaleRedriveRepository,
  StrandedSale,
} from "../../src/sales/sale-redrive.repository";

class FakeRepo implements SaleRedriveRepository {
  readonly reemitCalls: string[] = [];
  constructor(
    private readonly stranded: Record<string, StrandedSale[]>,
    private readonly reemitted: Record<string, ReemittedIntents | Error>,
  ) {}

  async listTenantIds(): Promise<string[]> {
    return Object.keys(this.stranded);
  }

  async findUnprocessedSales(tenantId: string): Promise<StrandedSale[]> {
    return this.stranded[tenantId] ?? [];
  }

  async reemitMissingIntents(tenantId: string): Promise<ReemittedIntents> {
    this.reemitCalls.push(tenantId);
    const r = this.reemitted[tenantId] ?? { salePost: 0, reversal: 0 };
    if (r instanceof Error) throw r;
    return r;
  }
}

class FakeProcessing {
  readonly jobs: SaleProcessingJob[] = [];
  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}

  async process(job: SaleProcessingJob): Promise<SaleProcessingResult> {
    this.jobs.push(job);
    if (this.failing.has(job.saleId)) throw new Error("db down");
    return { saleId: job.saleId, mismatchFlag: false, processedAt: "2026-10-13T00:00:00.000Z", applied: true };
  }
}

const WINDOW = { minAgeMs: 900_000, maxAgeMs: 604_800_000 };
const S1 = { saleId: "s1", storeId: "st1" };
const S2 = { saleId: "s2", storeId: "st2" };

function run(repo: FakeRepo, processing: FakeProcessing, lines: SaleRedriveLogLine[] = []) {
  return new SaleRedriveProcessor(repo, processing, WINDOW, (l) => lines.push(l)).process(
    SALE_REDRIVE_JOB_NAME,
    {},
  );
}

afterEach(() => jest.restoreAllMocks());

describe("SaleRedriveProcessor (RT-457)", () => {
  it("processes each stranded sale under its own tenant and re-emits missing intents", async () => {
    const counted = jest.spyOn(metrics, "recordSaleRedrive");
    const repo = new FakeRepo({ tA: [S1], tB: [S2] }, { tA: { salePost: 2, reversal: 1 } });
    const processing = new FakeProcessing();

    const result = await run(repo, processing);

    expect(processing.jobs).toEqual([
      { saleId: "s1", storeId: "st1", tenantId: "tA", correlationId: null },
      { saleId: "s2", storeId: "st2", tenantId: "tB", correlationId: null },
    ]);
    expect(repo.reemitCalls).toEqual(["tA", "tB"]);
    expect(result).toEqual({ tenants: 2, salesProcessed: 2, salePostIntents: 2, reversalIntents: 1, failures: 0 });
    expect(counted).toHaveBeenCalledWith("sale_processing", 2);
    expect(counted).toHaveBeenCalledWith("sale_post_intent", 2);
    expect(counted).toHaveBeenCalledWith("reversal_intent", 1);
  });

  it("keeps going past a failing sale and a failing tenant, then fails the job for a retry", async () => {
    const repo = new FakeRepo({ tA: [S1, S2], tB: [] }, { tA: new Error("boom") });
    const processing = new FakeProcessing(new Set(["s1"]));
    const lines: SaleRedriveLogLine[] = [];

    await expect(run(repo, processing, lines)).rejects.toBeInstanceOf(SaleRedriveIncompleteError);

    expect(processing.jobs.map((j) => j.saleId)).toEqual(["s1", "s2"]);
    expect(repo.reemitCalls).toEqual(["tA", "tB"]);
    const errors = lines.filter((l) => l["level"] === "error");
    expect(errors.map((l) => l["message"])).toEqual(["sale_redrive_failed", "tenant_redrive_failed"]);
    // Identifiers and the error class only: never the error message.
    expect(JSON.stringify(errors)).not.toContain("db down");
    expect(JSON.stringify(errors)).not.toContain("boom");
  });

  it("refuses an unknown job name", async () => {
    await expect(
      new SaleRedriveProcessor(new FakeRepo({}, {}), new FakeProcessing(), WINDOW, () => undefined).process(
        "other",
        {},
      ),
    ).rejects.toBeInstanceOf(UnknownSaleRedriveJobError);
  });
});
