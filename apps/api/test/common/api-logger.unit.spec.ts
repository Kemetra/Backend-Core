/**
 * RT-684 (OBS-9 F-D) — api log lines carry the OBS-1 service name
 * `backend-api` (D4). Module loggers name themselves by `component`.
 *
 * `getRootLogger()` and every module-local api logger are built by
 * `createApiLogger`, so the emitted line is asserted here once.
 */
import { API_SERVICE_NAME, createApiLogger } from "../../src/common/api-logger";

function captureOne(component?: string): Record<string, unknown> {
  const lines: string[] = [];
  createApiLogger(component, { write: (line: string) => void lines.push(line) }).warn("rt684 probe");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
}

describe("createApiLogger (RT-684)", () => {
  it("uses the OBS-1 api service name", () => {
    expect(API_SERVICE_NAME).toBe("backend-api");
  });

  it("writes service backend-api on every line, with no component for the root logger", () => {
    const line = captureOne();

    expect(line).toMatchObject({ service: "backend-api", message: "rt684 probe" });
    expect(line).not.toHaveProperty("component");
  });

  it("names a module logger by component, not by service", () => {
    expect(captureOne("pos-shifts")).toMatchObject({ service: "backend-api", component: "pos-shifts" });
  });
});
