/**
 * Spec 037 US1 — Sentry error export: default-inert init + allowlist scrubber.
 * Pure module: no `@sentry/node` import; the SDK init is injected.
 */
import { context, trace } from "@opentelemetry/api";

import { createTestTracerProvider } from "../../src/observability/bullmq-propagation";
import {
  SENTRY_ALLOWED_TAG_KEYS,
  SENTRY_FORBIDDEN_KEYS,
  initSentry,
  resolveSentryConfig,
  scrubSentryEvent,
  sentryCorrelationTags,
  type SentryEventLike,
} from "../../src/observability/sentry";
import goldenVectors from "./obs1-golden-vectors.json";

const VALID_DSN = "https://abc123@o1.ingest.de.sentry.io/42";
const SERVICE = "backend-api";
const SHA12 = "36bb0c7e1f2a";
const REQUEST_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

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
        SENTRY_RELEASE: SHA12,
      }),
    ).toEqual({ dsn: VALID_DSN, environment: "pilot", release: SHA12 });
  });

  it("drops a release that is not a SHA12 (OBS-1 §1: release = SHA12)", () => {
    expect(
      resolveSentryConfig({ SENTRY_DSN: VALID_DSN, SENTRY_RELEASE: "abc1234" }),
    ).toEqual({ dsn: VALID_DSN, environment: "unknown" });
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
    expect(initSentry({}, { sentryInit, warn, service: SERVICE })).toBe("disabled");
    expect(sentryInit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once, never echoing the DSN, for a malformed DSN, and does not throw", () => {
    const sentryInit = jest.fn();
    const warn = jest.fn();
    const result = initSentry({ SENTRY_DSN: "garbage-dsn-secret" }, { sentryInit, warn, service: SERVICE });
    expect(result).toBe("disabled");
    expect(sentryInit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("garbage-dsn-secret");
  });

  it("initialises the SDK with safe, errors-only options", () => {
    const sentryInit = jest.fn();
    expect(
      initSentry({ SENTRY_DSN: VALID_DSN, SENTRY_ENVIRONMENT: "pilot" }, { sentryInit, warn: jest.fn(), service: SERVICE }),
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
    initSentry({ SENTRY_DSN: VALID_DSN, SENTRY_RELEASE: SHA12 }, { sentryInit, warn: jest.fn(), service: SERVICE });
    expect((sentryInit.mock.calls[0]![0] as Record<string, unknown>)["release"]).toBe(SHA12);
  });

  it("tags every event with the contract service and version (OBS-1 §1)", () => {
    const sentryInit = jest.fn();
    initSentry({ SENTRY_DSN: VALID_DSN, SENTRY_RELEASE: SHA12 }, { sentryInit, warn: jest.fn(), service: SERVICE });
    const opts = sentryInit.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts["initialScope"]).toEqual({ tags: { service: SERVICE, version: SHA12 } });
  });

  it("omits the version tag when no SHA12 release is configured", () => {
    const sentryInit = jest.fn();
    initSentry({ SENTRY_DSN: VALID_DSN }, { sentryInit, warn: jest.fn(), service: "backend-worker" });
    const opts = sentryInit.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts["initialScope"]).toEqual({ tags: { service: "backend-worker" } });
  });

  it("catches a throwing SDK init, warns once without the DSN, and continues", () => {
    const sentryInit = jest.fn(() => {
      throw new Error(`boom ${VALID_DSN}`);
    });
    const warn = jest.fn();
    expect(initSentry({ SENTRY_DSN: VALID_DSN }, { sentryInit, warn, service: SERVICE })).toBe("failed");
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

  const scrubTagsOf = (tags: Record<string, unknown>): Record<string, unknown> | undefined =>
    scrubSentryEvent({ tags, exception: { values: [{ type: "Error", value: "x" }] } })!.tags;

  it("keeps contract tags and well-formed correlation ids", () => {
    const tags = {
      service: SERVICE,
      version: SHA12,
      env: "staging",
      method: "GET",
      status: "500",
      request_id: REQUEST_ID,
      trace_id: TRACE_ID,
    };
    expect(scrubTagsOf(tags)).toEqual(tags);
  });

  it("drops tags outside the allowlist, even when their key is not a known secret (OBS-1 §1)", () => {
    expect(
      scrubTagsOf({
        tenant_id: "t1",
        store_id: "s1",
        user_id: "u1",
        actor_id: "a1",
        device_id: "d1",
        sale_id: "x1",
        free_text: "anything",
        transaction: "/v1/tenants/123/sales",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["request_id not a UUID", { request_id: "a@b.c" }],
    ["request_id with a suffix", { request_id: `${REQUEST_ID}x` }],
    ["trace_id not hex", { trace_id: "z".repeat(32) }],
    ["trace_id wrong length", { trace_id: TRACE_ID.slice(1) }],
    ["trace_id all zeros (invalid trace)", { trace_id: "0".repeat(32) }],
  ])("drops a malformed correlation tag (%s)", (_label, tags) => {
    expect(scrubTagsOf(tags)).toBeUndefined();
  });

  it("never allowlists a key from the redaction matrix", () => {
    for (const key of SENTRY_ALLOWED_TAG_KEYS) {
      expect(SENTRY_FORBIDDEN_KEYS.has(key)).toBe(false);
    }
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

  const scrubValue = (value: string): string =>
    scrubSentryEvent({ exception: { values: [{ type: "Error", value }] } })!.exception!.values![0]!.value!;

  it.each([
    ["key=value prefix", "token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln rejected"],
    ["quoted", 'bad "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" token'],
  ])("masks a JWT that is not at the start of its token (%s)", (_label, value) => {
    const out = scrubValue(value);
    expect(out).toContain("[jwt]");
    expect(out).not.toContain("eyJ");
  });

  it.each([
    ["key=value prefix", "url=https://erp.example.test/api?api_key=SECRET failed", "url=https://erp.example.test/api failed"],
    ["quoted", 'call "https://erp.example.test/api?token=abc" failed', 'call "https://erp.example.test/api" failed'],
    ["userinfo", "GET https://u:SECRET@erp.example.test/x", "GET https://erp.example.test/x"],
  ])("strips URL secrets wherever the URL sits in its token (%s)", (_label, value, expected) => {
    expect(scrubValue(value)).toBe(expected);
  });

  it("masks a URL it cannot parse instead of passing it through", () => {
    const out = scrubValue("bad=http://[::not-a-host/?token=SECRET");
    expect(out).toBe("bad=[url]");
  });

  it("masks Postgres row values even when they contain parentheses", () => {
    const keyDetail = scrubValue('duplicate key "u_name" Key (name)=(Acme (Cairo) Ltd) already exists.');
    expect(keyDetail).toBe('duplicate key "u_name" Key (...)=(...)');
    const failingRow = scrubValue("new row violates check. Failing row contains (1, Acme (Cairo), 01012345678).");
    expect(failingRow).toBe("new row violates check. Failing row contains (...)");
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

describe("OBS-1 §3.5 golden vectors (RT-682: Bearer/Authorization and phones)", () => {
  const scrubValue = (value: string): string =>
    scrubSentryEvent({ exception: { values: [{ type: "Error", value }] } })!.exception!.values![0]!.value!;

  it.each(goldenVectors.vectors.map((v) => [v.id, v.input, v.expected] as const))(
    "%s: masks exactly as the contract vector says",
    (_id, input, expected) => {
      expect(scrubValue(input)).toBe(expected);
    },
  );

  it.each([
    ["a national mobile behind a stray +", "call +01012345678 now", "call +[phone] now"],
    ["a country-code mobile glued to a letter before the +", "x+201000000638 kept", "x+[phone] kept"],
    ["a trailing Authorization with nothing after it", "missing Authorization:", "missing Authorization:"],
  ])("follows the §3.2 phone/Authorization text on %s", (_label, input, expected) => {
    expect(scrubValue(input)).toBe(expected);
  });

  it("stays linear on the contract's adversarial inputs", () => {
    const { inputs, maxOutputLength, maxTotalMs } = goldenVectors.linearTime;
    const started = Date.now();
    for (const { pattern, repeat } of inputs) {
      expect(scrubValue(pattern.repeat(repeat)).length).toBeLessThanOrEqual(maxOutputLength);
    }
    expect(Date.now() - started).toBeLessThan(maxTotalMs);
  });

  it("stays linear when the inputs exceed the scan cap many times over", () => {
    const adversarial = ["Bearer ".repeat(50_000), "1".repeat(100_000), "+1".repeat(50_000), "a:Authorization: ".repeat(10_000)];
    const started = Date.now();
    for (const value of adversarial) expect(scrubValue(value).length).toBeLessThanOrEqual(300);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("sentryCorrelationTags (RT-631: request_id + active trace_id)", () => {
  it("returns only a well-formed request_id when no span is active", () => {
    expect(sentryCorrelationTags(REQUEST_ID)).toEqual({ request_id: REQUEST_ID });
    expect(sentryCorrelationTags("not-a-uuid")).toEqual({});
    expect(sentryCorrelationTags(undefined)).toEqual({});
  });

  describe("with a registered tracer provider", () => {
    let teardown: () => Promise<void>;

    beforeEach(() => {
      teardown = createTestTracerProvider().teardown;
    });

    afterEach(async () => {
      await teardown();
      context.disable();
      trace.disable();
    });

    it("adds the active span's trace_id", () => {
      const span = trace.getTracer("t").startSpan("http.server");
      const tags = context.with(trace.setSpan(context.active(), span), () =>
        sentryCorrelationTags(REQUEST_ID),
      );
      span.end();
      expect(tags).toEqual({ request_id: REQUEST_ID, trace_id: span.spanContext().traceId });
      expect(tags["trace_id"]).toMatch(/^[0-9a-f]{32}$/);
    });

    it("adds no trace_id outside any span", () => {
      expect(sentryCorrelationTags(REQUEST_ID)).toEqual({ request_id: REQUEST_ID });
    });
  });
});

describe("SENTRY_FORBIDDEN_KEYS (T003: derived from the redaction matrix, not forked)", () => {
  it("contains credential and PII keys from the logger redact list", () => {
    for (const key of ["password", "token", "authorization", "cookie", "email", "phone", "full_name", "body"]) {
      expect(SENTRY_FORBIDDEN_KEYS.has(key)).toBe(true);
    }
  });
});
