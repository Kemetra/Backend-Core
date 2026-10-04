/**
 * audit.query.schema.ts — Zod schema + cursor codec for
 * `GET /api/v1/audit/events` (T235, OpenAPI listAuditEvents).
 *
 * Limit semantics
 * ---------------
 * `limit` defaults to 50, accepts 1..200, rejects out-of-range with a
 * ZodError (which `GlobalExceptionFilter` renders as a 400
 * `validation_error` envelope). The schema MUST NOT silently clamp —
 * silent clamps mask client bugs and make pagination math diverge between
 * caller and server.
 *
 * Cursor codec
 * ------------
 * The cursor is the base64url encoding of `<occurredAtIso>|<uuid>`,
 * unsigned. RLS plus the explicit `WHERE tenant_id = ctx.tenantId`
 * predicate in the repository make the cursor inherently tenant-safe:
 * a cursor decoded from tenant A's row produces no rows when used by
 * tenant B because B's view filters them out. HMAC signing is
 * deliberately not applied in this slice — a future hardening pass can
 * add it without changing the wire format.
 *
 * Why decode inside `.transform()` (not in the controller)
 * -------------------------------------------------------
 * Decoding here means a malformed cursor surfaces as the same 400
 * `validation_error` envelope as any other bad query parameter — the
 * controller never sees an opaque string. The decode result is a typed
 * `{ occurredAt: Date, id: string }` which the service forwards to the
 * repository unchanged.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parsed cursor payload — never serialized as-is on the wire.
 * Internal contract between the schema, service, and repository.
 */
export interface AuditCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/**
 * Encode `(occurredAt, id)` to an opaque base64url string. Uses the
 * full ISO with milliseconds so the round-trip is exact at the Date
 * resolution `node-pg` exposes (timestamptz from PG comes back as a
 * ms-truncated `Date`). The cursor's timestamp is therefore the row's
 * `occurred_at` FLOORED to the millisecond; the repository restores the
 * sub-ms digits by anchoring on the cursor row's id (RT-211), so this wire
 * format is unchanged.
 */
export function encodeCursor(occurredAt: Date, id: string): string {
  const payload = `${occurredAt.toISOString()}|${id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decode an opaque base64url cursor string back to `(occurredAt, id)`.
 * Throws on any malformed shape so the Zod transform can surface it as
 * a `validation_error` 400.
 */
export function decodeCursor(raw: string): AuditCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new Error("cursor: not base64url");
  }
  if (decoded.length === 0) {
    throw new Error("cursor: empty payload");
  }
  const sep = decoded.indexOf("|");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new Error("cursor: missing separator");
  }
  const isoPart = decoded.slice(0, sep);
  const idPart = decoded.slice(sep + 1);
  const occurredAt = new Date(isoPart);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error("cursor: invalid occurred_at");
  }
  if (!UUID_RE.test(idPart)) {
    throw new Error("cursor: invalid id");
  }
  return { occurredAt, id: idPart };
}

const dateTimeString = z
  .string()
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "must be a valid ISO 8601 date-time",
  )
  .transform((value) => new Date(value));

/**
 * Limit parser: accepts `string | number | undefined`, defaults to 50,
 * rejects floats / non-numeric / out-of-range with a custom issue (so
 * the global filter renders a 400 envelope, not a Zod-internal coercion
 * message). Strict integer parsing — `"10.5"`, `"3e2"`, `"abc"` all fail.
 */
const limitField = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return 50;
    let n: number;
    if (typeof value === "number") {
      n = value;
    } else {
      if (!/^-?\d+$/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "limit must be an integer",
        });
        return z.NEVER;
      }
      n = Number.parseInt(value, 10);
    }
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "limit must be between 1 and 200",
      });
      return z.NEVER;
    }
    return n;
  });

/**
 * Zod schema for the GET /api/v1/audit/events query string.
 *
 * Output shape (post-transform):
 *   - `action`         optional string (≥1 char) — prefix match.
 *   - `actor_user_id`  optional UUID string.
 *   - `store_id`       optional UUID string.
 *   - `from`           optional Date (parsed from ISO 8601).
 *   - `to`             optional Date (parsed from ISO 8601).
 *   - `cursor`         optional decoded `AuditCursor`.
 *   - `limit`          integer 1..200, default 50.
 *
 * Snake_case keys mirror the OpenAPI contract verbatim; the service
 * maps them to internal `camelCase` when calling the repository.
 */
export const AuditQuerySchema = z
  .object({
    action: z.string().min(1).optional(),
    actor_user_id: z
      .string()
      .regex(UUID_RE, "must be a UUID")
      .optional(),
    store_id: z.string().regex(UUID_RE, "must be a UUID").optional(),
    from: dateTimeString.optional(),
    to: dateTimeString.optional(),
    cursor: z
      .string()
      .min(1)
      .transform((raw, ctx) => {
        try {
          return decodeCursor(raw);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              err instanceof Error ? err.message : "cursor: malformed",
          });
          return z.NEVER;
        }
      })
      .optional(),
    limit: limitField,
  })
  .strict();

export type AuditQueryInput = z.input<typeof AuditQuerySchema>;
export type AuditQueryParsed = z.output<typeof AuditQuerySchema>;
