/**
 * HeartbeatReportSchema — backlogIndicator is a Postgres int4.
 * 2147483648 must fail here (400), not reach the UPSERT as 22003/500.
 */
import { HeartbeatReportSchema } from "../../src/connector-health/dto/connector-heartbeat.dto";

const INT4_MAX = 2147483647;

describe("HeartbeatReportSchema backlogIndicator int4 bound", () => {
  it("accepts the int4 maximum", () => {
    const parsed = HeartbeatReportSchema.parse({ backlogIndicator: INT4_MAX });
    expect(parsed.backlogIndicator).toBe(INT4_MAX);
  });

  it("rejects one past the int4 maximum", () => {
    const result = HeartbeatReportSchema.safeParse({ backlogIndicator: INT4_MAX + 1 });
    expect(result.success).toBe(false);
  });
});
