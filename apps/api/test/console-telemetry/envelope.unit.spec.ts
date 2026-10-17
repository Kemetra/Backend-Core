/**
 * RT-632 (OBS-3) — Sentry envelope parse / rebuild for the Console tunnel.
 * Pure: no app, no HTTP.
 */
import {
  EnvelopeMalformedError,
  MAX_ENVELOPE_ITEMS,
  buildForwardEnvelope,
} from "../../src/console-telemetry/envelope";

const EVENT_ID = "0123456789abcdef0123456789abcdef";

function errorEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    timestamp: 1_760_000_000,
    platform: "javascript",
    level: "error",
    environment: "staging",
    release: "abcdef123456",
    tags: { service: "admin-console", cookie: "dp2_session=secret" },
    request: { url: "https://lab.example/console?token=x", headers: { Cookie: "dp2_session=secret" } },
    user: { email: "owner@example.com", ip_address: "10.0.0.1" },
    extra: { body: "sale lines" },
    contexts: { browser: { name: "Chrome" } },
    breadcrumbs: [{ message: "clicked" }],
    exception: {
      values: [
        {
          type: "TypeError",
          value: "failed for owner@example.com at https://u:p@lab.example/x?api_key=k",
          stacktrace: { frames: [{ filename: "app.js", lineno: 3, vars: { password: "p" } }] },
        },
      ],
    },
    ...overrides,
  };
}

function envelope(header: unknown, items: Array<{ header: unknown; payload: string | Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from(`${JSON.stringify(header)}\n`)];
  for (const item of items) {
    parts.push(Buffer.from(`${JSON.stringify(item.header)}\n`));
    parts.push(Buffer.isBuffer(item.payload) ? item.payload : Buffer.from(item.payload));
    parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

function eventItem(event: unknown, withLength = true): { header: unknown; payload: string } {
  const payload = JSON.stringify(event);
  return {
    header: withLength ? { type: "event", length: Buffer.byteLength(payload) } : { type: "event" },
    payload,
  };
}

/** Splits a rebuilt envelope into its three JSON lines. */
function decode(out: Buffer): { header: Record<string, unknown>; itemHeader: Record<string, unknown>; event: Record<string, unknown> } {
  const lines = out.toString("utf8").split("\n");
  expect(lines).toHaveLength(4);
  expect(lines[3]).toBe("");
  return {
    header: JSON.parse(lines[0]!) as Record<string, unknown>,
    itemHeader: JSON.parse(lines[1]!) as Record<string, unknown>,
    event: JSON.parse(lines[2]!) as Record<string, unknown>,
  };
}

const FOREIGN_DSN = "https://otherkey@o999.ingest.us.sentry.io/4242";
const SERVER_ENV = "lab";

function build(body: Buffer): Buffer | null {
  return buildForwardEnvelope(body, SERVER_ENV);
}

describe("buildForwardEnvelope", () => {
  it("rebuilds the header without the inbound dsn, sdk or trace context", () => {
    const body = envelope(
      {
        event_id: EVENT_ID,
        sent_at: "2026-10-17T10:00:00.000Z",
        dsn: FOREIGN_DSN,
        sdk: { name: "sentry.javascript.react", version: "9.0.0" },
        trace: { transaction: "/tenants/123/sales", public_key: "otherkey" },
      },
      [eventItem(errorEvent())],
    );

    const { header } = decode(build(body)!);

    expect(header).toEqual({ event_id: EVENT_ID, sent_at: "2026-10-17T10:00:00.000Z" });
    expect(JSON.stringify(header)).not.toContain("otherkey");
  });

  it("applies the shared allowlist scrubber to the event", () => {
    const { event, itemHeader } = decode(build(envelope({ event_id: EVENT_ID }, [eventItem(errorEvent())]))!);

    for (const dropped of ["request", "user", "extra", "contexts", "breadcrumbs"]) {
      expect(event).not.toHaveProperty(dropped);
    }
    expect(event["tags"]).toEqual({ service: "admin-console" });
    const value = (event["exception"] as { values: Array<{ value: string; stacktrace: { frames: unknown[] } }> }).values[0]!;
    expect(value.value).toBe("failed for [email] at https://lab.example/x");
    expect(value.stacktrace.frames).toEqual([{ filename: "app.js", lineno: 3 }]);
    expect(itemHeader).toEqual({ type: "event", length: Buffer.byteLength(JSON.stringify(event)) });
  });

  it("stamps the server environment over the Console's", () => {
    const { event } = decode(build(envelope({}, [eventItem(errorEvent({ environment: "spoofed-prod" }))]))!);
    expect(event["environment"]).toBe(SERVER_ENV);
  });

  it("rebuilds sdk with infer_ip never, keeping only a short plain name and version", () => {
    const inbound = { name: "sentry.javascript.react", version: "11.0.0", integrations: ["x"], packages: [{ name: "p" }] };
    const kept = decode(build(envelope({}, [eventItem(errorEvent({ sdk: inbound }))]))!).event;
    expect(kept["sdk"]).toEqual({
      name: "sentry.javascript.react",
      version: "11.0.0",
      settings: { infer_ip: "never" },
    });

    const odd = { name: "owner@example.com", version: "x".repeat(100) };
    const replaced = decode(build(envelope({}, [eventItem(errorEvent({ sdk: odd }))]))!).event;
    expect(replaced["sdk"]).toEqual({
      name: "backend-core.console-tunnel",
      version: "1.0.0",
      settings: { infer_ip: "never" },
    });
    const missing = decode(build(envelope({}, [eventItem(errorEvent())]))!).event;
    expect((missing["sdk"] as { settings: unknown }).settings).toEqual({ infer_ip: "never" });
  });

  it("drops user and IP data the envelope carries", () => {
    const out = build(envelope({}, [eventItem(errorEvent({ user: { ip_address: "{{auto}}", id: "u1" } }))]))!;
    const { event } = decode(out);
    expect(event).not.toHaveProperty("user");
    expect(out.toString("utf8")).not.toContain("{{auto}}");
    expect(out.toString("utf8")).not.toContain("10.0.0.1");
  });

  it("forwards only the first event and drops every other item type", () => {
    const body = envelope({ event_id: EVENT_ID }, [
      { header: { type: "session" }, payload: JSON.stringify({ sid: "s", status: "ok" }) },
      { header: { type: "replay_recording", length: 3 }, payload: Buffer.from([0x0a, 0xff, 0x0a]) },
      { header: { type: "attachment", length: 5, filename: "dump.txt" }, payload: "a\nb\nc" },
      eventItem(errorEvent()),
      eventItem(errorEvent({ event_id: "ffffffffffffffffffffffffffffffff" })),
      { header: { type: "transaction" }, payload: JSON.stringify({ transaction: "/x" }) },
      { header: { type: "client_report" }, payload: JSON.stringify({ discarded_events: [] }) },
    ]);

    const { event } = decode(build(body)!);

    expect(event["event_id"]).toBe(EVENT_ID);
  });

  it("returns null when no error event is present (sessions / replays only)", () => {
    const body = envelope({}, [
      { header: { type: "session" }, payload: JSON.stringify({ sid: "s" }) },
      { header: { type: "replay_event" }, payload: JSON.stringify({ replay_id: "r" }) },
    ]);
    expect(build(body)).toBeNull();
  });

  it("returns null when the scrubber drops the event (no exception)", () => {
    const body = envelope({}, [eventItem({ event_id: EVENT_ID, message: "hello owner@example.com" })]);
    expect(build(body)).toBeNull();
  });

  it("reads a length-delimited multibyte payload by bytes", () => {
    const event = errorEvent({
      exception: { values: [{ type: "Error", value: "فشل التحميل — ✓ émoji 😀" }] },
    });
    const payload = JSON.stringify(event);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(payload.length);
    const body = envelope({}, [
      { header: { type: "attachment", length: Buffer.byteLength("✓\n😀") }, payload: "✓\n😀" },
      { header: { type: "event", length: Buffer.byteLength(payload) }, payload },
    ]);

    const decoded = decode(build(body)!);

    const values = (decoded.event["exception"] as { values: Array<{ value: string }> }).values;
    expect(values[0]!.value).toBe("فشل التحميل — ✓ émoji 😀");
    expect(decoded.itemHeader["length"]).toBe(Buffer.byteLength(JSON.stringify(decoded.event)));
  });

  it("accepts a newline-delimited event without length and a missing trailing newline", () => {
    const body = Buffer.from(`{}\n{"type":"event"}\n${JSON.stringify(errorEvent())}`);
    expect(build(body)).not.toBeNull();
    expect(build(envelope({}, [eventItem(errorEvent(), false)]))).not.toBeNull();
  });

  it.each([
    ["an empty body", Buffer.alloc(0)],
    ["a non-JSON envelope header", Buffer.from("not json\n")],
    ["an array envelope header", Buffer.from("[]\n")],
    ["a null envelope header", Buffer.from("null\n")],
    ["a non-JSON item header", Buffer.from("{}\n{oops\n{}\n")],
    ["an item header without a type", Buffer.from('{}\n{"length":2}\n{}\n')],
    ["a negative length", Buffer.from('{}\n{"type":"event","length":-1}\n{}\n')],
    ["a fractional length", Buffer.from('{}\n{"type":"event","length":1.5}\n{}\n')],
    ["a length past the end", Buffer.from('{}\n{"type":"event","length":999}\n{}\n')],
    ["a non-JSON event payload", Buffer.from('{}\n{"type":"event"}\n{not json\n')],
    ["an array event payload", Buffer.from('{}\n{"type":"event"}\n[1]\n')],
  ])("rejects %s as malformed", (_name, body) => {
    expect(() => build(body)).toThrow(EnvelopeMalformedError);
  });

  it("rejects more than MAX_ENVELOPE_ITEMS items", () => {
    const items = Array.from({ length: MAX_ENVELOPE_ITEMS + 1 }, () => ({
      header: { type: "client_report" },
      payload: "{}",
    }));
    expect(() => build(envelope({}, items))).toThrow(EnvelopeMalformedError);
  });

  it("never quotes the input in the error message", () => {
    const secret = "owner@example.com eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
    try {
      build(Buffer.from(`{"a":"${secret}"\n`));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeMalformedError);
      expect((err as Error).message).not.toContain("owner@example.com");
      expect((err as Error).message).not.toContain("eyJ");
    }
  });
});
