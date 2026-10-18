/**
 * RT-563 — unit tests for the connector_health domain rollup (pure function).
 */
import { rollupConnectorHealth } from "../../../src/catalog/erpnext-sync-ops/connector-health-rollup";

describe("rollupConnectorHealth (RT-563)", () => {
  it("no instances -> not_available (never ok)", () => {
    expect(rollupConnectorHealth([])).toEqual({
      domain: "connector_health",
      status: "not_available",
      headlineCount: null,
      detail: "No connector instances registered",
    });
  });

  it("only disabled instances -> not_available", () => {
    const r = rollupConnectorHealth(["disabled", "disabled"]);
    expect(r.status).toBe("not_available");
    expect(r.headlineCount).toBeNull();
  });

  it("all never_seen -> attention, never ok", () => {
    const r = rollupConnectorHealth(["never_seen", "never_seen"]);
    expect(r.status).toBe("attention");
    expect(r.headlineCount).toBe(2);
    expect(r.detail).toBe("2 of 2 connector instance(s) not healthy (0 stale, 2 never seen)");
  });

  it("mixed healthy + stale -> attention with the unhealthy count", () => {
    const r = rollupConnectorHealth(["healthy", "stale", "healthy"]);
    expect(r.status).toBe("attention");
    expect(r.headlineCount).toBe(1);
    expect(r.detail).toBe("1 of 3 connector instance(s) not healthy (1 stale, 0 never seen)");
  });

  it("healthy + never_seen -> attention", () => {
    const r = rollupConnectorHealth(["healthy", "never_seen"]);
    expect(r.status).toBe("attention");
    expect(r.headlineCount).toBe(1);
  });

  it("all healthy -> ok", () => {
    const r = rollupConnectorHealth(["healthy", "healthy"]);
    expect(r).toEqual({
      domain: "connector_health",
      status: "ok",
      headlineCount: 0,
      detail: "All 2 active connector instance(s) healthy",
    });
  });

  it("disabled instances are ignored when active ones exist", () => {
    expect(rollupConnectorHealth(["healthy", "disabled"]).status).toBe("ok");
    expect(rollupConnectorHealth(["stale", "disabled"]).status).toBe("attention");
  });
});
