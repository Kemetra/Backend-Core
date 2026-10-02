/**
 * DeviceRepository — unit spec (no Postgres).
 *
 * The only branch that is unreachable via HTTP-level integration tests
 * is the early-return guard at the top of `findActiveByAttestation`:
 *
 *   if (rawAttestation.length === 0) return null;
 *
 * When called via the HTTP endpoint the Zod schema enforces `.min(1)` on
 * `device_token_attestation`, so an empty string never reaches the repo.
 * This spec calls the method directly with an empty string to cover that
 * defensive branch without standing up a Postgres container.
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { DeviceRepository } from "../../src/pos-operators/device.repository";

describe("DeviceRepository.findActiveByAttestation — empty attestation guard", () => {
  it("returns null immediately for an empty attestation string without querying the DB", async () => {
    // The pool is never called when the attestation is empty.
    const fakePool = {
      query: jest.fn().mockRejectedValue(new Error("should not be called")),
    } as unknown as Pool;

    const repo = new DeviceRepository(fakePool);
    const result = await repo.findActiveByAttestation("");

    expect(result).toBeNull();
    expect((fakePool as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });
});
