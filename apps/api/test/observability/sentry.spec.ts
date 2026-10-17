/**
 * Spec 037 US1 — api Sentry wiring: default-inert, errors-only, injected SDK.
 * `@sentry/node` is mocked; no event leaves the process.
 */
import * as Sentry from "@sentry/node";

import { captureServerError, initApiSentry } from "../../src/observability/sentry/sentry";

jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  onUnhandledRejectionIntegration: jest.fn((options: unknown) => ({ name: "OnUnhandledRejection", options })),
}));

const VALID_DSN = "https://abc123@o1.ingest.de.sentry.io/42";

describe("initApiSentry", () => {
  it("does not initialise the SDK when SENTRY_DSN is empty", () => {
    expect(initApiSentry({})).toBe("disabled");
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initialises the SDK once with the scrubbing hook when a DSN is set", () => {
    expect(initApiSentry({ SENTRY_DSN: VALID_DSN, SENTRY_ENVIRONMENT: "pilot" })).toBe("initialized");
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const opts = (Sentry.init as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(opts["dsn"]).toBe(VALID_DSN);
    expect(opts["maxBreadcrumbs"]).toBe(0);
    expect(typeof opts["beforeSend"]).toBe("function");
    expect(opts["tracesSampleRate"]).toBeUndefined();
  });

  it("keeps crash-on-unhandled-rejection by using the SDK's strict mode", () => {
    initApiSentry({ SENTRY_DSN: VALID_DSN });
    expect(Sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: "strict" });
    const opts = (Sentry.init as jest.Mock).mock.calls[0]![0] as { integrations: unknown[] };
    expect(opts.integrations).toEqual([
      { name: "OnUnhandledRejection", options: { mode: "strict" } },
    ]);
  });
});

describe("captureServerError", () => {
  it("forwards the exception to the SDK", () => {
    const err = new Error("boom");
    captureServerError(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: {} });
  });

  it("tags the capture with a well-formed request_id (OBS-1 §2)", () => {
    const err = new Error("boom");
    captureServerError(err, "018f3b1d-7c2a-7e3a-9bcd-0123456789ab");
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { request_id: "018f3b1d-7c2a-7e3a-9bcd-0123456789ab" },
    });
  });

  it("never throws if the SDK throws", () => {
    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sdk down");
    });
    expect(() => captureServerError(new Error("x"))).not.toThrow();
  });
});
