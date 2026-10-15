/**
 * void-approval.unit.spec.ts — RT-530: the pure claim checks of a manager-
 * approved void, in the contract's order, and the request schema.
 */
import { RecordVoidRequestSchema } from "../../../src/catalog/sales/dto/record-void-request.dto";
import type { RecordVoidRequestDto } from "../../../src/catalog/sales/dto/record-void-request.dto";
import {
  checkVoidApprovalClaims,
  VOID_APPROVAL_SKEW_MS,
  VoidApprovalInvalidError,
  VoidApprovalRequiredError,
  VoidOutsideBusinessDayError,
  VoidRequesterMismatchError,
  VoidSelfApprovalError,
  type VoidSaleFacts,
} from "../../../src/catalog/sales/void-approval";

const SALE = "0a000000-0000-7000-8000-0000000530d1";
const SELLER = "0a000000-0000-7000-8000-0000000530e1";
const REQUESTER = "0a000000-0000-7000-8000-0000000530e2";
const APPROVER = "0a000000-0000-7000-8000-0000000530e3";
const NOW = new Date("2026-10-15T12:00:00.000Z");

const facts = (over: Partial<VoidSaleFacts> = {}): VoidSaleFacts => ({
  saleRef: SALE,
  amountMatches: true,
  businessDate: "2026-10-15",
  sellingOperatorUserId: SELLER,
  ...over,
});

function body(
  approval: Partial<NonNullable<RecordVoidRequestDto["approval"]>> | null = {},
  over: Record<string, unknown> = {},
): RecordVoidRequestDto {
  return {
    sourceSystem: "pos-1",
    externalId: "void-1",
    businessDate: "2026-10-15",
    ...(approval === null
      ? {}
      : {
          approval: {
            approvalId: "0a000000-0000-7000-8000-0000000530c1",
            action: "sale.void",
            saleRef: SALE,
            amount: "12.5000",
            requesterUserId: REQUESTER,
            approverUserId: APPROVER,
            policyVersion: "rt114-2026-10-07",
            approvedAt: "2026-10-15T11:59:00.000Z",
            ...approval,
          },
        }),
    ...over,
  } as RecordVoidRequestDto;
}

/** The envelope actor defaults to the requester, as it is in a valid void. */
const check = (b: RecordVoidRequestDto, f: VoidSaleFacts = facts(), actorUserId: string = REQUESTER) =>
  checkVoidApprovalClaims({ body: b, actorUserId, sale: f, now: NOW });

describe("checkVoidApprovalClaims", () => {
  it("accepts a bound approval from a different approver on the sale's day and returns it", () => {
    expect(check(body()).approverUserId).toBe(APPROVER);
  });

  it("refuses a void with no approval", () => {
    expect(() => check(body(null))).toThrow(VoidApprovalRequiredError);
  });

  it.each([
    ["another action", { action: "cart.cancel_post_handoff" }],
    ["another sale", { saleRef: "0a000000-0000-7000-8000-0000000530d2" }],
  ])("refuses an approval bound to %s", (_label, approval) => {
    expect(() => check(body(approval))).toThrow(VoidApprovalInvalidError);
  });

  it("matches the sale ref case-insensitively", () => {
    expect(() => check(body({ saleRef: SALE.toUpperCase() }))).not.toThrow();
  });

  it("refuses an amount that is not the sale's total", () => {
    expect(() => check(body(), facts({ amountMatches: false }))).toThrow(VoidApprovalInvalidError);
  });

  it("allows an old approval (an offline-queued void) but not a future-dated one", () => {
    expect(() => check(body({ approvedAt: "2026-10-12T08:00:00.000Z" }))).not.toThrow();
    const edge = new Date(NOW.getTime() + VOID_APPROVAL_SKEW_MS).toISOString();
    expect(() => check(body({ approvedAt: edge }))).not.toThrow();
    const beyond = new Date(NOW.getTime() + VOID_APPROVAL_SKEW_MS + 1).toISOString();
    expect(() => check(body({ approvedAt: beyond }))).toThrow(VoidApprovalInvalidError);
  });

  it.each([
    ["another day", { businessDate: "2026-10-14" }],
    ["no day", { businessDate: undefined }],
  ])("refuses a void with %s", (_label, over) => {
    expect(() => check(body({}, over))).toThrow(VoidOutsideBusinessDayError);
  });

  it("refuses a requester who is not the authenticated actor, in any case", () => {
    expect(() => check(body(), facts(), APPROVER)).toThrow(VoidRequesterMismatchError);
    expect(() => check(body(), facts(), "0a000000-0000-7000-8000-0000000530e9")).toThrow(VoidRequesterMismatchError);
    expect(() => check(body({ requesterUserId: REQUESTER.toUpperCase() }))).not.toThrow();
  });

  it("refuses a fabricated requester even when the actor is the approver", () => {
    const fabricated = "0a000000-0000-7000-8000-0000000530ee";
    expect(() => check(body({ requesterUserId: fabricated }), facts(), APPROVER)).toThrow(VoidRequesterMismatchError);
  });

  it("refuses the approver being the requester, in any case", () => {
    expect(() => check(body({ requesterUserId: APPROVER }), facts(), APPROVER)).toThrow(VoidSelfApprovalError);
    expect(() => check(body({ requesterUserId: APPROVER.toUpperCase() }), facts(), APPROVER)).toThrow(
      VoidSelfApprovalError,
    );
  });

  it("refuses the approver being the sale's selling operator", () => {
    expect(() => check(body({ approverUserId: SELLER }))).toThrow(VoidSelfApprovalError);
  });

  it("lets a requester who is the selling operator ask a different approver", () => {
    expect(() => check(body({ requesterUserId: SELLER }), facts(), SELLER)).not.toThrow();
  });

  it("reports the earlier failure first: missing approval, binding, day, requester, then four-eyes", () => {
    expect(() => check(body(null, { businessDate: "1999-01-01" }))).toThrow(VoidApprovalRequiredError);
    expect(() => check(body({ action: "x", approverUserId: SELLER }, { businessDate: "1999-01-01" }))).toThrow(
      VoidApprovalInvalidError,
    );
    expect(() => check(body({ approverUserId: SELLER }, { businessDate: "1999-01-01" }))).toThrow(
      VoidOutsideBusinessDayError,
    );
    expect(() => check(body({ approverUserId: SELLER }), facts(), APPROVER)).toThrow(VoidRequesterMismatchError);
    expect(() => check(body({ approverUserId: SELLER }))).toThrow(VoidSelfApprovalError);
  });
});

describe("RecordVoidRequestSchema", () => {
  const base = { sourceSystem: "pos-1", externalId: "void-1" };
  const approval = body().approval;

  it("keeps the legacy two-field body valid in shape (the service refuses it)", () => {
    expect(RecordVoidRequestSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a businessDate and an approval", () => {
    expect(RecordVoidRequestSchema.safeParse({ ...base, businessDate: "2026-10-15", approval }).success).toBe(true);
  });

  it.each([
    ["an impossible calendar day", { businessDate: "2026-02-30" }],
    ["a malformed day", { businessDate: "15/10/2026" }],
    ["an unknown body key", { voidedAt: "2026-10-15T00:00:00Z" }],
    ["an unknown approval key", { approval: { ...approval, role: "owner" } }],
    ["a non-uuid approver", { approval: { ...approval, approverUserId: "not-a-uuid" } }],
    ["a float-looking amount", { approval: { ...approval, amount: "1e3" } }],
    ["too many decimals", { approval: { ...approval, amount: "1.23456" } }],
    ["a negative amount", { approval: { ...approval, amount: "-1" } }],
    ["a non-ISO approvedAt", { approval: { ...approval, approvedAt: "yesterday" } }],
    ["a missing approval field", { approval: { ...approval, policyVersion: undefined } }],
  ])("rejects %s", (_label, extra) => {
    expect(RecordVoidRequestSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});
