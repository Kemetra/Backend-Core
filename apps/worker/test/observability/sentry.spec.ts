/**
 * Spec 037 US1 — worker Sentry wiring: default-inert, errors-only, injected SDK.
 * Unhandled rejections / uncaught exceptions are captured by the SDK's default
 * global-handler integrations once initialised; this spec pins the gating only.
 */
import * as Sentry from "@sentry/node";

import { initWorkerSentry } from "../../src/observability/sentry/sentry";

jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  onUnhandledRejectionIntegration: jest.fn((options: unknown) => ({ name: "OnUnhandledRejection", options })),
}));

const VALID_DSN = "https://abc123@o1.ingest.de.sentry.io/42";

describe("initWorkerSentry", () => {
  it("does not initialise the SDK when SENTRY_DSN is empty", () => {
    expect(initWorkerSentry({})).toBe("disabled");
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initialises the SDK once, errors-only, when a DSN is set", () => {
    expect(initWorkerSentry({ SENTRY_DSN: VALID_DSN })).toBe("initialized");
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const opts = (Sentry.init as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(opts["dsn"]).toBe(VALID_DSN);
    expect(opts["maxBreadcrumbs"]).toBe(0);
    expect(typeof opts["beforeSend"]).toBe("function");
    expect(opts["tracesSampleRate"]).toBeUndefined();
  });

  it("keeps crash-on-unhandled-rejection by using the SDK's strict mode", () => {
    initWorkerSentry({ SENTRY_DSN: VALID_DSN });
    expect(Sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: "strict" });
    const opts = (Sentry.init as jest.Mock).mock.calls[0]![0] as { integrations: unknown[] };
    expect(opts.integrations).toEqual([
      { name: "OnUnhandledRejection", options: { mode: "strict" } },
    ]);
  });

  it("does not throw when the SDK init throws", () => {
    (Sentry.init as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sdk down");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(initWorkerSentry({ SENTRY_DSN: VALID_DSN })).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
