/**
 * Sentry envelope parse / rebuild for the Console tunnel (RT-632, OBS-3).
 *
 * An envelope is newline-delimited: an envelope header line, then items,
 * each an item header line and a payload. A payload whose item header has a
 * `length` is exactly that many BYTES (it may contain newlines or binary);
 * otherwise it runs to the next newline. Everything here works on a Buffer
 * so a multibyte payload is cut by bytes, not characters.
 *
 * The rebuilt envelope keeps only the first error `event` item, scrubbed by
 * the shared allowlist scrubber (OBS-1 §3), under a header rebuilt from
 * `event_id` and `sent_at` only. The inbound `dsn`, `sdk` and `trace` header
 * fields never leave, so the destination comes from server config alone.
 * The server then stamps the event's `environment` and rebuilds its `sdk`
 * with `settings.infer_ip = "never"`, so Sentry never infers an IP address
 * (the scrubber already dropped `user` and `request`). Tags are cut to the
 * OBS-1 §1/§2 key set here too, so a Console tag such as `user_id` or `ip`
 * never leaves even where the shared scrubber only drops redacted keys.
 *
 * The event's identity is the server's, not the browser's (RT-683, OBS-9
 * F-C): `server_name` is dropped, the `service` tag is stamped
 * `admin-console`, and `release` and the `version` tag survive only as a
 * SHA12. OBS-1 §1 makes them the same value, so both are dropped when they
 * disagree.
 *
 * Errors carry a fixed message: `JSON.parse` messages quote the input, so
 * they are never passed on or logged.
 */
import { scrubSentryEvent, type SentryEventLike } from "@data-pulse-2/shared";

/** Upper bound on items in one envelope; a browser error envelope has a handful. */
export const MAX_ENVELOPE_ITEMS = 50;

/** Longest `event_id` / `sent_at` header value kept (a UUID or ISO timestamp is far shorter). */
const MAX_HEADER_VALUE_LENGTH = 64;
/** An SDK name or version kept from the Console: a short plain token (anchored, linear). */
const SDK_TOKEN = /^[\w.-]{1,64}$/;
const DEFAULT_SDK = { name: "backend-core.console-tunnel", version: "1.0.0" } as const;
/** OBS-1 §1 contract and bounded tags, plus the §2 `request_id`. */
const ALLOWED_TAG_KEYS: ReadonlySet<string> = new Set([
  "env",
  "service",
  "version",
  "route",
  "method",
  "status",
  "status_class",
  "error_class",
  "outcome",
  "request_id",
]);
const MAX_TAG_VALUE_LENGTH = 200;
/** The OBS-1 §1 `service` for every tunnelled event. */
const CONSOLE_SERVICE = "admin-console";
/** OBS-1 §1 release SHA12: exactly 12 lowercase hex chars (no 40-char SHA). */
const SHA12 = /^[0-9a-f]{12}$/;
const NEWLINE = 0x0a;

export class EnvelopeMalformedError extends Error {
  constructor() {
    super("Request body is not a valid envelope.");
    this.name = "EnvelopeMalformedError";
  }
}

interface EnvelopeItem {
  readonly type: string;
  readonly payload: Buffer;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(bytes: Buffer): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new EnvelopeMalformedError();
  }
  if (!isJsonObject(value)) throw new EnvelopeMalformedError();
  return value;
}

/** The item `type`: a non-empty string. */
function itemType(header: JsonObject): string {
  const type = header["type"];
  if (typeof type !== "string" || type.length === 0) throw new EnvelopeMalformedError();
  return type;
}

/** The item `length` in bytes, or `undefined` for a newline-delimited payload. */
function itemLength(header: JsonObject): number | undefined {
  const length = header["length"];
  if (length === undefined || length === null) return undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0) throw new EnvelopeMalformedError();
  return length as number;
}

/** Reads one envelope at a time; `pos` only moves forward. */
class EnvelopeReader {
  private pos = 0;

  constructor(private readonly body: Buffer) {}

  atEnd(): boolean {
    return this.pos >= this.body.length;
  }

  /** Bytes up to the next newline (or the end); consumes the newline. */
  line(): Buffer {
    const nl = this.body.indexOf(NEWLINE, this.pos);
    const end = nl === -1 ? this.body.length : nl;
    const out = this.body.subarray(this.pos, end);
    this.pos = nl === -1 ? end : nl + 1;
    return out;
  }

  /** Exactly `length` bytes, then an optional newline. */
  bytes(length: number): Buffer {
    if (this.pos + length > this.body.length) throw new EnvelopeMalformedError();
    const out = this.body.subarray(this.pos, this.pos + length);
    this.pos += length;
    if (this.body[this.pos] === NEWLINE) this.pos += 1;
    return out;
  }

  item(): EnvelopeItem {
    const header = parseObject(this.line());
    const type = itemType(header);
    const length = itemLength(header);
    return { type, payload: length === undefined ? this.line() : this.bytes(length) };
  }
}

function parseEnvelope(body: Buffer): { header: JsonObject; items: EnvelopeItem[] } {
  if (body.length === 0) throw new EnvelopeMalformedError();
  const reader = new EnvelopeReader(body);
  const header = parseObject(reader.line());
  const items: EnvelopeItem[] = [];
  while (!reader.atEnd()) {
    if (items.length === MAX_ENVELOPE_ITEMS) throw new EnvelopeMalformedError();
    items.push(reader.item());
  }
  return { header, items };
}

function shortString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_HEADER_VALUE_LENGTH ? value : undefined;
}

function isSdkToken(value: unknown): value is string {
  return typeof value === "string" && SDK_TOKEN.test(value);
}

/** `{ name, version, settings: { infer_ip: "never" } }`; anything else the SDK sent is dropped. */
function rebuildSdk(inbound: unknown): JsonObject {
  const sdk = isJsonObject(inbound) ? inbound : {};
  const keep = isSdkToken(sdk["name"]) && isSdkToken(sdk["version"]);
  return {
    name: keep ? sdk["name"] : DEFAULT_SDK.name,
    version: keep ? sdk["version"] : DEFAULT_SDK.version,
    settings: { infer_ip: "never" },
  };
}

function allowedTags(tags: SentryEventLike["tags"]): Record<string, unknown> {
  const kept = Object.entries(tags ?? {}).filter(
    ([key, value]) =>
      ALLOWED_TAG_KEYS.has(key) && typeof value === "string" && value.length <= MAX_TAG_VALUE_LENGTH,
  );
  return Object.fromEntries(kept);
}

function sha12(value: unknown): string | undefined {
  return typeof value === "string" && SHA12.test(value) ? value : undefined;
}

/** `release` and `version` as SHA12s; both dropped when they disagree. */
function releaseAndVersion(release: unknown, version: unknown): { release?: string; version?: string } {
  const r = sha12(release);
  const v = sha12(version);
  const disagree = r !== undefined && v !== undefined && r !== v;
  if (disagree) return {};
  return { ...(r === undefined ? {} : { release: r }), ...(v === undefined ? {} : { version: v }) };
}

/** Drops `server_name` and stamps the server-owned `service`, `release` and `version`. */
function stampIdentity(scrubbed: SentryEventLike): JsonObject {
  const { tags, release, server_name: _serverName, ...rest } = scrubbed;
  const { version, service: _service, ...otherTags } = allowedTags(tags);
  const stamped = releaseAndVersion(release, version);
  return {
    ...rest,
    ...(stamped.release === undefined ? {} : { release: stamped.release }),
    tags: {
      ...otherTags,
      service: CONSOLE_SERVICE,
      ...(stamped.version === undefined ? {} : { version: stamped.version }),
    },
  };
}

function rebuildHeader(inbound: JsonObject, event: SentryEventLike): JsonObject {
  const out: JsonObject = {};
  const eventId = shortString(event.event_id);
  const sentAt = shortString(inbound["sent_at"]);
  if (eventId !== undefined) out["event_id"] = eventId;
  if (sentAt !== undefined) out["sent_at"] = sentAt;
  return out;
}

/**
 * Parses an inbound envelope and returns the one to forward, or `null` when
 * nothing survives (no error event, or the scrubber dropped it). `environment`
 * is the server's Sentry environment, stamped over the Console's. Throws
 * {@link EnvelopeMalformedError} on a malformed envelope.
 */
export function buildForwardEnvelope(body: Buffer, environment: string): Buffer | null {
  const { header, items } = parseEnvelope(body);
  const eventItem = items.find((item) => item.type === "event");
  if (eventItem === undefined) return null;

  const inbound = parseObject(eventItem.payload);
  const scrubbed = scrubSentryEvent(inbound as SentryEventLike);
  if (scrubbed === null) return null;

  const event = { ...stampIdentity(scrubbed), environment, sdk: rebuildSdk(inbound["sdk"]) };
  const payload = Buffer.from(JSON.stringify(event), "utf8");
  return Buffer.concat([
    Buffer.from(`${JSON.stringify(rebuildHeader(header, scrubbed))}\n`, "utf8"),
    Buffer.from(`${JSON.stringify({ type: "event", length: payload.length })}\n`, "utf8"),
    payload,
    Buffer.from("\n", "utf8"),
  ]);
}
