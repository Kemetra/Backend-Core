/**
 * RT-369 — the rotation decision (`decideRotation`): which token the caller
 * presented and whether it may rotate. Pure; the guard and the locked
 * re-check in the service both use it.
 */
import { hashToken } from "@data-pulse-2/auth";

import {
  decideRotation,
  type RotationDeviceState,
} from "../../src/pos-terminal-pairing/rotation-decision";

const NOW = new Date("2026-10-17T12:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

const CURRENT = hashToken("current-token");
const PREVIOUS = hashToken("previous-token");
const OTHER = hashToken("other-token");

function state(overrides: Partial<RotationDeviceState> = {}): RotationDeviceState {
  return {
    tokenHash: CURRENT,
    previousTokenHash: PREVIOUS,
    previousValidUntil: at(5 * MIN),
    revokedAt: null,
    retiredAt: null,
    expiresAt: at(30 * DAY),
    now: NOW,
    ...overrides,
  };
}

describe("decideRotation", () => {
  it("allows the current token, not in grace", () => {
    expect(decideRotation(state(), CURRENT)).toEqual({ kind: "allowed", credential: "current", inGrace: false });
  });

  it("allows the previous token inside its window", () => {
    expect(decideRotation(state(), PREVIOUS)).toEqual({ kind: "allowed", credential: "previous", inGrace: false });
  });

  it("refuses the previous token at or after its window as previous_expired", () => {
    expect(decideRotation(state({ previousValidUntil: NOW }), PREVIOUS)).toEqual({
      kind: "rejected",
      reason: "previous_expired",
    });
  });

  it("refuses a hash that matches neither as token_replaced (another rotation replaced it)", () => {
    expect(decideRotation(state(), OTHER)).toEqual({ kind: "rejected", reason: "token_replaced" });
    expect(decideRotation(state({ previousTokenHash: null, previousValidUntil: null }), PREVIOUS)).toEqual({
      kind: "rejected",
      reason: "token_replaced",
    });
  });

  it("allows an expired device inside the 7-day grace, flagged in grace", () => {
    expect(decideRotation(state({ expiresAt: at(-6 * DAY) }), CURRENT)).toEqual({
      kind: "allowed",
      credential: "current",
      inGrace: true,
    });
    expect(decideRotation(state({ expiresAt: NOW }), CURRENT)).toMatchObject({ kind: "allowed", inGrace: true });
  });

  it("refuses at and after expires_at + 7 days as grace_elapsed", () => {
    expect(decideRotation(state({ expiresAt: at(-7 * DAY) }), CURRENT)).toEqual({
      kind: "rejected",
      reason: "grace_elapsed",
    });
  });

  it("refuses a revoked device, never in grace", () => {
    expect(decideRotation(state({ revokedAt: at(-MIN) }), CURRENT)).toEqual({ kind: "rejected", reason: "revoked" });
  });

  it("refuses a retired device as retired (retired implies revoked)", () => {
    expect(decideRotation(state({ revokedAt: at(-MIN), retiredAt: at(-MIN) }), CURRENT)).toEqual({
      kind: "rejected",
      reason: "retired",
    });
  });

  it("checks retired and revoked before the token match and grace", () => {
    const dead = state({ revokedAt: at(-MIN), expiresAt: at(-30 * DAY), previousValidUntil: at(-MIN) });
    expect(decideRotation(dead, PREVIOUS)).toEqual({ kind: "rejected", reason: "revoked" });
  });

  it("checks the token match before grace", () => {
    expect(decideRotation(state({ expiresAt: at(-30 * DAY) }), OTHER)).toEqual({
      kind: "rejected",
      reason: "token_replaced",
    });
    expect(decideRotation(state({ expiresAt: at(-30 * DAY), previousValidUntil: at(-MIN) }), PREVIOUS)).toEqual({
      kind: "rejected",
      reason: "previous_expired",
    });
  });
});
