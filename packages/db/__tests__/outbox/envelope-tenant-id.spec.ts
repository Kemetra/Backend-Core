import { outboxEnvelopeTenantId } from "../../src/outbox/repository";

const NIL = "00000000-0000-0000-0000-000000000000";
const TENANT = "11111111-1111-4111-8111-111111111111";

describe("outboxEnvelopeTenantId", () => {
  it("presents a stored NULL platform row as the nil UUID", () => {
    expect(outboxEnvelopeTenantId(null)).toBe(NIL);
  });

  it("leaves a real tenant id unchanged", () => {
    expect(outboxEnvelopeTenantId(TENANT)).toBe(TENANT);
  });
});
