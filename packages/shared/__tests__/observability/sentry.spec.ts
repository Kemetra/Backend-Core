/**
 * Spec 037 US1 — Sentry error export: default-inert init + allowlist scrubber.
 * Pure module: no `@sentry/node` import; the SDK init is injected.
 */
import {
  SENTRY_FORBIDDEN_KEYS,
  initSentry,
  resolveSentryConfig,
  scrubSentryEvent,
  type SentryEventLike,
} from "../../src/observability/sentry";

const VALID_DSN = "https://abc123@o1.ingest.de.sentry.io/42";

describe("resolveSentryConfig (AC-1 default-inert)", () => {
  it.each([undefined, "", "   "])("returns null for DSN %p", (dsn) => {
    expect(resolveSentryConfig({ SENTRY_DSN: dsn })).toBeNull();
  });

  it("returns null for a malformed DSN", () => {
    expect(resolveSentryConfig({ SENTRY_DSN: "not-a-dsn" })).toBeNull();
    expect(resolveSentryConfig({ SENTRY_DSN: "ftp://x@y/1" })).toBeNull();
  });

  it("returns the trimmed DSN plus environment and release", () => {
    expect(
      resolveSentryConfig({
        SENTRY_DSN: `  ${VALID_DSN}  `,
        SENTRY_ENVIRONMENT: "pilot",
        SENTRY_RELEASE: "abc1234",
      }),
    ).toEqual({ dsn: VALID_DSN, environment: "pilot", release: "abc1234" });
  });

  it("falls back to DEPLOYMENT_ENVIRONMENT then 'unknown'; release stays unset", () => {
    expect(
      resolveSentryConfig({ SENTRY_DSN: VALID_DSN, DEPLOYMENT_ENVIRONMENT: "prod" }),
    ).toEqual({ dsn: VALID_DSN, environment: "prod" });
    expect(resolveSentryConfig({ SENTRY_DSN: VALID_DSN })).toEqual({
      dsn: VALID_DSN,
      environment: "unknown",
    });
  });
});

describe("initSentry (AC-1, AC-3)", () => {
  it("does not call the SDK when the DSN is empty", () => {
    const sentryInit = jest.fn();
    const warn = jest.fn();
    expect(initSentry({}, { sentryInit, warn })).toBe("disabled");
    expect(sentryInit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once, never echoing the DSN, for a malformed DSN, and does not throw", () => {
    const sentryInit = jest.fn();
    const warn = jest.fn();
    const result = initSentry({ SENTRY_DSN: "garbage-dsn-secret" }, { sentryInit, warn });
    expect(result).toBe("disabled");
    expect(sentryInit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("garbage-dsn-secret");
  });

  it("initialises the SDK with safe, errors-only options", () => {
    const sentryInit = jest.fn();
    expect(
      initSentry({ SENTRY_DSN: VALID_DSN, SENTRY_ENVIRONMENT: "pilot" }, { sentryInit, warn: jest.fn() }),
    ).toBe("initialized");
    expect(sentryInit).toHaveBeenCalledTimes(1);
    const opts = sentryInit.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts["dsn"]).toBe(VALID_DSN);
    expect(opts["environment"]).toBe("pilot");
    expect(opts["maxBreadcrumbs"]).toBe(0);
    expect(opts["tracesSampleRate"]).toBeUndefined();
    expect(opts["enableOpenTelemetrySetup"]).toBe(false);
    expect(opts["enableRuntimeChannelInjection"]).toBe(false);
    expect(opts["beforeSend"]).toBe(scrubSentryEvent);
    expect("release" in opts).toBe(false);
  });

  it("passes release through when set", () => {
    const sentryInit = jest.fn();
    initSentry({ SENTRY_DSN: VALID_DSN, SENTRY_RELEASE: "r1" }, { sentryInit, warn: jest.fn() });
    expect((sentryInit.mock.calls[0]![0] as Record<string, unknown>)["release"]).toBe("r1");
  });

  it("catches a throwing SDK init, warns once without the DSN, and continues", () => {
    const sentryInit = jest.fn(() => {
      throw new Error(`boom ${VALID_DSN}`);
    });
    const warn = jest.fn();
    expect(initSentry({ SENTRY_DSN: VALID_DSN }, { sentryInit, warn })).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(VALID_DSN);
  });
});

describe("scrubSentryEvent (AC-2)", () => {
  const dirty: SentryEventLike = {
    event_id: "e1",
    timestamp: 1,
    platform: "node",
    level: "error",
    environment: "pilot",
    release: "r1",
    server_name: "ip-172-26-2-233",
    request: { headers: { cookie: "dp2_session=SECRET", authorization: "Bearer TOKEN" }, data: { email: "a@b.c" } },
    user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
    extra: { sale: { total: 100 } },
    contexts: { trace: { trace_id: "t" }, culture: { locale: "ar-EG" } },
    breadcrumbs: [{ message: "GET /v1/tenants/123" }],
    transaction: "/v1/tenants/123/sales",
    tags: { route: "/v1/sales/:id", email: "a@b.c", token: "x", ok_count: 3 as unknown as string },
    exception: {
      values: [
        {
          type: "error",
          value:
            'duplicate key value violates unique constraint "u_email" Key (email)=(a@b.c) already exists.',
          stacktrace: {
            frames: [
              {
                filename: "/app/apps/api/dist/x.js",
                function: "handler",
                lineno: 10,
                colno: 2,
                module: "x",
                in_app: true,
                vars: { password: "p" },
                context_line: "const password = 'p'",
                pre_context: ["a"],
                post_context: ["b"],
              },
            ],
          },
        },
      ],
    },
  };

  it("drops request, user, extra, contexts, breadcrumbs and transaction", () => {
    const out = scrubSentryEvent(dirty)!;
    for (const k of ["request", "user", "extra", "contexts", "breadcrumbs", "transaction"]) {
      expect(k in out).toBe(false);
    }
  });

  it("keeps only allowlisted top-level fields", () => {
    const out = scrubSentryEvent(dirty)!;
    expect(out).toMatchObject({
      event_id: "e1",
      platform: "node",
      level: "error",
      environment: "pilot",
      release: "r1",
    });
  });

  it("drops forbidden tag keys and non-string tag values, keeps safe ones", () => {
    const out = scrubSentryEvent(dirty)!;
    expect(out.tags).toEqual({ route: "/v1/sales/:id" });
  });

  it("strips Postgres 'Key (col)=(value)' detail and truncates long messages", () => {
    const out = scrubSentryEvent(dirty)!;
    const value = out.exception!.values![0]!.value!;
    expect(value).not.toContain("a@b.c");
    expect(value).toContain("Key (...)=(...)");

    const long = scrubSentryEvent({
      exception: { values: [{ type: "Error", value: "x".repeat(2000) }] },
    })!;
    expect(long.exception!.values![0]!.value!.length).toBeLessThanOrEqual(300);
  });

  it("masks JWTs (Clerk tokens) and URL userinfo/query strings in messages", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2lnbmF0dXJl";
    const out = scrubSentryEvent({
      exception: {
        values: [
          {
            type: "Error",
            value: `bad token ${jwt}; POST https://erp:s3cr3t@erp.example.test/api/resource/Item?api_key=K&x=1#frag failed`,
          },
        ],
      },
    })!;
    const value = out.exception!.values![0]!.value!;
    expect(value).toContain("[jwt]");
    expect(value).not.toContain("eyJ");
    expect(value).not.toContain("s3cr3t");
    expect(value).not.toContain("api_key");
    expect(value).toContain("https://erp.example.test/api/resource/Item");
  });

  it("stays fast on adversarial messages (no polynomial regex backtracking)", () => {
    const adversarial = [
      "Key (".repeat(50_000),
      "a.".repeat(50_000),
      "eyJ-".repeat(50_000),
      "x@".repeat(50_000),
      `${"/".repeat(50_000)}://`,
    ];
    const started = Date.now();
    for (const value of adversarial) {
      const out = scrubSentryEvent({ exception: { values: [{ type: "Error", value }] } })!;
      expect(out.exception!.values![0]!.value!.length).toBeLessThanOrEqual(300);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("keeps stack frame location but never vars or source context", () => {
    const frame = scrubSentryEvent(dirty)!.exception!.values![0]!.stacktrace!.frames![0]!;
    expect(frame).toEqual({
      filename: "/app/apps/api/dist/x.js",
      function: "handler",
      lineno: 10,
      colno: 2,
      module: "x",
      in_app: true,
    });
  });

  it("returns null when no exception remains (nothing safe to send)", () => {
    expect(scrubSentryEvent({ message: "free text with PII a@b.c", level: "error" })).toBeNull();
    expect(scrubSentryEvent({ exception: { values: [] } })).toBeNull();
  });

  it("does not mutate its input", () => {
    const copy = JSON.parse(JSON.stringify(dirty)) as SentryEventLike;
    scrubSentryEvent(dirty);
    expect(dirty).toEqual(copy);
  });
});

describe("SENTRY_FORBIDDEN_KEYS (T003: derived from the redaction matrix, not forked)", () => {
  it("contains credential and PII keys from the logger redact list", () => {
    for (const key of ["password", "token", "authorization", "cookie", "email", "phone", "full_name", "body"]) {
      expect(SENTRY_FORBIDDEN_KEYS.has(key)).toBe(true);
    }
  });
});
