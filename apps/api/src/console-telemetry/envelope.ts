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
 *
 * Errors carry a fixed message: `JSON.parse` messages quote the input, so
 * they are never passed on or logged.
 */
import { scrubSentryEvent, type SentryEventLike } from "@data-pulse-2/shared";

/** Upper bound on items in one envelope; a browser error envelope has a handful. */
export const MAX_ENVELOPE_ITEMS = 50;

/** Longest `event_id` / `sent_at` header value kept (a UUID or ISO timestamp is far shorter). */
const MAX_HEADER_VALUE_LENGTH = 64;
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

function parseObject(bytes: Buffer): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new EnvelopeMalformedError();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeMalformedError();
  }
  return value as JsonObject;
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
    const { type, length } = header;
    if (typeof type !== "string" || type.length === 0) throw new EnvelopeMalformedError();
    if (length === undefined || length === null) return { type, payload: this.line() };
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
      throw new EnvelopeMalformedError();
    }
    return { type, payload: this.bytes(length) };
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
 * nothing survives (no error event, or the scrubber dropped it). Throws
 * {@link EnvelopeMalformedError} on a malformed envelope.
 */
export function buildForwardEnvelope(body: Buffer): Buffer | null {
  const { header, items } = parseEnvelope(body);
  const eventItem = items.find((item) => item.type === "event");
  if (eventItem === undefined) return null;

  const scrubbed = scrubSentryEvent(parseObject(eventItem.payload) as SentryEventLike);
  if (scrubbed === null) return null;

  const payload = Buffer.from(JSON.stringify(scrubbed), "utf8");
  return Buffer.concat([
    Buffer.from(`${JSON.stringify(rebuildHeader(header, scrubbed))}\n`, "utf8"),
    Buffer.from(`${JSON.stringify({ type: "event", length: payload.length })}\n`, "utf8"),
    payload,
    Buffer.from("\n", "utf8"),
  ]);
}
