/**
 * apps/api/test/devices/devices-pairing-codes.contract.spec.ts
 *
 * RT-367 (RT-287 F4; RT-138 L1 / L5 / DL-3): the Console pairing codes in
 * `devices.openapi.yaml` — `consoleIssuePairingCode`, `consoleListPairingCodes`
 * and `consoleCancelPairingCode`, plus the F9 wording and the pair-time
 * refusal in `pos-terminal-pairing.openapi.yaml`. `[GATED]` contract-first;
 * the RT-367 runtime ships them unchanged on the wire
 * (`pairing-codes.http.integration.spec.ts`).
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. Pinned here:
 *
 *   1. The operations: implemented, cookie auth, Origin-checked POSTs, the
 *      non-replayable Idempotency-Key on the issue, scope refusals as 404.
 *   2. The code is returned once: only the issue's 201 carries it; no other
 *      schema has a code, hash or token field.
 *   3. The issue body: closed, the tenant never from the request, the
 *      terminal binding required, the TTL bounded at 24 h.
 *   4. The issue's 409: a refused replace / move carries its preview, whose
 *      block code equals the envelope's code.
 *   5. The list and cancel shapes.
 *   6. The pairing contract: terminal_id survives rotation, not re-pair; no
 *      "long-lived" token; expires_at populated; REPLACEMENT_BLOCKED.
 */
import { readContract, type ContractReader, type JsonObject } from "../_helpers/openapi-contract-reader";

const CODES_PATH = "/api/v1/pairing-codes";
const CANCEL_PATH = "/api/v1/pairing-codes/{pairingCodeId}/cancel";

const CODE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000010";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000011";
const TERMINAL_ID = "0190f5a2-3b4c-7d8e-9f01-000000000012";
const DEVICE_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const SHIFT_ID = "0190f5a2-3b4c-7d8e-9f01-000000000004";
const USER_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";

let contract: ContractReader;

beforeAll(() => {
  contract = readContract("devices.openapi");
});

const props = (name: Capitalize<string>): Record<string, JsonObject> =>
  (contract.schema(name)["properties"] ?? {}) as Record<string, JsonObject>;
const keysOf = (name: Capitalize<string>): string[] => Object.keys(props(name)).sort();
const info = (): string => String((contract.document["info"] as JsonObject)["description"]);
const responsesOf = (method: "get" | "post", path: `/${string}`): Record<string, JsonObject> =>
  contract.operation(method, path)["responses"] as Record<string, JsonObject>;

const omit = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUE_REQUEST = {
  storeId: STORE_ID,
  branchName: "Main Store",
  branchAddress: "1 Pilot St",
  taxRegistrationId: "123-456-789",
  printerVendorId: "0x04B8",
  printerProductId: "0x0E15",
};

const ISSUED = {
  pairingCodeId: CODE_ID,
  code: "ABCDEFGHJKMNPQRS",
  kind: "pair",
  storeId: STORE_ID,
  terminalId: TERMINAL_ID,
  terminalLabel: "T-0190F5A2",
  replacesDeviceId: null,
  expiresAt: "2026-10-17T11:00:00.000Z",
  createdAt: "2026-10-17T10:00:00.000Z",
};

const SUMMARY = {
  pairingCodeId: CODE_ID,
  kind: "pair",
  storeId: STORE_ID,
  terminalId: TERMINAL_ID,
  terminalLabel: "Counter 1",
  status: "pending",
  replacesDeviceId: null,
  expiresAt: "2026-10-17T11:00:00.000Z",
  createdAt: "2026-10-17T10:00:00.000Z",
};

/** A replace refused because the active replaced device has an open shift. */
const BLOCKED_REPLACE_PREVIEW = {
  deviceId: DEVICE_ID,
  action: "replace",
  revokeReason: "replaced",
  trustState: "active",
  verdict: "blocked",
  blockCode: "unresolved_cash_session",
  requires: [],
  openShift: {
    shiftId: SHIFT_ID,
    source: "legacy",
    openedAt: "2026-10-17T08:00:00.000Z",
    openingCashierUserId: USER_ID,
    cashFacts: null,
  },
  custodyExceptionShiftId: null,
  cascade: { operatorSessionCount: 1, pendingPairingCodeCount: 0 },
  replacesDeviceId: null,
  replacedByDeviceId: null,
  evaluatedAt: "2026-10-17T10:00:00.000Z",
};

/** A move refused because the replaced device is retired. */
const BLOCKED_MOVE_PREVIEW = {
  ...BLOCKED_REPLACE_PREVIEW,
  action: "move",
  revokeReason: "moved",
  trustState: "retired",
  blockCode: "device_retired",
  openShift: null,
  cascade: null,
};

const conflict = (code: string, details?: unknown): JsonObject => ({
  error: { code, message: "Refused.", ...(details !== undefined ? { details } : {}) },
});

// ===========================================================================
// 1. Operations
// ===========================================================================
describe("pairing codes contract — operations", () => {
  it.each([
    ["post", CODES_PATH, "consoleIssuePairingCode"],
    ["get", CODES_PATH, "consoleListPairingCodes"],
    ["post", CANCEL_PATH, "consoleCancelPairingCode"],
  ] as const)("%s %s is %s, implemented (no contract-only marker), with no foreign collision", (m, p, id) => {
    const operation = contract.operation(m, p);
    expect(operation["operationId"]).toBe(id);
    expect(operation["x-runtime-status"]).toBeUndefined();
    expect(operation["x-runtime-note"]).toBeUndefined();
    expect(operation["tags"]).toEqual(["pairing-codes"]);
    expect(operation["security"]).toBeUndefined();
    expect(contract.foreignOperationIds.has(id)).toBe(false);
  });

  it.each([
    ["post", CODES_PATH, ["201", "400", "401", "403", "404", "409", "425", "429", "500"]],
    ["get", CODES_PATH, ["200", "400", "401", "404", "429", "500"]],
    ["post", CANCEL_PATH, ["200", "400", "401", "403", "404", "409", "429", "500"]],
  ] as const)("%s %s answers exactly %j (scope refusals are the shared 404)", (m, p, statuses) => {
    const responses = responsesOf(m, p);
    expect(Object.keys(responses).sort()).toEqual([...statuses].sort());
    expect(responses["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
  });

  it("checks the Origin on both POSTs (RT-430)", () => {
    for (const path of [CODES_PATH, CANCEL_PATH] as const) {
      expect(responsesOf("post", path)["403"]).toEqual({ $ref: "#/components/responses/OriginRejected" });
    }
    expect(info()).toMatch(/so must the\s+pairing-code issue and cancel/);
  });

  it("requires a non-replayable Idempotency-Key on the issue only", () => {
    const issue = contract.operation("post", CODES_PATH);
    expect(issue["x-idempotency"]).toBe("required");
    const header = contract.parameters("post", CODES_PATH);
    expect(header.map((p) => [p["name"], p["in"], p["required"]])).toEqual([["Idempotency-Key", "header", true]]);
    expect(String(header[0]?.["description"])).toMatch(/Non-replayable \(RT-82 K3\)/);
    expect(String(header[0]?.["description"])).toMatch(/idempotency_key_conflict/);
    for (const [m, p] of [["get", CODES_PATH], ["post", CANCEL_PATH]] as const) {
      expect(contract.parameters(m, p).some((x) => x["name"] === "Idempotency-Key")).toBe(false);
    }
  });

  it("reads no tenant, actor or user from the request; the list and cancel take only scope and paging", () => {
    expect(contract.parameters("get", CODES_PATH).map((p) => p["name"])).toEqual(["store_id", "cursor", "page_size"]);
    expect(contract.parameters("post", CANCEL_PATH).map((p) => [p["name"], p["in"]])).toEqual([["pairingCodeId", "path"]]);
    expect(contract.operation("post", CANCEL_PATH)["requestBody"]).toBeUndefined();
    expect(keysOf("PairingCodeIssueRequest").filter((k) => /tenant|actor|user|kind/i.test(k))).toEqual([]);
  });
});

// ===========================================================================
// 2. The code is returned once
// ===========================================================================
describe("pairing codes contract — the code is returned once", () => {
  it("carries the code only on the issue's 201 body", () => {
    expect(responsesOf("post", CODES_PATH)["201"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/PairingCodeIssued" } } },
    });
    expect(props("PairingCodeIssued")["code"]).toMatchObject({ type: "string", minLength: 16, maxLength: 32 });
    expect(String(props("PairingCodeIssued")["code"]?.["description"])).toMatch(/SECRET/);
  });

  it("has no code, hash, token or tenant field on any other schema", () => {
    const schemas = (contract.document["components"] as JsonObject)["schemas"] as Record<string, JsonObject>;
    for (const [name, schema] of Object.entries(schemas)) {
      if (name === "PairingCodeIssued") continue;
      const keys = Object.keys((schema["properties"] ?? {}) as JsonObject);
      expect([name, keys.filter((k) => /^code$|hash|token|tenant/i.test(k))]).toEqual([name, []]);
    }
  });

  it("states that the code is never stored, listed, replayed, logged or audited", () => {
    expect(info()).toMatch(/It stores only a\s+hash \(`code_hash`\), so it can never return the code again/);
    expect(info()).toMatch(/The code, its hash and the device token never appear in any response/);
  });
});

// ===========================================================================
// 3. The issue body
// ===========================================================================
describe("pairing codes contract — the issue body", () => {
  it("is closed and requires the store and the terminal binding", () => {
    const s = contract.schema("PairingCodeIssueRequest");
    expect(s["additionalProperties"]).toBe(false);
    expect([...(s["required"] as string[])].sort()).toEqual(
      ["storeId", "branchName", "branchAddress", "taxRegistrationId", "printerVendorId", "printerProductId"].sort(),
    );
    expect(contract.accepts("PairingCodeIssueRequest", ISSUE_REQUEST)).toBe(true);
    for (const key of s["required"] as string[]) {
      expect([key, contract.accepts("PairingCodeIssueRequest", omit(ISSUE_REQUEST, key))]).toEqual([key, false]);
    }
  });

  it.each([
    ["a smuggled tenantId", { tenantId: STORE_ID }],
    ["a client-chosen kind", { kind: "move" }],
    ["a TTL over 24 h", { ttlMinutes: 1441 }],
    ["a zero TTL", { ttlMinutes: 0 }],
    ["a blank label", { terminalLabel: "  " }],
    ["a 65-character label", { terminalLabel: "x".repeat(65) }],
    ["a label with a NUL", { terminalLabel: "Counter\u00001" }],
    ["a printer id that is not 0xHHHH", { printerVendorId: "04B8" }],
    ["a replaced device that is not a UUID", { replacesDeviceId: "dev-1" }],
  ])("refuses %s", (_label, patch) => {
    expect(contract.accepts("PairingCodeIssueRequest", { ...ISSUE_REQUEST, ...patch })).toBe(false);
  });

  it("passes the terminal binding through for 0024 and derives (never promises unique) the default label", () => {
    expect(info()).toMatch(/passed through to satisfy migration\s+0024's NOT NULL snapshot columns/);
    const label = String(props("PairingCodeIssueRequest")["terminalLabel"]?.["description"]);
    expect(label).toMatch(/derives it\s+from the new `terminalId` prefix/);
    expect(label).not.toMatch(/unique/i);
  });

  it("accepts the optional label, TTL, replaced device and COM port", () => {
    const full = {
      ...ISSUE_REQUEST,
      terminalLabel: "Counter 1",
      ttlMinutes: 1440,
      replacesDeviceId: DEVICE_ID,
      printerComPort: "COM3",
    };
    expect(contract.accepts("PairingCodeIssueRequest", full)).toBe(true);
    expect(contract.accepts("PairingCodeIssueRequest", { ...ISSUE_REQUEST, printerComPort: null })).toBe(true);
    expect(props("PairingCodeIssueRequest")["ttlMinutes"]).toMatchObject({ minimum: 1, maximum: 1440, default: 60 });
  });

  it("derives the kind from the stores, never from the request", () => {
    expect(contract.schema("PairingCodeKind")["enum"]).toEqual(["pair", "replace", "move"]);
    expect(String(contract.schema("PairingCodeKind")["description"])).toMatch(/Derived by the server/);
  });
});

// ===========================================================================
// 4. The issued code and the issue's 409
// ===========================================================================
describe("pairing codes contract — issued code and 409", () => {
  it("PairingCodeIssued is closed and requires every key it declares", () => {
    const s = contract.schema("PairingCodeIssued");
    expect(s["additionalProperties"]).toBe(false);
    expect([...(s["required"] as string[])].sort()).toEqual(keysOf("PairingCodeIssued"));
    expect(contract.accepts("PairingCodeIssued", ISSUED)).toBe(true);
  });

  it("ties replacesDeviceId to the kind", () => {
    expect(contract.accepts("PairingCodeIssued", { ...ISSUED, replacesDeviceId: DEVICE_ID })).toBe(false);
    expect(contract.accepts("PairingCodeIssued", { ...ISSUED, kind: "replace", replacesDeviceId: DEVICE_ID })).toBe(true);
    expect(contract.accepts("PairingCodeIssued", { ...ISSUED, kind: "move" })).toBe(false);
  });

  it("refuses a replace / move with its preview, whose block code is the envelope's code", () => {
    expect(responsesOf("post", CODES_PATH)["409"]).toEqual({ $ref: "#/components/responses/PairingCodeIssueConflict" });
    expect(contract.accepts("PairingCodeIssueConflict", conflict("unresolved_cash_session", BLOCKED_REPLACE_PREVIEW))).toBe(
      true,
    );
    expect(contract.accepts("PairingCodeIssueConflict", conflict("device_retired", BLOCKED_MOVE_PREVIEW))).toBe(true);
  });

  it.each([
    ["a block without its preview", conflict("unresolved_cash_session")],
    ["a preview whose block code differs", conflict("device_retired", BLOCKED_REPLACE_PREVIEW)],
    ["a preview for a revoke", conflict("unresolved_cash_session", { ...BLOCKED_REPLACE_PREVIEW, action: "revoke" })],
    ["an idempotency conflict with a preview", conflict("idempotency_key_conflict", BLOCKED_REPLACE_PREVIEW)],
    ["an unknown code", conflict("unresolved_custody_exception")],
  ])("refuses %s", (_label, body) => {
    expect(contract.accepts("PairingCodeIssueConflict", body)).toBe(false);
  });

  it.each(["replacement_already_pending", "device_already_replaced"])(
    "refuses a second replacement with %s, without details",
    (code) => {
      expect(contract.accepts("PairingCodeIssueConflict", conflict(code))).toBe(true);
      expect(contract.accepts("PairingCodeIssueConflict", conflict(code, BLOCKED_REPLACE_PREVIEW))).toBe(false);
    },
  );

  it("documents one replacement per device, reported after a blocked verdict", () => {
    expect(info()).toMatch(/A device is replaced at most once/);
    expect(info()).toMatch(/A `blocked` verdict is always reported first/);
  });

  it("never tells a client to retry the non-replayable key", () => {
    const responses = (contract.document["components"] as JsonObject)["responses"] as Record<string, JsonObject>;
    const tooEarly = String(responses["IdempotencyInProgress"]?.["description"]);
    expect(tooEarly).not.toMatch(/with the same key and body/);
    expect(tooEarly).toMatch(/Do not retry\s+with the same key/);
    expect(tooEarly).toMatch(/consoleListPairingCodes/);
    const header = contract.parameters("post", CODES_PATH)[0];
    expect(String(header?.["description"])).toMatch(/Never retry with the same key/);
  });

  it("answers an idempotency conflict without details, and a 425 with the interceptor's body", () => {
    expect(contract.accepts("PairingCodeIssueConflict", conflict("idempotency_key_conflict"))).toBe(true);
    expect(contract.accepts("IdempotencyInProgress", { error: "idempotency_in_progress", retryAfterSec: 2 })).toBe(true);
  });

  it("documents the issue's decision with the shared evaluator under the replaced device's lock", () => {
    expect(info()).toMatch(/The issue decides with the lifecycle evaluator/);
    expect(info()).toMatch(/under the replaced\s+device's lifecycle lock/);
    expect(info()).toMatch(/is never transferred to the new\s+device/);
  });
});

// ===========================================================================
// 5. List and cancel
// ===========================================================================
describe("pairing codes contract — list and cancel", () => {
  it("flags the kind on every summary, even when the replaced device is out of scope", () => {
    expect(contract.schema("PairingCodeSummary")["required"]).toContain("kind");
    expect(contract.accepts("PairingCodeSummary", omit(SUMMARY, "kind"))).toBe(false);
    expect(contract.accepts("PairingCodeSummary", { ...SUMMARY, kind: "move", replacesDeviceId: null })).toBe(true);
    expect(contract.accepts("PairingCodeSummary", { ...SUMMARY, kind: "swap" })).toBe(false);
  });

  it("lists closed, secret-free summaries of live pending codes only", () => {
    const s = contract.schema("PairingCodeSummary");
    expect(s["additionalProperties"]).toBe(false);
    expect([...(s["required"] as string[])].sort()).toEqual(keysOf("PairingCodeSummary"));
    expect(contract.accepts("PairingCodePage", { items: [SUMMARY], nextCursor: null })).toBe(true);
    expect(contract.accepts("PairingCodePage", { items: [{ ...SUMMARY, status: "cancelled" }], nextCursor: null })).toBe(
      false,
    );
    expect(contract.accepts("PairingCodePage", { items: [{ ...SUMMARY, code: "ABCDEFGHJKMNPQRS" }], nextCursor: null })).toBe(
      false,
    );
  });

  it("cancels idempotently and always leaves the code cancelled", () => {
    const cancelled = { ...SUMMARY, status: "cancelled" };
    expect(contract.accepts("PairingCodeCancelResult", { outcome: "cancelled", pairingCode: cancelled })).toBe(true);
    expect(contract.accepts("PairingCodeCancelResult", { outcome: "already_cancelled", pairingCode: cancelled })).toBe(true);
    expect(contract.accepts("PairingCodeCancelResult", { outcome: "cancelled", pairingCode: SUMMARY })).toBe(false);
    expect(responsesOf("post", CANCEL_PATH)["409"]).toEqual({ $ref: "#/components/responses/PairingCodeUsed" });
  });
});

// ===========================================================================
// 6. The pairing contract (F9 + the pair-time refusal)
// ===========================================================================
describe("pos-terminal-pairing contract — RT-367 wording", () => {
  const pairing = (): JsonObject => contract.sibling("pos-terminal-pairing.openapi");
  const text = (): string => JSON.stringify(pairing());
  const pairProps = (): Record<string, JsonObject> =>
    (((pairing()["components"] as JsonObject)["schemas"] as JsonObject)["TerminalPairResponse"] as JsonObject)[
      "properties"
    ] as Record<string, JsonObject>;

  it("is 1.4.0-draft (RT-327 named operation sets, after RT-719 build identity and RT-369 rotate) and no longer calls the token long-lived or says terminal_id survives re-pairing", () => {
    expect((pairing()["info"] as JsonObject)["version"]).toBe("1.4.0-draft");
    expect(text()).not.toMatch(/long-lived/i);
    expect(text()).not.toMatch(/Survives\s+re-pairing/i);
  });

  it("says terminal_id survives rotation, not re-pairing, and expires_at is populated", () => {
    expect(String(pairProps()["terminal_id"]?.["description"])).toMatch(/Stable across credential rotation/);
    expect(String(pairProps()["terminal_id"]?.["description"])).toMatch(/NOT across\s+re-pairing/);
    expect(String(pairProps()["expires_at"]?.["description"])).toMatch(/Populated by Backend-Core since\s+RT-367/);
  });

  it("describes the pairing_code as the Console's 16 or the CLI's 24 characters", () => {
    const request = ((pairing()["components"] as JsonObject)["schemas"] as JsonObject)["TerminalPairRequest"] as JsonObject;
    const code = String(((request["properties"] as JsonObject)["pairing_code"] as JsonObject)["description"]);
    expect(code).toMatch(/16 characters/);
    expect(code).toMatch(/24\s+base64url characters/);
    expect(code).not.toMatch(/8 character|tenant admin/);
  });

  it("documents REPLACEMENT_BLOCKED on the 409, with the code left pending", () => {
    expect(text()).toMatch(/REPLACEMENT_BLOCKED/);
    expect(text()).toMatch(/the code stays pending/);
  });
});
