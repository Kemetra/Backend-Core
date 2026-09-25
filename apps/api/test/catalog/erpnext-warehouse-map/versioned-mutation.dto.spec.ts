/**
 * VersionedMutationRequest — version is a Postgres int4 bound into SQL
 * (`WHERE version = $2`). 2147483648 must fail validation, not 22003.
 */
import { VersionedMutationRequestSchema } from "../../../src/catalog/erpnext-warehouse-map/dto/versioned-mutation-request.dto";

const INT4_MAX = 2147483647;

describe("warehouse-map VersionedMutationRequest version int4 bound", () => {
  it("accepts version 1", () => {
    expect(VersionedMutationRequestSchema.parse({ version: 1 }).version).toBe(1);
  });

  it("accepts the int4 maximum", () => {
    expect(VersionedMutationRequestSchema.parse({ version: INT4_MAX }).version).toBe(INT4_MAX);
  });

  it("rejects 2147483648", () => {
    expect(VersionedMutationRequestSchema.safeParse({ version: INT4_MAX + 1 }).success).toBe(false);
  });
});
