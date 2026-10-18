/**
 * audit.query.schema.spec.ts — T234.
 *
 * Pins the contract-shaped query Zod schema for `GET /api/v1/audit/events`.
 *
 * Behaviours pinned:
 *   - `limit` defaults to 50 when omitted; accepts 1 and 200; rejects 0
 *     and 201 (and non-integer); MUST NOT silently clamp.
 *   - `actor_user_id`, `store_id` reject non-UUID values.
 *   - `from`, `to` reject non-ISO-8601 date-time strings.
 *   - `cursor` rejects non-base64 / structurally invalid input.
 *   - `action` accepts arbitrary non-empty string (prefix match — no regex).
 *   - `kind` accepts `read` / `change` and rejects anything else (RT-567).
 *   - All filter fields are optional.
 */
import {
  AuditQuerySchema,
  encodeCursor,
  decodeCursor,
} from "../../src/audit/audit.query.schema";

describe("AuditQuerySchema", () => {
  describe("limit", () => {
    it("defaults to 50 when omitted", () => {
      const parsed = AuditQuerySchema.parse({});
      expect(parsed.limit).toBe(50);
    });

    it("accepts the lower bound of 1", () => {
      const parsed = AuditQuerySchema.parse({ limit: "1" });
      expect(parsed.limit).toBe(1);
    });

    it("accepts the upper bound of 200", () => {
      const parsed = AuditQuerySchema.parse({ limit: "200" });
      expect(parsed.limit).toBe(200);
    });

    it("rejects 0 (does not silently clamp)", () => {
      expect(() => AuditQuerySchema.parse({ limit: "0" })).toThrow();
    });

    it("rejects 201 (does not silently clamp)", () => {
      expect(() => AuditQuerySchema.parse({ limit: "201" })).toThrow();
    });

    it("rejects negative values", () => {
      expect(() => AuditQuerySchema.parse({ limit: "-1" })).toThrow();
    });

    it("rejects non-numeric strings", () => {
      expect(() => AuditQuerySchema.parse({ limit: "abc" })).toThrow();
    });

    it("rejects non-integer numerics", () => {
      expect(() => AuditQuerySchema.parse({ limit: "10.5" })).toThrow();
    });
  });

  describe("UUID filters", () => {
    it("accepts a valid UUID for actor_user_id", () => {
      const parsed = AuditQuerySchema.parse({
        actor_user_id: "0a000000-0000-7000-8000-00000000aa01",
      });
      expect(parsed.actor_user_id).toBe(
        "0a000000-0000-7000-8000-00000000aa01",
      );
    });

    it("rejects malformed actor_user_id", () => {
      expect(() =>
        AuditQuerySchema.parse({ actor_user_id: "not-a-uuid" }),
      ).toThrow();
    });

    it("accepts a valid UUID for store_id", () => {
      const parsed = AuditQuerySchema.parse({
        store_id: "0b000000-0000-7000-8000-0000000000b1",
      });
      expect(parsed.store_id).toBe("0b000000-0000-7000-8000-0000000000b1");
    });

    it("rejects malformed store_id", () => {
      expect(() => AuditQuerySchema.parse({ store_id: "abc" })).toThrow();
    });
  });

  describe("from / to date-times", () => {
    it("accepts ISO 8601 with Z", () => {
      const parsed = AuditQuerySchema.parse({
        from: "2026-01-01T00:00:00Z",
        to: "2026-12-31T23:59:59Z",
      });
      expect(parsed.from).toBeInstanceOf(Date);
      expect(parsed.to).toBeInstanceOf(Date);
    });

    it("accepts ISO 8601 with +00:00 offset", () => {
      const parsed = AuditQuerySchema.parse({
        from: "2026-05-01T12:34:56+00:00",
      });
      expect(parsed.from).toBeInstanceOf(Date);
    });

    it("rejects malformed from", () => {
      expect(() =>
        AuditQuerySchema.parse({ from: "not a date" }),
      ).toThrow();
    });

    it("rejects malformed to", () => {
      expect(() => AuditQuerySchema.parse({ to: "yesterday" })).toThrow();
    });
  });

  describe("action", () => {
    it("accepts a prefix-shaped string", () => {
      const parsed = AuditQuerySchema.parse({ action: "auth." });
      expect(parsed.action).toBe("auth.");
    });

    it("accepts a full action code", () => {
      const parsed = AuditQuerySchema.parse({
        action: "context.switch.tenant",
      });
      expect(parsed.action).toBe("context.switch.tenant");
    });

    it("rejects empty string", () => {
      expect(() => AuditQuerySchema.parse({ action: "" })).toThrow();
    });
  });

  describe("kind (RT-567)", () => {
    it.each(["read", "change"])("accepts %s", (kind) => {
      expect(AuditQuerySchema.parse({ kind }).kind).toBe(kind);
    });

    it("is optional", () => {
      expect(AuditQuerySchema.parse({}).kind).toBeUndefined();
    });

    it.each(["bogus", "", "READ", "reads"])("rejects %j", (kind) => {
      expect(AuditQuerySchema.safeParse({ kind }).success).toBe(false);
    });
  });

  describe("cursor", () => {
    it("accepts a valid encoded cursor and decodes to (occurred_at, id)", () => {
      const occurredAt = new Date("2026-05-01T12:00:00Z");
      const id = "0c000000-0000-7000-8000-0000000000c1";
      const encoded = encodeCursor(occurredAt, id);
      const parsed = AuditQuerySchema.parse({ cursor: encoded });
      expect(parsed.cursor).toEqual({
        occurredAt,
        id,
      });
    });

    it("rejects a non-base64 string", () => {
      // Contains characters outside the base64url alphabet AND can't decode
      // to a structured payload.
      expect(() =>
        AuditQuerySchema.parse({ cursor: "!!!not-base64!!!" }),
      ).toThrow();
    });

    it("rejects a base64-encoded string with malformed payload", () => {
      const malformed = Buffer.from("not-a-cursor", "utf8").toString(
        "base64url",
      );
      expect(() => AuditQuerySchema.parse({ cursor: malformed })).toThrow();
    });

    it("rejects a base64 cursor with non-UUID id segment", () => {
      // Construct a cursor manually that has a valid date but invalid uuid.
      const payload = `2026-05-01T12:00:00.000Z|not-a-uuid`;
      const malformed = Buffer.from(payload, "utf8").toString("base64url");
      expect(() => AuditQuerySchema.parse({ cursor: malformed })).toThrow();
    });

    it("rejects a base64 cursor with invalid date segment", () => {
      const payload = `not-a-date|0c000000-0000-7000-8000-0000000000c1`;
      const malformed = Buffer.from(payload, "utf8").toString("base64url");
      expect(() => AuditQuerySchema.parse({ cursor: malformed })).toThrow();
    });
  });

  describe("encodeCursor / decodeCursor round-trip", () => {
    it("round-trips an arbitrary (Date, uuid) pair", () => {
      const occurredAt = new Date("2026-04-15T08:30:45.123Z");
      const id = "0d000000-0000-7000-8000-0000000000d1";
      const decoded = decodeCursor(encodeCursor(occurredAt, id));
      expect(decoded).toEqual({ occurredAt, id });
    });
  });

  describe("all-fields-optional", () => {
    it("accepts an empty object", () => {
      const parsed = AuditQuerySchema.parse({});
      expect(parsed).toEqual({ limit: 50 });
    });
  });

  describe("limit — numeric form", () => {
    it("accepts limit as a JS number (not just string)", () => {
      // Covers the `typeof value === "number"` branch in limitField transform.
      const parsed = AuditQuerySchema.parse({ limit: 10 });
      expect(parsed.limit).toBe(10);
    });
  });

  describe("cursor — empty decoded payload", () => {
    it("rejects a base64url string that decodes to empty bytes", () => {
      // "A" in base64url decodes to 0 bytes (incomplete group), so
      // Buffer.from("A","base64url").toString("utf8") === "".
      // This triggers the `if (decoded.length === 0)` branch in decodeCursor.
      expect(() => AuditQuerySchema.parse({ cursor: "A" })).toThrow();
    });
  });
});
