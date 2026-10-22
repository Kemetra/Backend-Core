/**
 * apps/api/test/catalog/sales/lifecycle/classification.spec.ts
 *
 * Slice 008-LIFECYCLE (T075) — data-lifecycle classification + retention guard
 * (SI-012 / gate D.3, Constitution §XIV).
 *
 * The four sale-fact entities (`sales`, `sale_lines`, `sale_voids`,
 * `sale_refunds`) are BUSINESS-CLASS data: catalog references, quantities, and
 * POS-reported totals only. They carry NO PII and NO payment/tender data in v1
 * (tender is deferred per gate A.5). Retention INHERITS the 001 long-horizon,
 * insert-only audit-retention posture for the immutable fact; right-to-erasure
 * TOMBSTONES any future PII field rather than deleting the fact row. The full
 * classification + retention prose is recorded in:
 *   - packages/db/drizzle/0012_sales.sql  (migration header, lines ~50-68)
 *   - specs/008-sales-transaction-capture/data-model.md  (§ "State & lifecycle")
 * — both landed in the [GATED] 008-SCHEMA slice; this slice adds the EXECUTABLE
 * guard only.
 *
 * This is a Docker-FREE introspection guard (mirrors
 * `schema/sales-schema-shape.spec.ts`): it reads the actual persisted column
 * inventory off the Drizzle table objects via `getTableConfig` and asserts it
 * is EXACTLY the recorded business-class allowlist — a tripwire, not a denylist.
 * If a later slice adds, removes, or renames a persisted column, set-equality
 * fails and forces a re-review (the SI-012 reclassification trigger). A
 * secondary collision-safe PII/payment denylist catches the common shapes a
 * future customer-reference / tender column would take.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the exports
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import * as fs from "node:fs";
import * as path from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  refundExecutions,
  saleApprovalUses,
  saleCreditReversals,
  saleCreditReversalTenders,
  saleLines,
  saleRefunds,
  saleReprints,
  saleResponsibilities,
  saleReturnLines,
  saleReturns,
  saleReturnTenders,
  saleTenders,
  sales,
  saleVoids,
} from "@data-pulse-2/db/schema";

function persistedColumns(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.columns.map((c) => (c as unknown as { name: string }).name).sort();
}

/**
 * The recorded BUSINESS-CLASS persisted-column inventory for each sale-fact
 * table. Every entry is a catalog reference, a quantity/amount, a POS-reported
 * total, server-owned provenance/processing state, a timestamp, or the acting
 * POS-device principal (`created_by` — an operational actor UUID, NOT customer
 * PII). NONE is a customer reference or a tender/payment field. This list IS
 * the machine-checked classification: changing it requires re-running SI-012.
 */
const BUSINESS_CLASS_COLUMNS: ReadonlyArray<{
  name: string;
  table: unknown;
  columns: string[];
}> = [
  {
    name: "sales",
    table: sales,
    columns: [
      "id",
      "tenant_id",
      "store_id",
      "currency_code",
      "pos_total",
      "occurred_at",
      "received_at",
      "business_date",
      "processed_at",
      "source_clock_at",
      "source_system",
      "external_id",
      "payload_hash",
      "mismatch_flag",
      "sync_status",
      "created_by",
      // RT-77 (0033): the server-resolved terminal (no PII) and the number of
      // recorded tenders (a count, no payment data) — re-reviewed under SI-012.
      "device_id",
      "tender_count",
      // RT-418 (0051): how many sale_responsibilities rows capture wrote.
      "responsibility_count",
      "created_at",
      // RT-538 (0047): the receipt snapshot — re-reviewed under SI-012. A sale /
      // receipt number, the terminal label, a printed time, the STORE's branch
      // name, address and tax id (business identity printed on every receipt)
      // and the cash change amount. No customer, card or account data.
      // EXCEPTION: receipt_operator_display_name is PII by review (the selling
      // operator's display name; see REVIEWED_PII_COLUMNS below).
      "receipt_sale_number",
      "receipt_number",
      "receipt_terminal_label",
      "receipt_operator_display_name",
      "receipt_settled_at",
      "receipt_branch_name",
      "receipt_branch_address",
      "receipt_tax_registration_id",
      "receipt_change_given",
    ],
  },
  {
    name: "sale_lines",
    table: saleLines,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "line_name",
      "unit_price",
      "currency_code",
      "quantity",
      "line_amount",
      "tax_amount",
      "unit",
      "tenant_product_ref",
      // RT-538 (0047): the line's receipt position (an ordinal, no PII).
      "line_seq",
    ],
  },
  {
    name: "sale_voids",
    table: saleVoids,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "voided_at",
      "business_date",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
      "created_at",
      // RT-530 (0046): the manager approval the server accepted. Opaque ids, a
      // policy label and times: business-class audit facts, no PIN or PII.
      "approval_id",
      "approved_by_user_id",
      "requested_by_user_id",
      "approval_policy_version",
      "approved_at",
      "void_business_date",
    ],
  },
  {
    name: "sale_refunds",
    table: saleRefunds,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "refunded_at",
      "pos_refund_amount",
      "currency_code",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
      "created_at",
    ],
  },
  // RT-73 (0032) — re-reviewed under SI-012. `reason` is operator free text
  // that must not carry customer PII. sale_return_tenders records only the
  // refund payout METHOD ('cash') and AMOUNT as a fact (RT-14 D3): no card,
  // account or instrument data, no customer reference. A non-cash method
  // (RT-10) re-triggers SI-012.
  {
    name: "sale_returns",
    table: saleReturns,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "return_seq",
      "returned_at",
      "business_date",
      "currency_code",
      "return_total",
      "reason",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
      "created_at",
      // RT-787 (0067, R-7): a boolean posting mark, no data.
      "posting_deferred",
    ],
  },
  {
    name: "sale_return_lines",
    table: saleReturnLines,
    columns: [
      "id",
      "return_id",
      "sale_line_id",
      "tenant_id",
      "store_id",
      "quantity",
      "line_amount",
      "tax_amount",
      "returned_quantity_after",
    ],
  },
  {
    name: "sale_return_tenders",
    table: saleReturnTenders,
    columns: [
      "id",
      "return_id",
      "tenant_id",
      "store_id",
      "ordinal",
      "method",
      "amount",
      // RT-787 (0067) — reviewed under SI-012: the RT-490 allocation fields.
      // `allocation_ref` and `original_tender_ref` are POS-minted opaque UUIDs
      // (the latter a sale tender line's `tender_ref`); `instrument` is
      // CHECK-constrained to 'cash'. No card, account or customer data.
      "allocation_ref",
      "original_tender_ref",
      "instrument",
    ],
  },
  // RT-787 (0067) — reviewed under SI-012: a settled cash refund execution.
  // Ids, an amount, the evidence method ('drawer' / 'manual'), the
  // device-reported payout time, the shift id and provenance. No card,
  // account or customer data.
  {
    name: "refund_executions",
    table: refundExecutions,
    columns: [
      "id",
      "execution_ref",
      "return_id",
      "allocation_id",
      "sale_id",
      "tenant_id",
      "store_id",
      "allocation_ref",
      "amount",
      "outcome",
      "evidence_method",
      "paid_at",
      "shift_ref",
      "source_system",
      "external_id",
      "payload_hash",
      "created_by",
      "settles_return",
      "recorded_at",
    ],
  },
  // RT-77 (0033) — re-reviewed under SI-012 for the first non-cash method,
  // `card_external`. Method + amount are sale facts; `reference` is the card
  // terminal's short approval code, CHECK-constrained to ^[A-Z0-9]{1,6}$ so no
  // PAN / expiry / customer identifier fits. No card, account or customer column.
  // RT-360 (0041) — re-reviewed under SI-012: `tender_ref` is the POS tender
  // line's opaque UUID and `sequence` its apply ordinal; neither carries card,
  // account or customer data.
  {
    name: "sale_tenders",
    table: saleTenders,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "method",
      "amount",
      "currency_code",
      "reference",
      "created_at",
      "tender_ref",
      "sequence",
    ],
  },
  // RT-538 (0047) — reviewed under SI-012: the reprint record holds opaque
  // UUIDs (sale, actor, device), the mode/kind enums, two mark flags, a copy
  // number, two timestamps and the client's opaque idempotency key. No receipt
  // content, customer, card or account data.
  {
    name: "sale_reprints",
    table: saleReprints,
    columns: [
      "id",
      "sale_id",
      "tenant_id",
      "store_id",
      "mode",
      "kind",
      "marked_voided",
      "marked_returned",
      "copy_number",
      "printed_at",
      "recorded_at",
      "created_by",
      "device_id",
      "idempotency_key",
    ],
  },
  // RT-418 (0051) — reviewed under SI-012: who owes how much of the sale. An
  // opaque payer UUID (the payer's display name stays on payer_account), a
  // positive amount and an ordinal. No customer, card or account data.
  {
    name: "sale_responsibilities",
    table: saleResponsibilities,
    columns: ["id", "tenant_id", "store_id", "sale_id", "payer_id", "amount", "sequence", "created_at"],
  },
  // RT-577 (0054) — reviewed under SI-012: a credit reversal's allocation
  // (amounts), the payer as an opaque UUID, the actor and approver as user
  // UUIDs, a role code, a policy version and a short reason the contract bars
  // from carrying PII. No customer, card or account data.
  {
    name: "sale_credit_reversals",
    table: saleCreditReversals,
    columns: [
      "id",
      "tenant_id",
      "store_id",
      "sale_id",
      "kind",
      "void_id",
      "return_id",
      "source_system",
      "external_id",
      "payload_hash",
      "business_date",
      "currency_code",
      "reversal_total",
      "refundable_amount",
      "adjustment_amount",
      "payer_id",
      "adjustment_ref",
      "actor_user_id",
      "actor_role",
      "reason",
      "approval_id",
      "approved_by_user_id",
      "requested_by_user_id",
      "approval_policy_version",
      "approved_at",
      "created_at",
    ],
  },
  // RT-577 D8 — reviewed under SI-012: the refund paid out. `method` and
  // `amount`, the sale tender line it mirrors (`tender_ref`, an opaque UUID)
  // and the card terminal's 1-6 character printed refund reference, NEVER card
  // data (the `sale_tenders.reference` precedent).
  {
    name: "sale_credit_reversal_tenders",
    table: saleCreditReversalTenders,
    columns: ["id", "reversal_id", "tenant_id", "store_id", "ordinal", "method", "amount", "tender_ref", "reference"],
  },
  // RT-577 (0054) — reviewed under SI-012: the shared single-use ledger of
  // approval ids. Ids, a route code and a timestamp only.
  {
    name: "sale_approval_uses",
    table: saleApprovalUses,
    columns: ["tenant_id", "approval_id", "source", "created_at"],
  },
];

/**
 * Columns that carry a payment-class NAME fragment but no payment data, each
 * re-reviewed under SI-012 when it landed. `sales.tender_count` (RT-77) is the
 * number of `sale_tenders` rows capture wrote — the feed's visibility guard.
 * `sale_tenders.tender_ref` (RT-360) is the tender line's opaque identity.
 */
const REVIEWED_PAYMENT_NAMED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // RT-538: receipt_branch_address is the STORE's address printed in the
  // receipt header, not a customer address.
  sales: ["tender_count", "receipt_branch_address"],
  sale_tenders: ["tender_ref"],
  // RT-577 D8: the sale tender line a credit void's refund mirrors (a UUID).
  sale_credit_reversal_tenders: ["tender_ref"],
  // RT-787: the sale tender line a refund allocation is charged against (a UUID).
  sale_return_tenders: ["original_tender_ref"],
};

/**
 * Columns classified PII by review (§XIV) that the substring denylist cannot
 * catch (it deliberately avoids bare `name`). `sales.receipt_operator_display_name`
 * (RT-538) is the selling operator's display name as printed: workforce data
 * identifying the actor (as users.display_name), never a customer's. A future
 * user-erasure flow tombstones only this column; 0047's header records it.
 */
const REVIEWED_PII_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sales: ["receipt_operator_display_name"],
};

/**
 * Collision-safe PII / payment-class substrings. Each is a fragment that would
 * appear in a customer-reference or tender/payment column name but does NOT
 * collide with any business-class column above. Deliberately AVOIDS bare
 * `name` (would false-positive on `line_name`); `created_by` / `source_system`
 * are operational provenance, not customer PII.
 */
const PII_PAYMENT_SUBSTRINGS = [
  "customer",
  "patient",
  "email",
  "phone",
  "address",
  "ssn",
  "national_id",
  "first_name",
  "last_name",
  "full_name",
  "dob",
  "birth",
  "tender",
  "payment",
  "card",
  "cash",
  "pan",
  "iban",
  "account_number",
  "cvv",
];

describe("008-LIFECYCLE (T075) — sale-fact data-class classification (SI-012 / §XIV)", () => {
  describe.each(BUSINESS_CLASS_COLUMNS)(
    "$name persists EXACTLY the recorded business-class columns",
    ({ table, columns }) => {
      it("set-equals the business-class allowlist (tripwire on add/remove/rename)", () => {
        const actual = persistedColumns(table);
        const expected = [...columns].sort();
        // Set-equality: any drift (a new customer-reference or tender column,
        // or a removed/renamed field) fails here and forces SI-012 re-review.
        expect(actual).toEqual(expected);
      });
    },
  );

  describe("no PII / payment-class field is persisted in v1 (gate A.5 — tender deferred)", () => {
    it.each(BUSINESS_CLASS_COLUMNS)(
      "$name has zero PII/payment-class columns",
      ({ name, table }) => {
        const reviewed = REVIEWED_PAYMENT_NAMED_COLUMNS[name] ?? [];
        const offending = persistedColumns(table).filter(
          (col) =>
            !reviewed.includes(col) &&
            PII_PAYMENT_SUBSTRINGS.some((frag) => col.toLowerCase().includes(frag)),
        );
        expect(offending).toEqual([]);
      },
    );
  });
});

describe("RT-538 — reviewed PII columns are persisted and recorded", () => {
  it.each(Object.entries(REVIEWED_PII_COLUMNS))(
    "%s persists every reviewed PII column",
    (name, cols) => {
      const entry = BUSINESS_CLASS_COLUMNS.find((t) => t.name === name);
      expect(entry).toBeDefined();
      for (const col of cols) expect(persistedColumns(entry?.table)).toContain(col);
    },
  );

  it("0047_sale_history_capture.sql header records the SI-012 review, the PII column and its tombstone", () => {
    // Same six-hop repo root as the block below.
    const repoRoot = path.resolve(__dirname, "../../../../../..");
    const text = fs.readFileSync(
      path.join(repoRoot, "packages/db/drizzle/0047_sale_history_capture.sql"),
      "utf8",
    );
    expect(text).toMatch(/SI-012/);
    expect(text).toMatch(/classified PII/i);
    expect(text).toMatch(/receipt_operator_display_name/);
    expect(text).toMatch(/tombston/i);
  });
});

describe("008-LIFECYCLE (T075) — classification + retention recorded in source-of-truth", () => {
  // The retention posture (001-inherited, insert-only; tombstone-on-erasure) is
  // PROSE, not a column shape — so the durable record lives in the migration
  // header + data-model.md. These secondary assertions prove that record exists
  // (kept lenient: keyword presence, not brittle wording).
  // repoRoot: __dirname is apps/api/test/catalog/sales/lifecycle → SIX hops up
  // (lifecycle→sales→catalog→test→api→apps→root). DO NOT reduce to five: five
  // resolves to <repo>/apps and the readFileSync calls below ENOENT on
  // <repo>/apps/packages/... CodeRabbit flagged "use one fewer .." — that is a
  // miscount; an autofix once applied it and broke the suite (PR #430). Six.
  const repoRoot = path.resolve(__dirname, "../../../../../..");

  it("0012_sales.sql header records business-class + 001-inherited retention", () => {
    const sqlPath = path.join(
      repoRoot,
      "packages/db/drizzle/0012_sales.sql",
    );
    const text = fs.readFileSync(sqlPath, "utf8");
    expect(text).toMatch(/BUSINESS-CLASS/i);
    expect(text).toMatch(/SI-012/);
    expect(text).toMatch(/001 long-horizon/i);
    expect(text).toMatch(/tombston/i);
  });

  it("data-model.md records the SI-012 business-class classification + retention", () => {
    const dmPath = path.join(
      repoRoot,
      "specs/008-sales-transaction-capture/data-model.md",
    );
    const text = fs.readFileSync(dmPath, "utf8");
    expect(text).toMatch(/business-class/i);
    expect(text).toMatch(/SI-012/);
    expect(text).toMatch(/inherits the 001/i);
    expect(text).toMatch(/tombston/i);
  });
});
