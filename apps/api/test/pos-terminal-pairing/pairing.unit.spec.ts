/**
 * pairing.unit.spec.ts — 027 CONSUME, Docker-free unit coverage.
 *
 * Exercises the closed result-union mapping in PairingService with a fake
 * repository (no DB), and the secret-redaction discipline (the raw device_token
 * and the pairing_code are never handed to a logger). The DB / RLS / real-guard
 * coverage lives in pairing.integration.spec.ts (Testcontainers).
 */
import "reflect-metadata";

import {
  MAX_ATTEMPTS_PER_CODE,
  PairingService,
  type PairResult,
} from "../../src/pos-terminal-pairing/pairing.service";
import type {
  PairingCodeRow,
  PairingRepository,
} from "../../src/pos-terminal-pairing/pairing.repository";
import { toTerminalPairBody } from "../../src/pos-terminal-pairing/dto/terminal-pair.dto";

const TENANT = "0e000000-0000-7000-8000-00000000ee01";
const STORE_X = "0e000000-0000-7000-8000-00000000e5a1";
const STORE_Y = "0e000000-0000-7000-8000-00000000e5a2";
const TERMINAL = "0e000000-0000-7000-8000-0000000071a1";

function aRow(over: Partial<PairingCodeRow> = {}): PairingCodeRow {
  return {
    id: "0e000000-0000-7000-8000-000000000c01",
    tenant_id: TENANT,
    store_id: STORE_X,
    terminal_id: TERMINAL,
    terminal_label: "Counter 1",
    branch_name: "Branch X",
    branch_address: "Addr",
    tenant_tax_registration_id: "123456789",
    printer_vendor_id: "0x04B8",
    printer_product_id: "0x0202",
    printer_com_port: null,
    status: "pending",
    expires_at: new Date(Date.now() + 600_000),
    attempt_count: 0,
    last_attempt_at: null,
    replaces_device_id: null,
    ...over,
  };
}

/** A fake repo wired with a service instance bypassing the @Inject constructor. */
function serviceWith(repo: Partial<PairingRepository>): PairingService {
  const svc = Object.create(PairingService.prototype) as PairingService;
  (svc as unknown as { repo: Partial<PairingRepository> }).repo = repo;
  return svc;
}

describe("PairingService — closed result union", () => {
  it("unknown code → invalid", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(null),
    });
    const r = await svc.pair("whatever-12");
    expect(r.kind).toBe("invalid");
  });

  it("over-budget attempts → rate_limited (before any state change)", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(MAX_ATTEMPTS_PER_CODE + 1),
    });
    const r = await svc.pair("code-123456");
    expect(r.kind).toBe("rate_limited");
    if (r.kind === "rate_limited") {
      expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("used status → expired", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow({ status: "used" })),
      recordAttempt: jest.fn().mockResolvedValue(1),
    });
    expect((await svc.pair("code-123456")).kind).toBe("expired");
  });

  it("cancelled status → expired", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow({ status: "cancelled" })),
      recordAttempt: jest.fn().mockResolvedValue(1),
    });
    expect((await svc.pair("code-123456")).kind).toBe("expired");
  });

  it("past expiry → expired", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow({ expires_at: new Date(Date.now() - 1000) })),
      recordAttempt: jest.fn().mockResolvedValue(1),
    });
    expect((await svc.pair("code-123456")).kind).toBe("expired");
  });

  it("already paired same branch → already_paired", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      findPairedBranch: jest.fn().mockResolvedValue(STORE_X),
    });
    expect((await svc.pair("code-123456")).kind).toBe("already_paired");
  });

  it("already paired different branch → branch_mismatch", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      findPairedBranch: jest.fn().mockResolvedValue(STORE_Y),
    });
    expect((await svc.pair("code-123456")).kind).toBe("branch_mismatch");
  });

  it("lost same-code burn race → expired", async () => {
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      findPairedBranch: jest.fn().mockResolvedValue(null),
      burnAndProvision: jest.fn().mockResolvedValue("lost_race"),
    });
    expect((await svc.pair("code-123456")).kind).toBe("expired");
  });

  it("distinct-code race on same terminal (device already provisioned) → already_paired, NOT 500", async () => {
    // Two distinct codes for the same terminal_id race: this one wins the burn
    // but the devices INSERT hits a 23505 → repo returns 'already_provisioned'
    // → must map to already_paired (409), never an uncaught 500.
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      findPairedBranch: jest.fn().mockResolvedValue(null),
      burnAndProvision: jest.fn().mockResolvedValue("already_provisioned"),
    });
    expect((await svc.pair("code-123456")).kind).toBe("already_paired");
  });

  it("happy path → ok with the minted token in the body", async () => {
    const burn = jest
      .fn()
      .mockResolvedValue({ kind: "ok", rawToken: "the-raw-device-token-aaaaaaaaaaaaaaaaaa" });
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      findPairedBranch: jest.fn().mockResolvedValue(null),
      burnAndProvision: burn,
    });
    const r: PairResult = await svc.pair("code-123456");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body.device_token).toBe("the-raw-device-token-aaaaaaaaaaaaaaaaaa");
      expect(r.body.branch_id).toBe(STORE_X);
      expect(r.body.terminal_id).toBe(TERMINAL);
    }
  });
});

describe("toTerminalPairBody — projection", () => {
  it("maps store_id → branch_id and carries the raw token; com_port nullable", () => {
    const body = toTerminalPairBody(
      {
        tenant_id: TENANT,
        store_id: STORE_X,
        terminal_id: TERMINAL,
        terminal_label: "Counter 1",
        branch_name: "Branch X",
        branch_address: "Addr",
        tenant_tax_registration_id: "123456789",
        printer_vendor_id: "0x04B8",
        printer_product_id: "0x0202",
        printer_com_port: "COM3",
      },
      "raw-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(body.branch_id).toBe(STORE_X);
    expect(body.device_token).toBe("raw-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(body.printer_com_port).toBe("COM3");
    // Without the device's expiry (an older caller), expires_at is omitted.
    expect(body.expires_at).toBeUndefined();
  });

  it("populates expires_at from the minted device's expiry (RT-367 / RT-287 F9)", () => {
    const expiresAt = new Date("2027-01-15T10:00:00.000Z");
    const body = toTerminalPairBody(
      {
        tenant_id: TENANT,
        store_id: STORE_X,
        terminal_id: TERMINAL,
        terminal_label: "Counter 1",
        branch_name: "Branch X",
        branch_address: "Addr",
        tenant_tax_registration_id: "123456789",
        printer_vendor_id: "0x04B8",
        printer_product_id: "0x0202",
        printer_com_port: null,
      },
      "raw-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      expiresAt,
    );
    expect(body.expires_at).toBe("2027-01-15T10:00:00.000Z");
  });
});

describe("PairingService.pair — replacement codes (RT-367)", () => {
  it("a replacement the evaluator now blocks → replacement_blocked (the code stays pending)", async () => {
    const refundAttempt = jest.fn().mockResolvedValue(undefined);
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      refundAttempt,
      findPairedBranch: jest.fn().mockResolvedValue(null),
      burnAndProvision: jest.fn().mockResolvedValue("replacement_blocked"),
    });
    expect(await svc.pair("code-123456")).toEqual({ kind: "replacement_blocked" });
    // M1: a blocked try proves the caller holds the code; it gives its attempt back.
    expect(refundAttempt).toHaveBeenCalledWith(aRow().id, aRow().tenant_id);
  });

  it("does not refund the attempt of any other outcome", async () => {
    const refundAttempt = jest.fn().mockResolvedValue(undefined);
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      refundAttempt,
      findPairedBranch: jest.fn().mockResolvedValue(null),
      burnAndProvision: jest.fn().mockResolvedValue("lost_race"),
    });
    await svc.pair("code-123456");
    expect(refundAttempt).not.toHaveBeenCalled();
  });

  it("carries the minted device's expiry onto the body", async () => {
    const expiresAt = new Date("2027-01-15T10:00:00.000Z");
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      findPairedBranch: jest.fn().mockResolvedValue(null),
      burnAndProvision: jest.fn().mockResolvedValue({ kind: "ok", rawToken: "t".repeat(40), expiresAt }),
    });
    const r = await svc.pair("code-123456");
    expect(r.kind === "ok" ? r.body.expires_at : null).toBe("2027-01-15T10:00:00.000Z");
  });
});

describe("secret discipline — token + code never logged", () => {
  it("no console sink receives the raw token or the pairing_code", async () => {
    const spies = [
      jest.spyOn(console, "log").mockImplementation(() => {}),
      jest.spyOn(console, "info").mockImplementation(() => {}),
      jest.spyOn(console, "warn").mockImplementation(() => {}),
      jest.spyOn(console, "error").mockImplementation(() => {}),
      jest.spyOn(console, "debug").mockImplementation(() => {}),
    ];
    const RAW_TOKEN = "super-secret-device-token-zzzzzzzzzzzz";
    const RAW_CODE = "secret-code-99";
    const svc = serviceWith({
      findByCode: jest.fn().mockResolvedValue(aRow()),
      recordAttempt: jest.fn().mockResolvedValue(1),
      findPairedBranch: jest.fn().mockResolvedValue(null),
      burnAndProvision: jest.fn().mockResolvedValue(RAW_TOKEN),
    });
    await svc.pair(RAW_CODE);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const text = call.map((a) => String(a)).join(" ");
        expect(text).not.toContain(RAW_TOKEN);
        expect(text).not.toContain(RAW_CODE);
      }
      spy.mockRestore();
    }
  });
});
