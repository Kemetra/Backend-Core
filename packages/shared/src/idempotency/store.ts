/**
 * IdempotencyKeyStore — application-layer helper for idempotency.
 *
 * Strategy: Redis-primary, Postgres-mirror.
 *   - findOrCreate: check Redis first, fall back to the Postgres mirror reader
 *     on a miss. On the very first call (no prior result), returns null.
 *   - save: write the result to Redis (with TTL) AND call the Postgres mirror
 *     writer for durable storage.
 *
 * All dependencies are injected as minimal port interfaces so the store is
 * usable in unit tests without Docker, Redis, or a live database.
 *
 * Schema column mapping (packages/db/src/schema/idempotency_keys.ts):
 *   tenant_id, store_id, client_id, key, request_hash, response_status,
 *   response_body, expires_at
 */

export interface StoredResult {
  status: number;
  body: unknown;
}

export interface IdempotencyEntry {
  fingerprint: Buffer;
  result: StoredResult;
  expiresAt: Date;
}

/** Minimal Redis-like port — only the operations we need. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { px: number }): Promise<unknown>;
}

/** Write a new idempotency record to the Postgres mirror. */
export interface PgMirrorWriter {
  insert(row: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
    fingerprint: Buffer;
    result: StoredResult;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Insert the in-flight claim before the handler runs.
   * Throws {@link IdempotencyMirrorConflict} when the unique key is taken.
   * Optional so older test doubles keep working; a missing claim means
   * Redis is still the only backstop.
   */
  claim?(row: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
    fingerprint: Buffer;
    expiresAt: Date;
  }): Promise<void>;
  /** Drop an in-flight claim so a failed handler can be retried. */
  release?(row: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
  }): Promise<void>;
}

/** Read an existing idempotency record from the Postgres mirror. */
export interface PgMirrorReader {
  find(params: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
  }): Promise<IdempotencyEntry | null>;
}

/** In-flight placeholder. Not a replayable HTTP response. */
export function isIdempotencyClaim(result: StoredResult): boolean {
  if (result.status !== 0) return false;
  const body = result.body;
  if (body === null || typeof body !== "object") return false;
  return (body as { __dp2IdempotencyClaim?: unknown }).__dp2IdempotencyClaim === true;
}

/** Raised when a claim insert loses the unique (tenant, store, client, key) race. */
export class IdempotencyMirrorConflict extends Error {
  constructor() {
    super("idempotency key already claimed");
    this.name = "IdempotencyMirrorConflict";
  }
}

export type FindOrCreateResult =
  | { hit: true; entry: IdempotencyEntry }
  | { hit: false; entry: null }
  | { hit: "collision" }
  | { hit: "in_progress" };

export interface IdempotencyKeyStoreOptions {
  redis: RedisLike;
  pgWriter: PgMirrorWriter;
  pgReader: PgMirrorReader;
  /** Defaults to () => new Date(). Inject in tests to control time. */
  clock?: () => Date;
  /** Default TTL for new entries in milliseconds. Default: 24h. */
  defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function redisKey(
  tenantId: string,
  storeId: string | null,
  clientId: string,
  key: string,
): string {
  // Use literal string "null" for storeId=null so key segments are stable
  const store = storeId ?? "null";
  return `idempotency:${tenantId}:${store}:${clientId}:${key}`;
}

function serialize(entry: IdempotencyEntry): string {
  return JSON.stringify({
    fingerprint: entry.fingerprint.toString("hex"),
    status: entry.result.status,
    body: entry.result.body,
    expiresAt: entry.expiresAt.toISOString(),
  });
}

function deserialize(raw: string): IdempotencyEntry {
  const parsed = JSON.parse(raw) as {
    fingerprint: string;
    status: number;
    body: unknown;
    expiresAt: string;
  };
  return {
    fingerprint: Buffer.from(parsed.fingerprint, "hex"),
    result: { status: parsed.status, body: parsed.body },
    expiresAt: new Date(parsed.expiresAt),
  };
}

export class IdempotencyKeyStore {
  private readonly redis: RedisLike;
  private readonly pgWriter: PgMirrorWriter;
  private readonly pgReader: PgMirrorReader;
  private readonly clock: () => Date;
  private readonly defaultTtlMs: number;

  constructor(options: IdempotencyKeyStoreOptions) {
    this.redis = options.redis;
    this.pgWriter = options.pgWriter;
    this.pgReader = options.pgReader;
    this.clock = options.clock ?? (() => new Date());
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Check whether a prior result exists for this scope + key.
   *
   * Returns:
   *   { hit: true, entry }  — found, fingerprint matches → return cached result
   *   { hit: "collision" }  — found, fingerprint DIFFERENT → treat as collision
   *   { hit: false, entry: null } — not found (first call)
   *
   * Lookup order: Redis first → Postgres mirror fallback.
   * Expired entries are treated as not found.
   */
  async findOrCreate(
    tenantId: string,
    storeId: string | null,
    clientId: string,
    key: string,
    fingerprint: Buffer,
  ): Promise<FindOrCreateResult> {
    const now = this.clock();
    const rkey = redisKey(tenantId, storeId, clientId, key);

    const raw = await this.redis.get(rkey);
    if (raw !== null) {
      const entry = deserialize(raw);
      if (entry.expiresAt <= now) {
        return { hit: false, entry: null };
      }
      if (!entry.fingerprint.equals(fingerprint)) {
        return { hit: "collision" };
      }
      return { hit: true, entry };
    }

    // Redis miss — fall back to Postgres mirror
    const pgEntry = await this.pgReader.find({
      tenantId,
      storeId,
      clientId,
      key,
    });
    if (pgEntry === null) {
      return { hit: false, entry: null };
    }
    if (pgEntry.expiresAt <= now) {
      return { hit: false, entry: null };
    }
    if (!pgEntry.fingerprint.equals(fingerprint)) {
      return { hit: "collision" };
    }
    if (isIdempotencyClaim(pgEntry.result)) {
      return { hit: "in_progress" };
    }
    return { hit: true, entry: pgEntry };
  }

  /**
   * Reserve the key in Postgres before the handler runs.
   * `unsupported` means this store has no claim writer (Redis only).
   */
  async claim(input: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
    fingerprint: Buffer;
    expiresAt: Date;
  }): Promise<"inserted" | "conflict" | "unsupported"> {
    if (!this.pgWriter.claim || !isUuid(input.tenantId)) return "unsupported";
    try {
      await this.pgWriter.claim(input);
      return "inserted";
    } catch (err) {
      if (err instanceof IdempotencyMirrorConflict) return "conflict";
      throw err;
    }
  }

  async releaseClaim(input: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
  }): Promise<void> {
    if (!this.pgWriter.release || !isUuid(input.tenantId)) return;
    await this.pgWriter.release(input);
  }

  /**
   * Persist a result after successfully handling a request.
   *
   * Writes to Redis (with TTL) and to the Postgres mirror.
   * `expiresAt` defaults to now + defaultTtlMs if not provided.
   */
  async save(
    tenantId: string,
    storeId: string | null,
    clientId: string,
    key: string,
    fingerprint: Buffer,
    result: StoredResult,
    expiresAt?: Date,
  ): Promise<void> {
    const now = this.clock();
    const resolvedExpiry = expiresAt ?? new Date(now.getTime() + this.defaultTtlMs);
    const ttlMs = resolvedExpiry.getTime() - now.getTime();

    const entry: IdempotencyEntry = {
      fingerprint,
      result,
      expiresAt: resolvedExpiry,
    };

    await this.pgWriter.insert({
      tenantId,
      storeId,
      clientId,
      key,
      fingerprint,
      result,
      expiresAt: resolvedExpiry,
    });

    const rkey = redisKey(tenantId, storeId, clientId, key);
    await this.redis.set(rkey, serialize(entry), { px: Math.max(ttlMs, 1) });
  }
}
