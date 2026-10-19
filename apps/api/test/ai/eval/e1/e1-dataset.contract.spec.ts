/**
 * RT-648 — the pinned `e1-gold/1` dataset (RT-647 §6).
 *
 * Fixtures only: every body is synthetic, built by a versioned generator and
 * validated here against the real OpenAPI schemas on `main`. The dataset hash
 * is pinned as a literal: a change to a case, a body or a gold label is a new
 * dataset version, never a silent edit.
 */
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { compareCodeUnits } from "../../../../src/common/compare-code-units";
import { allContracts, contractDocument } from "../../../_helpers/openapi-contract";
import { E1_CASES, E1_DATASET_VERSION, materialize, worldOf } from "./e1.cases";
import { datasetHash } from "./e1.canonical";
import { ALLOWED_OPS, DROPPED_PII_STRINGS } from "./e1.pack-builder";

const PINNED_DATASET_SHA256 = "72469ce2e2c176e0ffee93b6d15597635a55d45db4d6ae42b9c4e9b55f3620ab";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const CONTRACTS = allContracts();
const SCHEMA_SOURCES = {
  consoleGetSale: { contract: "console-sales.openapi", schema: "ConsoleSaleDetail" },
  consoleGetSaleSyncStatus: { contract: "sale-sync-ops", schema: "SaleSyncStatus" },
  consoleGetSaleAuditTimeline: { contract: "sale-sync-ops", schema: "SaleAuditTimeline" },
  consoleListPostingBacklog: { contract: "console-sync-ops", schema: "PostingBacklogPage" },
} as const;

function validator(op: keyof typeof SCHEMA_SOURCES): ValidateFunction {
  const { contract, schema } = SCHEMA_SOURCES[op];
  const id = `urn:e1:${contract}`;
  if (!ajv.getSchema(id)) ajv.addSchema(contractDocument(CONTRACTS, contract) as object, id);
  const found = ajv.getSchema(`${id}#/components/schemas/${schema}`);
  if (!found) throw new Error(`ajv cannot resolve ${contract}#${schema}`);
  return found;
}

type PathItem = Record<string, { operationId?: string } | undefined>;

/** operationId -> HTTP method, across every contract on main. */
function methodsByOperationId(): Map<string, string> {
  const pairs = CONTRACTS.flatMap((contract) => {
    const paths = (contract.document as { paths?: Record<string, PathItem> }).paths ?? {};
    return Object.values(paths).flatMap((item) =>
      Object.entries(item).flatMap(([method, op]): [string, string][] => (op?.operationId ? [[op.operationId, method]] : [])),
    );
  });
  return new Map(pairs);
}

describe("e1-gold/1 dataset", () => {
  it("has 40 cases with unique ids and version e1-gold/1", () => {
    expect(E1_DATASET_VERSION).toBe("e1-gold/1");
    expect(E1_CASES).toHaveLength(40);
    expect(new Set(E1_CASES.map((c) => c.id)).size).toBe(40);
  });

  it("pins the content hash of cases, frozen packs and gold labels", () => {
    expect(datasetHash()).toBe(PINNED_DATASET_SHA256);
  });

  it("builds every contract body so that it conforms to the OpenAPI schemas on main", () => {
    const failures: string[] = [];
    let validated = 0;
    for (const c of E1_CASES) {
      const world = worldOf(c);
      const reads = [
        ["consoleGetSale", world.r1],
        ["consoleGetSaleSyncStatus", world.r2],
        ["consoleGetSaleAuditTimeline", world.r3],
        ...world.r4.map((page) => ["consoleListPostingBacklog", page] as const),
      ] as const;
      for (const [op, read] of reads) {
        if (read.status !== 200) continue;
        const validate = validator(op);
        validated += 1;
        if (!validate(read.body)) {
          failures.push(`${c.id} ${op}: ${ajv.errorsText(validate.errors)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(validated).toBeGreaterThan(100);
  });

  it("only reads the four allowlisted GET operations, each declared as GET in a contract", () => {
    expect([...ALLOWED_OPS].sort(compareCodeUnits)).toEqual(Object.keys(SCHEMA_SOURCES).sort(compareCodeUnits));
    const methodOf = methodsByOperationId();
    for (const op of ALLOWED_OPS) expect(methodOf.get(op)).toBe("get");
  });

  it("covers every syncStatus, ERP posting state, rejection category and negative scope", () => {
    const tags = new Set(E1_CASES.flatMap((c) => c.tags));
    const required = [
      "sync:captured", "sync:synced", "sync:failed-retryable", "sync:failed-needs-repair",
      "sync:repair-resolved-history", "erp:posted", "erp:pending", "erp:failed", "erp:unknown",
      "reason:validation", "reason:closed_period", "reason:unmapped_item", "reason:unmapped_store",
      "reason:unmapped_account", "reason:retry_budget_exhausted", "reason:reconciliation_required",
      "reason:other", "reason:null", "reason:unrecognised",
      "reversal:posted", "reversal:pending", "reversal:failed", "reversal:unknown", "returns:present",
      "trap:no-dead-letter≠posted", "trap:synced≠posted", "trap:unknown≠not-posted",
      "trap:never-healthy-on-unknown", "trap:kind-collision", "trap:reconciliation_required≠posted",
      "evidence:walk-capped", "evidence:inconsistent", "evidence:read-failure",
      "scope:in-scope", "scope:out-of-scope-store", "scope:cross-tenant",
      "scope:role-store_manager", "scope:device-credential",
      "adv:injection-en", "adv:injection-ar", "adv:rtl-override", "adv:markdown-link",
      "adv:free-text-category", "adv:action-request", "tz:store-non-utc", "tz:business-date-boundary",
    ];
    expect(required.filter((tag) => !tags.has(tag))).toEqual([]);
  });

  it("freezes packs that carry only allowlisted fields and none of the dropped PII", () => {
    for (const c of E1_CASES) {
      for (const lang of ["en", "ar"] as const) {
        const { pack } = materialize(c, lang);
        const text = JSON.stringify(pack);
        for (const dropped of DROPPED_PII_STRINGS) expect(text).not.toContain(dropped);
        expect(Object.keys(pack).sort(compareCodeUnits)).toEqual([
          "assembled_at", "backlog_match", "known_gaps", "max_read_skew_ms", "pack_id", "question",
          "reads", "schema_version", "scope", "untrusted_text",
        ]);
      }
    }
  });

  it("assigns every case at least one gate and a stable EN and AR question", () => {
    for (const c of E1_CASES) {
      expect(c.gates.length).toBeGreaterThan(0);
      expect(c.question.en.length).toBeGreaterThan(0);
      expect(c.question.ar.length).toBeGreaterThan(0);
    }
  });
});
